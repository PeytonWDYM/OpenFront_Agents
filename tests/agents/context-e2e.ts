import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CodexRuntime } from "../../src/agents/codex";

// Failure cases: ignored native context flags, a lifetime budget mistaken for context,
// per-player reasoning overrides lost, coder instructions restored, or the copied login retained.
// This probe creates isolated low and medium threads without an inference request.
const runtime = new CodexRuntime();
const events: Record<string, unknown>[] = [];
const evidence: Record<string, unknown> = { inferenceRequests: 0 };
try {
  const status = await runtime.initialize();
  assert.equal(status.authenticated, true);
  const isolation = z
    .object({
      contextWindow: z.literal(150_000),
      autoCompactTokenLimit: z.literal(60_000),
      autoCompactTokenLimitScope: z.literal("total"),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(runtime.artifactDirectory, "isolation.json"),
          "utf8",
        ),
      ),
    );
  const players = [];
  for (const effort of ["low", "medium"] as const) {
    const threadId = await runtime.createPlayer(
      {
        id: `context-e2e-${effort}`,
        reasoningEffort: effort,
        prompt:
          "You are an OpenFront game player. Preserve native game history.",
        tools: [],
      },
      async () => {
        throw new Error("The context probe does not allow inference.");
      },
      (event) => events.push(event),
    );
    const configuration = z
      .object({
        type: z.literal("configuration"),
        model: z.literal("gpt-6-luna"),
        effort: z.literal(effort),
        contextWindow: z.literal(150_000),
        autoCompactTokenLimit: z.literal(60_000),
        autoCompactTokenLimitScope: z.literal("total"),
        instructionSources: z.array(z.string()).length(0),
      })
      .parse(
        events.find(
          (event) => event.type === "configuration" && event.effort === effort,
        ),
      );
    const metadata = await runtime.history(threadId, false);
    assert.equal(metadata.ephemeral, false);
    assert.equal(metadata.model, "gpt-6-luna");
    assert.equal(metadata.reasoningEffort, effort);
    assert.deepEqual(metadata.turns, []);
    players.push({ effort, configuration, threadId, persistent: true });
  }
  Object.assign(evidence, {
    passed: true,
    status,
    isolation,
    players,
  });
} finally {
  await runtime.close();
  await assert.rejects(
    access(join(runtime.artifactDirectory, "home", "auth.json")),
  );
  const artifact = join(runtime.artifactDirectory, "context-e2e.json");
  await writeFile(
    artifact,
    JSON.stringify({ ...evidence, copiedCredentialsRemoved: true }, null, 2),
  );
  console.log(JSON.stringify({ artifact, inferenceRequests: 0 }));
}
