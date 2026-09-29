import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

/** Model in provider/model format. Empty means the user's opencode default. */
export function currentModel(): string {
  return (
    process.env.OPENFRONT_OPENCODE_MODEL ?? process.env.OPENCODE_MODEL ?? ""
  );
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
