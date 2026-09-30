import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CodexRuntime } from "../../src/agents/codex";

// Failure cases: ignored native context flags, a threshold above usable context,
// per-player reasoning overrides lost, coder instructions restored, or the copied login retained.
// The default probe creates isolated low and medium threads without inference.
// --turn adds one short low-effort reply to verify native usable context.
const runtime = new CodexRuntime();
const events: Record<string, unknown>[] = [];
const evidence: Record<string, unknown> = {
  inferenceRequests: 0,
  passed: false,
};
try {
  const status = await runtime.initialize();
  assert.equal(status.authenticated, true);
  const isolation = z
    .object({
      contextWindow: z.literal(272_000),
      autoCompactTokenLimit: z.literal(220_000),
      autoCompactTokenLimitScope: z.literal("total"),
      instructionFiles: z.array(z.string()).length(0),
      skills: z.array(z.string()).length(0),
      mcpServers: z.array(z.string()).length(0),
      plugins: z.array(z.string()).length(0),
      sandbox: z.literal("read-only"),
      approvalPolicy: z.literal("never"),
      webSearch: z.literal("disabled"),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(runtime.artifactDirectory, "isolation.json"),
          "utf8",
        ),
      ),
    );
  const catalog = z
    .object({
      models: z
        .array(
          z.object({
            slug: z.literal("gpt-6-luna"),
            context_window: z.literal(272_000),
            effective_context_window_percent: z.literal(95),
          }),
        )
        .length(1),
    })
    .parse(
      JSON.parse(
        await readFile(join(runtime.artifactDirectory, "models.json"), "utf8"),
      ),
    );
  const model = catalog.models[0];
  const effectiveContextWindow =
    (isolation.contextWindow * model.effective_context_window_percent) / 100;
  const compactionHeadroom =
    effectiveContextWindow - isolation.autoCompactTokenLimit;
  assert.equal(effectiveContextWindow, 258_400);
  assert.equal(compactionHeadroom, 38_400);
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
        throw new Error("The context probe does not allow tool calls.");
      },
      (event) => events.push(event),
    );
    const configuration = z
      .object({
        type: z.literal("configuration"),
        model: z.literal("gpt-6-luna"),
        effort: z.literal(effort),
        contextWindow: z.literal(272_000),
        autoCompactTokenLimit: z.literal(220_000),
        autoCompactTokenLimitScope: z.literal("total"),
        instructionSources: z.array(z.string()).length(0),
        sandbox: z.literal("readOnly"),
        tools: z.array(z.string()).length(0),
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
  assert.equal(new Set(players.map((player) => player.threadId)).size, 2);
  if (process.argv.includes("--turn")) {
    evidence.inferenceRequests = 1;
    await runtime.turn(players[0].threadId, "Reply with OK only.");
    const tokens = z
      .object({
        type: z.literal("tokens"),
        contextWindow: z.literal(258_400),
        totalTokens: z.number().positive(),
        inputTokens: z.number().positive(),
        outputTokens: z.number().positive(),
        cachedInputTokens: z.number().nonnegative(),
        reasoningOutputTokens: z.number().nonnegative(),
      })
      .parse(events.filter((event) => event.type === "tokens").pop());
    assert.equal(
      events.filter((event) => event.method === "turn/started").length,
      1,
    );
    assert.equal(
      events.some((event) =>
        JSON.stringify(event).includes("contextCompaction"),
      ),
      false,
    );
    evidence.usage = tokens;
  }
  Object.assign(evidence, {
    passed: true,
    status,
    isolation,
    catalog: model,
    effectiveContextWindow,
    compactionHeadroom,
    effectiveContextVerification: process.argv.includes("--turn")
      ? "native token usage"
      : "native model catalog, without inference",
    automaticCompactionExercised: false,
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
  console.log(
    JSON.stringify({
      artifact,
      passed: evidence.passed,
      inferenceRequests: evidence.inferenceRequests,
    }),
  );
}
