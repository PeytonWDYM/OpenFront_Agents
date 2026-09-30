import { open } from "node:fs/promises";
import { z } from "zod";
import { tokenUsage } from "./protocol";

type Totals = z.infer<typeof tokenUsage>["tokenUsage"]["total"];
const emptyTotals: Totals = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
const count = z.number().int().nonnegative();
const nativeRecord = z.object({
  thread_id: z.string(),
  thread_token_usage: z.object({
    total_tokens: count,
    input_tokens: count,
    cached_input_tokens: count,
    cache_write_input_tokens: count,
    output_tokens: count,
    reasoning_output_tokens: count,
  }),
});
const rolloutEntry = z.object({ type: z.string(), payload: z.unknown() });

/** Read recent ledger records without loading the player's image history. */
async function latestUsageRecord(path: string) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let length = Math.min(size, 64 * 1024);
    while (length > 0) {
      const buffer = Buffer.alloc(length);
      const start = size - length;
      await file.read(buffer, 0, length, start);
      const text = buffer.toString("utf8");
      // The first line can start inside an image or a large checkpoint.
      const lines = (start === 0 ? text : text.slice(text.indexOf("\n") + 1))
        .trimEnd()
        .split("\n");
      for (let index = lines.length - 1; index >= 0; index--) {
        if (!lines[index]) continue;
        const entry = rolloutEntry.parse(JSON.parse(lines[index]));
        const candidate =
          entry.type === "token_usage_record"
            ? entry.payload
            : entry.type === "compacted"
              ? z
                  .object({ latest_token_usage_record: z.unknown().optional() })
                  .parse(entry.payload).latest_token_usage_record
              : undefined;
        if (candidate !== undefined && candidate !== null)
          return nativeRecord.parse(candidate);
      }
      if (length === size) break;
      length = Math.min(size, length * 2);
    }
    throw new Error("The native rollout has no token usage record.");
  } finally {
    await file.close();
  }
}

/** Native records include remote compaction usage omitted by the CLI's legacy RPC counter. */
export class UsageAccounting {
  private reported = { ...emptyTotals };
  private offset = { ...emptyTotals };
  private contextWindow: number | null = null;
  private nativeAccounting = false;

  update(total: Totals, contextWindow: number | null) {
    this.reported = total;
    this.contextWindow = contextWindow;
    // After compaction, publish only native totals. An RPC catch-up can otherwise add the old offset twice.
    if (!this.nativeAccounting) return this.snapshot();
  }

  async reconcile(path: string, threadId: string) {
    const record = await latestUsageRecord(path);
    if (record.thread_id !== threadId)
      throw new Error("The native usage record belongs to another thread.");
    const native = record.thread_token_usage;
    const total: Totals = {
      totalTokens: native.total_tokens,
      inputTokens: native.input_tokens,
      cachedInputTokens: native.cached_input_tokens,
      cacheWriteInputTokens: native.cache_write_input_tokens,
      outputTokens: native.output_tokens,
      reasoningOutputTokens: native.reasoning_output_tokens,
    };
    const offset = { ...emptyTotals };
    for (const key of Object.keys(total) as (keyof Totals)[]) {
      offset[key] = total[key] - this.reported[key];
      if (offset[key] < 0)
        throw new Error("The native usage record is behind the RPC counter.");
    }
    // Recompute against the latest RPC totals so replay or counter catch-up cannot add usage twice.
    this.offset = offset;
    this.nativeAccounting = true;
    return this.snapshot();
  }

  private snapshot() {
    const total = { ...emptyTotals };
    for (const key of Object.keys(total) as (keyof Totals)[])
      total[key] = this.reported[key] + this.offset[key];
    return {
      type: "tokens" as const,
      ...total,
      contextWindow: this.contextWindow,
    };
  }
}
