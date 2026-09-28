import { readFile } from "node:fs/promises";
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
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const entry = rolloutEntry.parse(JSON.parse(lines[index]));
      let candidate: unknown;
      if (entry.type === "token_usage_record") candidate = entry.payload;
      else if (entry.type === "compacted") {
        candidate = z
          .object({ latest_token_usage_record: z.unknown().optional() })
          .parse(entry.payload).latest_token_usage_record;
      }
      if (candidate === undefined || candidate === null) continue;
      const record = nativeRecord.parse(candidate);
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
    throw new Error("The native rollout has no token usage record.");
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
