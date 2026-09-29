// Live proof: the default free model answers through the real binary with
// session continuation. Runs only with AGENT_E2E_OPENCODE=1; otherwise it
// exits quietly so normal suites stay offline.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

if (process.env.AGENT_E2E_OPENCODE !== "1") {
  console.log("OpenCode live E2E skipped. Set AGENT_E2E_OPENCODE=1 for proof.");
  process.exit(0);
}

const { OpenCodeRuntime } = await import("../../src/agents/opencode/index");
const { DEFAULT_MODEL, DEFAULT_VARIANT } =
  await import("../../src/agents/opencode/config");

const runtime = new OpenCodeRuntime();
const status = await runtime.initialize();
assert.equal(status.authenticated, true);
assert.ok(status.models.includes(DEFAULT_MODEL));
const calls: { name: string; args: unknown }[] = [];
const threadId = await runtime.createPlayer(
  {
    id: "agent001",
    prompt: "You are Agent 1, an OpenFront player.",
    tools: [
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
  () => {},
);
// The reply envelope is the only harness-added format; the model picks content.
await runtime.turn(
  threadId,
  JSON.stringify({
    offense: { attackableBorders: 2, affordableMissiles: [] },
    self: { troops: 1000, gold: 5000 },
  }),
);
// A second turn proves session continuation. A real map frame is attached
// when a previous vision run left one behind; synthetic pixels are rejected
// by the provider, so the image leg stays optional.
let frame: string | undefined;
try {
  const { globSync } = await import("node:fs");
  const frames = globSync(".agent-arena/frames/**/*.png").slice(0, 1);
  frame = frames[0] as string | undefined;
} catch {
  frame = undefined;
}
const history = (await runtime.history(threadId)) as { sessionId: string };
assert.ok(history.sessionId.startsWith("ses_"), "A real session continues");
await runtime.turn(
  threadId,
  JSON.stringify({ offense: { attackableBorders: 1 } }),
  frame ? [{ path: frame }] : [],
);
await runtime.close();

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/opencode-live-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      model: DEFAULT_MODEL,
      variant: DEFAULT_VARIANT,
      sessionId: history.sessionId,
      imageAttached: frame ?? null,
      calls,
    },
    null,
    2,
  ),
);
console.log(
  "OpenCode live E2E passed. Artifact: .agent-arena/opencode-live-e2e.json",
);
