// Failure cases: unparsable model prose accepted, invalid action JSON passing
// validation, missing sessions, duplicate players, unknown threads, missing
// binaries, rejected settings modes, and lost think/act callbacks.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaSettingsSchema } from "../../src/agents/Settings";
import { OpenCodeRuntime } from "../../src/agents/opencode/index";
import {
  extractActionJson,
  parseActionOutput,
  parseRunEvents,
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
const events = parseRunEvents(
  [
    JSON.stringify({ type: "session.created", part: { id: "sess-abc" } }),
    JSON.stringify({ type: "message.part", part: { text: "hello" } }),
    "not json at all",
  ].join("\n"),
);
assert.equal(events.sessionId, "sess-abc");
assert.ok(
  events.text.includes("hello") && events.text.includes("not json at all"),
);

assert.equal(ArenaSettingsSchema.parse({ mode: "opencode" }).mode, "opencode");
assert.equal(ArenaSettingsSchema.parse({}).mode, "codex");
assert.throws(() => ArenaSettingsSchema.parse({ mode: "bogus" }));

// Fake opencode binary: answers version/auth probes and one canned turn.
const directory = await mkdtemp(join(tmpdir(), "openfront-opencode-fake-"));
const fake = join(directory, "fake-opencode.mjs");
await writeFile(
  fake,
  `const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("opencode fake 1.0"); process.exit(0); }
if (args[0] === "auth") { console.log("[]"); process.exit(0); }
if (args[0] === "run") {
  console.log(JSON.stringify({ type: "session.created", part: { id: "sess-fake-1" } }));
  console.log(JSON.stringify({ type: "message.part", part: { text: '{"note":"Attack now","intent":{"type":"attack","targetID":null,"troops":100}}' } }));
  process.exit(0);
}
console.error("unexpected fake args: " + args.join(" "));
process.exit(1);
`,
);
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
await runtime.interrupt(threadId);
await runtime.compact(threadId);
const history = await runtime.history(threadId);
assert.equal((history as { sessionId: string }).sessionId, "sess-fake-1");
await runtime.close();
const manifest = JSON.parse(
  await readFile(join(runtime.artifactDirectory, "runtime.json"), "utf8"),
) as {
  provider: string;
  model: string;
};
assert.equal(manifest.provider, "opencode");
assert.equal(manifest.model, "test/model");

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
      calls,
      manifest,
      eventTypes: seen.map((event) => event.type),
    },
    null,
    2,
  ),
);
console.log("OpenCode E2E passed. Artifact: .agent-arena/opencode-e2e.json");
