import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** Default model in provider/model format: Muse Spark 1.3 Free on OpenCode Zen. */
export const DEFAULT_MODEL = "opencode/muse-spark-1.3-contributor-free";
/** Default reasoning variant passed through opencode's --variant flag. */
export const DEFAULT_VARIANT = "medium";

/** Model in provider/model format. Override with OPENFRONT_OPENCODE_MODEL. */
export function currentModel(): string {
  return (
    process.env.OPENFRONT_OPENCODE_MODEL ??
    process.env.OPENCODE_MODEL ??
    DEFAULT_MODEL
  );
}

/** Reasoning variant for opencode's --variant flag. Override with OPENFRONT_OPENCODE_VARIANT. */
export function currentVariant(): string {
  return process.env.OPENFRONT_OPENCODE_VARIANT ?? DEFAULT_VARIANT;
}

/** Resolve the opencode binary without launching a shell on Windows. */
export async function executable(): Promise<{
  command: string;
  args: string[];
}> {
  const explicit =
    process.env.OPENFRONT_OPENCODE_EXECUTABLE ??
    process.env.OPENCODE_EXECUTABLE;
  if (explicit) {
    // Test fakes are plain JS files; run them through Node directly.
    if (/\.m?[jt]s$|\.cjs$/.test(explicit)) {
      return { command: process.execPath, args: [explicit] };
    }
    return { command: explicit, args: [] };
  }
  const suffix = process.platform === "win32" ? ".cmd" : "";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    // Prefer a real executable; .cmd shims need a shell and are a last resort.
    // npm on Windows only puts a .cmd shim on PATH while the real binary
    // lives under node_modules, so probe that layout directly.
    if (process.platform === "win32") {
      try {
        const peer = join(
          directory,
          "node_modules",
          "opencode-ai",
          "bin",
          "opencode.exe",
        );
        await access(peer);
        return { command: peer, args: [] };
      } catch {
        // Not an npm global bin dir; fall through to plain names.
      }
    }
    for (const name of process.platform === "win32"
      ? ["opencode.exe", `opencode${suffix}`, "opencode"]
      : ["opencode"]) {
      try {
        await access(join(directory, name));
        return { command: join(directory, name), args: [] };
      } catch {
        // PATH contains many entries; only an exact binary match counts.
      }
    }
  }
  // Fall back to PATH lookup by the OS. The version probe fails loudly
  // when opencode is not installed.
  return { command: `opencode${suffix}`, args: [] };
}
