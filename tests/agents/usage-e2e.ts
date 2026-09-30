// Failure cases: counters miss native compaction, a partial tail line breaks parsing,
// an oversized compaction checkpoint hides its usage record, RPC catch-up counts
// usage twice, or another player's ledger supplies totals.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageAccounting } from "../../src/agents/codex/usage";

const directory = await mkdtemp(join(tmpdir(), "openfront-usage-e2e-"));
const path = join(directory, "rollout.jsonl");
const native = {
  thread_id: "player-ledger",
  thread_token_usage: {
    total_tokens: 300,
    input_tokens: 250,
    cached_input_tokens: 120,
    cache_write_input_tokens: 0,
    output_tokens: 50,
    reasoning_output_tokens: 10,
  },
};
const rpc = {
  totalTokens: 200,
  inputTokens: 175,
  cachedInputTokens: 100,
  cacheWriteInputTokens: 0,
  outputTokens: 25,
  reasoningOutputTokens: 5,
};
const accounting = new UsageAccounting();
accounting.update(rpc, 150_000);
const history = JSON.stringify({
  type: "history",
  payload: "x".repeat(2_000_000),
});
await writeFile(
  path,
  `${history}\n${JSON.stringify({ type: "token_usage_record", payload: native })}\n`,
);
const first = await accounting.reconcile(path, native.thread_id);
assert.equal(first.totalTokens, 300);
assert.equal(first.cachedInputTokens, 120);
accounting.update(
  { ...rpc, totalTokens: 250, inputTokens: 210, outputTokens: 40 },
  150_000,
);
const caughtUp = await accounting.reconcile(path, native.thread_id);
assert.equal(caughtUp.totalTokens, 300);
await writeFile(
  path,
  `${history}\n${JSON.stringify({
    type: "compacted",
    payload: {
      latest_token_usage_record: native,
      summary: "y".repeat(256_000),
    },
  })}\n`,
);
const checkpoint = await accounting.reconcile(path, native.thread_id);
assert.equal(checkpoint.totalTokens, 300);
await assert.rejects(
  accounting.reconcile(path, "another-player"),
  /another thread/,
);
const artifact = join(directory, "usage-e2e.json");
await writeFile(
  artifact,
  JSON.stringify(
    { passed: true, historyBytes: history.length, first, caughtUp, checkpoint },
    null,
    2,
  ),
);
console.log(JSON.stringify({ passed: true, artifact }));
