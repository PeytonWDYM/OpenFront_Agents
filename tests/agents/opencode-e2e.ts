// Failure cases: unparsable model prose accepted, invalid action JSON passing
// validation, missing sessions, duplicate players, unknown threads, missing
// binaries, rejected settings modes, transient throttles never retried,
// unbounded session growth, and lost think/act callbacks.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSkippableTurnError } from "../../src/agents/Arena";
import { ArenaSettingsSchema } from "../../src/agents/Settings";
import {
  DEFAULT_MODEL,
  DEFAULT_VARIANT,
} from "../../src/agents/opencode/config";
import {
  OPENCODE_TURN_TIMEOUT_MS,
  OpenCodeRuntime,
} from "../../src/agents/opencode/index";
import {
  extractActionJson,
  isTransientRunError,
  messageText,
  parseActionOutput,
} from "../../src/agents/opencode/output";

assert.deepEqual(extractActionJson("no json here"), undefined);
assert.deepEqual(
  extractActionJson(
    '```json\n{"intent":{"type":"attack","targetID":null,"troops":10}}\n```',
  ),
  { intent: { type: "attack", targetID: null, troops: 10 } },
);
assert.deepEqual(
  extractActionJson('Plan done {"nextDecisionSeconds":5} trailing'),
  { nextDecisionSeconds: 5 },
);
const missing = parseActionOutput("Just thinking out loud, no actions.");
assert.ok("error" in missing);
const badContract = parseActionOutput('{"intent":{"type":"attack"}}');
assert.ok("error" in badContract);
const valid = parseActionOutput(
  'Attack now ```json\n{"note":"Expand","intent":{"type":"attack","targetID":null,"troops":100}}\n```',
);
assert.ok(!("error" in valid) && valid.note === "Expand");
assert.ok(!("error" in valid) && valid.action?.intent?.type === "attack");
const batch = parseActionOutput(
  '{"intents":[{"type":"attack","targetID":null,"troops":50}],"attackRatio":0.25}',
);
assert.ok(!("error" in batch) && batch.action?.attackRatio === 0.25);
const idle = parseActionOutput('{"note":"Hold position"}');
assert.ok(
  !("error" in idle) &&
    idle.note === "Hold position" &&
    idle.action === undefined,
);
assert.equal(
  messageText([{ type: "text", text: "hi" }, { type: "other" }]),
  "hi",
);
assert.equal(messageText("not parts"), "");
assert.equal(messageText([{ type: "text", text: 42 }]), "");

assert.equal(ArenaSettingsSchema.parse({ mode: "opencode" }).mode, "opencode");
assert.equal(ArenaSettingsSchema.parse({}).mode, "codex");
assert.throws(() => ArenaSettingsSchema.parse({ mode: "bogus" }));
// The default pins the free model slug exactly as `opencode models` lists it.
assert.equal(DEFAULT_MODEL, "opencode/muse-spark-1.3-contributor-free");
assert.equal(DEFAULT_VARIANT, "low");
assert.equal(OPENCODE_TURN_TIMEOUT_MS, 240_000);
assert.equal(isTransientRunError("Error 429: rate limited, try again"), true);
assert.equal(isTransientRunError("provider overloaded, retry later"), true);
assert.equal(isTransientRunError("Error: File not found: prompt text"), false);
assert.equal(isTransientRunError("OpenCode turn exceeded its ceiling"), false);
assert.equal(
  isSkippableTurnError("OpenCode run failed (exit null): ", "opencode"),
  true,
);
assert.equal(
  isSkippableTurnError(
    "OpenCode turn exceeded its four-minute ceiling.",
    "opencode",
  ),
  true,
);
assert.equal(
  isSkippableTurnError("This operation was aborted", "opencode"),
  true,
);
assert.equal(
  isSkippableTurnError("OpenCode run failed (exit 1): bad args", "opencode"),
  false,
);
assert.equal(
  isSkippableTurnError("OpenCode run failed (exit null): ", "codex"),
  false,
);

