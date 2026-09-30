// Failure cases: an excessive medium count passes validation, names misrepresent
// reasoning, a medium turn resets to low, or native metadata omits the actual effort.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexRuntime } from "../../src/agents/codex";
import { getAgentReasoningEffort } from "../../src/agents/Reasoning";
import { ArenaSettingsSchema } from "../../src/agents/Settings";

assert.equal(ArenaSettingsSchema.parse({}).mediumAgentCount, 0);
assert.equal(
  ArenaSettingsSchema.safeParse({ agentCount: 2, mediumAgentCount: 3 }).success,
  false,
);
const settings = ArenaSettingsSchema.parse({
  agentCount: 25,
  mediumAgentCount: 13,
});
const efforts = Array.from({ length: settings.agentCount }, (_, index) =>
  getAgentReasoningEffort(index, settings.mediumAgentCount),
);
assert.equal(efforts.filter((effort) => effort === "medium").length, 13);
assert.equal(efforts.filter((effort) => effort === "low").length, 12);

const runtime = new CodexRuntime();
const evidence: Record<string, unknown> = { efforts };
try {
  await runtime.initialize();
  const players = [];
  for (const effort of ["low", "medium"] as const) {
    const events: Record<string, unknown>[] = [];
    const threadId = await runtime.createPlayer(
      {
        id: `reasoning-e2e-${effort}`,
        reasoningEffort: effort,
        prompt:
          "You are an OpenFront game player. End each turn with the single word ready.",
        tools: [],
      },
      async () => {
        throw new Error("This probe does not use tools.");
      },
      (event) => events.push(event),
    );
    await runtime.turn(threadId, "Reply ready.");
    const history = await runtime.history(threadId);
    assert.equal(history.reasoningEffort, effort);
    const configuration = events.find(
      (event) => event.type === "configuration",
    );
    assert.equal(configuration?.effort, effort);
    const metadata = JSON.parse(
      await readFile(
        join(runtime.artifactDirectory, `${threadId}.json`),
        "utf8",
      ),
    );
    assert.equal(metadata.effort, effort);
    assert.equal(metadata.autoCompactTokenLimit, 60_000);
    players.push({ threadId, effort, configuration, metadata, history });
  }
  Object.assign(evidence, { passed: true, players });
} finally {
  await runtime.close();
  const artifact = join(runtime.artifactDirectory, "reasoning-e2e.json");
  await writeFile(artifact, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ artifact, passed: evidence.passed ?? false }));
}
