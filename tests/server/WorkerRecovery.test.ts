import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Failure cases: a native worker has no parent-side env property, replacements
// can lose their logical index, stale lobby state can survive, and broadcasts
// can keep targeting the closed IPC channel or disrupt the other worker.
it("recovers native cluster workers across repeated exits", async () => {
  const artifact = path.resolve("out/worker-recovery.json");
  await mkdir(path.dirname(artifact), { recursive: true });
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "tests/server/fixtures/WorkerRecovery.ts"],
    {
      env: {
        ...process.env,
        GAME_ENV: "dev",
        DOMAIN: "localhost",
        NUM_WORKERS: "2",
      },
      timeout: 25_000,
    },
  ).then(
    ({ stdout, stderr }) => ({ success: true, stdout, stderr }),
    (error: Error & { stdout: string; stderr: string }) => ({
      success: false,
      stdout: error.stdout,
      stderr: error.stderr,
      error: error.message,
    }),
  );
  await writeFile(artifact, JSON.stringify(result, null, 2));
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(result.stdout).toContain('"cycles":3');
  expect(result.stdout + result.stderr).not.toContain("ERR_IPC_CHANNEL_CLOSED");
}, 30_000);