// Fake serve: one persistent HTTP child speaking the v1 session endpoints.
// It fails the first message with a transient throttle, then answers canned
// turns with incrementing session ids for rotation checks.
const directory = await mkdtemp(join(tmpdir(), "openfront-opencode-fake-"));
const fake = join(directory, "fake-opencode-serve.mjs");
await writeFile(
  fake,
  `import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
let sessions = 0;
const fail = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    if (request.method === "GET" && request.url === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "fake-serve-1.0" }));
      return;
    }
    if (request.method === "POST" && request.url === "/session") {
      sessions++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: \`sess-fake-\${sessions}\` }));
      return;
    }
    const message = request.url.match(/^\\/session\\/([^/]+)\\/message$/);
    if (request.method === "POST" && message) {
      const parsed = JSON.parse(body);
      if (parsed.variant !== "low" || typeof parsed.system !== "string" || parsed.parts?.[0]?.type !== "text") {
        fail(response, 400, { message: "unexpected message contract" });
        return;
      }
      const marker = join(tmpdir(), "openfront-opencode-fake-once");
      if (!existsSync(marker)) {
        writeFileSync(marker, "throttled");
        fail(response, 429, { message: "rate limited, try again shortly" });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          info: { id: "msg-fake" },
          parts: [{ type: "text", text: '{"note":"Attack now","intent":{"type":"attack","targetID":null,"troops":100}}' }],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url.endsWith("/abort")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("true");
      return;
    }
    fail(response, 404, { message: "unknown fake route" });
  });
});
server.listen(port);
`,
);
await rm(join(tmpdir(), "openfront-opencode-fake-once"), { force: true });
process.env.OPENFRONT_OPENCODE_EXECUTABLE = fake;
process.env.OPENFRONT_OPENCODE_MODEL = "test/model";

const runtime = new OpenCodeRuntime();
const status = await runtime.initialize();
assert.equal(status.authenticated, true);
assert.deepEqual(status.models, ["test/model"]);
const calls: { name: string; args: unknown }[] = [];
const seen: Record<string, unknown>[] = [];
const threadId = await runtime.createPlayer(
  {
    id: "agent001",
    prompt: "You are Agent 1, an aggressive OpenFront player.",
    tools: [
      {
        name: "observe_world",
        description: "Observe",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "think",
        description: "Think",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "act",
        description: "Act",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  },
  async (name, args) => {
    calls.push({ name, args });
    return { data: { ok: true } };
  },
  (event) => {
    seen.push(event);
  },
);
await assert.rejects(
  runtime.createPlayer(
    { id: "agent001", prompt: "dup", tools: [] },
    async () => ({ data: {} }),
    () => {},
  ),
  /already has an OpenCode session/,
);
await assert.rejects(runtime.turn("unknown-thread", "{}"), /Unknown OpenCode/);
await runtime.turn(
  threadId,
  JSON.stringify({ offense: { attackableBorders: 3 } }),
);
assert.ok(
  calls.some((call) => call.name === "think"),
  "The JSON note records a think call",
);
const act = calls.find((call) => call.name === "act");
assert.ok(act, "The JSON intent submits an act call");
assert.equal((act.args as { intent: { type: string } }).intent.type, "attack");
assert.ok(
  seen.some((event) => event.type === "retry"),
  "A transient throttle retries instead of failing the turn",
);
const first = (await runtime.history(threadId)) as { sessionId: string };
assert.equal(first.sessionId, "sess-fake-1");
for (let turn = 0; turn < 12; turn++) {
  await runtime.turn(threadId, JSON.stringify({ offense: {} }));
}
const rotated = (await runtime.history(threadId)) as { sessionId: string };
assert.equal(rotated.sessionId, "sess-fake-2");
assert.ok(
  seen.some((event) => event.type === "rotation"),
  "Sessions rotate before context debt accumulates",
);
await runtime.interrupt(threadId);
await runtime.compact(threadId);
await runtime.close();
const manifest = JSON.parse(
  await readFile(join(runtime.artifactDirectory, "runtime.json"), "utf8"),
) as {
  provider: string;
  transport: string;
  serverVersion: string;
  model: string;
  variant: string;
};
assert.equal(manifest.provider, "opencode");
assert.equal(manifest.transport, "serve");
assert.equal(manifest.serverVersion, "fake-serve-1.0");
assert.equal(manifest.model, "test/model");
assert.equal(manifest.variant, "low");

delete process.env.OPENFRONT_OPENCODE_EXECUTABLE;
delete process.env.OPENFRONT_OPENCODE_MODEL;
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/opencode-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      status,
      threadId,
      calls: calls.length,
      manifest,
      eventTypes: seen.map((event) => event.type),
    },
    null,
    2,
  ),
);
console.log("OpenCode E2E passed. Artifact: .agent-arena/opencode-e2e.json");
