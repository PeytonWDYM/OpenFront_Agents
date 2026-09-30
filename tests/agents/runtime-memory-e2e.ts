// Failure cases: a compacted thread loses its player's plan, history moves to a new
// thread, native usage excludes compaction, or a context limit stops later turns.
// This probe uses the authenticated native runtime and writes repeatable evidence.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CodexRuntime } from "../../src/agents/codex";

const runtime = new CodexRuntime();
const events: Record<string, unknown>[] = [];
const orders: string[] = [];
const evidence: Record<string, unknown> = {};
try {
  await runtime.initialize();
  const threadId = await runtime.createPlayer(
    {
      id: "memory-e2e",
      prompt:
        "You are a game player in a memory test. Follow the supplied plan. For each decision, call order once with the exact target ID. End briefly. Preserve the plan across native compaction.",
      tools: [
        {
          name: "order",
          description: "Submit this decision's target ID.",
          inputSchema: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
            additionalProperties: false,
          },
        },
      ],
    },
    async (_name, args) => {
      const { target } = z.object({ target: z.string() }).parse(args);
      orders.push(target);
      return { data: { accepted: true } };
    },
    (event) => events.push(event),
  );
  await runtime.turn(
    threadId,
    "Plan: target native player jade_471 for the first decision. After that, target harbor_928 for every later decision. This is the first decision.",
  );
  assert.deepEqual(orders, ["jade_471"]);
  await runtime.compact(threadId);
  const compactedHistory = await runtime.history(threadId);
  assert.equal(compactedHistory.id, threadId);
  await runtime.turn(
    threadId,
    "This is the next decision. Follow your saved plan.",
  );
  assert.deepEqual(orders, ["jade_471", "harbor_928"]);
  const tokenEvents = events.filter((event) => event.type === "tokens");
  assert.ok(tokenEvents.length > 0);
  const finalUsage = tokenEvents[tokenEvents.length - 1];
  assert.ok(Number(finalUsage.totalTokens) > 0);
  assert.ok(
    events.some(
      (event) =>
        event.method === "item/completed" &&
        z.record(z.string(), z.unknown()).parse(event.params).item !==
          undefined,
    ),
  );
  Object.assign(evidence, {
    passed: true,
    threadId,
    orders,
    configuration: events.find((event) => event.type === "configuration"),
    usage: finalUsage,
    compactionEvents: events.filter((event) =>
      JSON.stringify(event).includes("contextCompaction"),
    ),
  });
} finally {
  await runtime.close();
  const artifact = join(runtime.artifactDirectory, "runtime-memory-e2e.json");
  await writeFile(artifact, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ artifact, passed: evidence.passed ?? false }));
}
