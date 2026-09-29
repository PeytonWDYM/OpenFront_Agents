import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentModel, currentVariant, executable } from "./config";
import { parseActionOutput, parseRunEvents } from "./output";

export type GameTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type PlayerDefinition = {
  id: string;
  prompt: string;
  tools: GameTool[];
};
export type GameImage = { path: string };
export type GameToolResult = { data: unknown; images?: readonly GameImage[] };
type Player = {
  id: string;
  prompt: string;
  onTool: (name: string, args: unknown) => Promise<GameToolResult>;
  onEvent: (event: Record<string, unknown>) => void;
  log: Promise<void>;
  sessionId?: string;
};
type ActiveTurn = {
  child?: ChildProcess;
  resolve: () => void;
  reject: (error: Error) => void;
};

const TURN_TIMEOUT_MS = 90_000;

/** OpenCode-backed turns over `opencode run --format json`.
 *
 * Each decision sends the player's own instructions plus the live snapshot
 * and asks for a single JSON action object. The runtime executes the
 * returned think/act calls through the arena bridge. This keeps opencode
 * usage on any user-configured model without a persistent tool-loop server.
 */
export class OpenCodeRuntime {
  artifactDirectory = "";
  private command = "";
  private launchArgs: string[] = [];
  private players = new Map<string, Player>();
  private active = new Map<string, ActiveTurn>();
  private closed = false;

  async initialize(): Promise<{ authenticated: boolean; models: string[] }> {
    const launch = await executable();
    this.command = launch.command;
    this.launchArgs = launch.args;
    this.artifactDirectory = await mkdtemp(
      join(tmpdir(), "openfront-opencode-"),
    );
    await mkdir(this.artifactDirectory, { recursive: true });
    await this.runOnce(["--version"], "", 15_000);
    let authenticated = true;
    try {
      await this.runOnce(["auth", "list"], "", 15_000);
    } catch {
      authenticated = false;
    }
    const model = currentModel();
    const variant = currentVariant();
    const models = [model];
    await writeFile(
      join(this.artifactDirectory, "runtime.json"),
      JSON.stringify(
        {
          provider: "opencode",
          model,
          variant,
          command: this.command,
        },
        null,
        2,
      ),
    );
    return { authenticated, models };
  }

  async createPlayer(
    definition: PlayerDefinition,
    onTool: Player["onTool"],
    onEvent: Player["onEvent"],
  ): Promise<string> {
    if (this.closed) throw new Error("The OpenCode runtime is closed.");
    if (
      [...this.players.values()].some((player) => player.id === definition.id)
    )
      throw new Error("The player already has an OpenCode session.");
    const threadId = `opencode-${definition.id}-${Date.now().toString(36)}`;
    this.players.set(threadId, {
      id: definition.id,
      prompt: definition.prompt,
      onTool,
      onEvent,
      log: Promise.resolve(),
    });
    await writeFile(
      join(this.artifactDirectory, `${threadId}.json`),
      JSON.stringify(
        {
          playerId: definition.id,
          threadId,
          provider: "opencode",
          model: currentModel(),
          variant: currentVariant(),
          prompt: definition.prompt,
          tools: definition.tools.map((tool) => tool.name),
        },
        null,
        2,
      ),
    );
    this.emit(threadId, {
      type: "configuration",
      provider: "opencode",
      model: currentModel(),
      variant: currentVariant(),
      tools: definition.tools.map((tool) => tool.name),
    });
    return threadId;
  }

  turn(
    threadId: string,
    text: string,
    images: readonly GameImage[] = [],
  ): Promise<void> {
    const known = this.players.get(threadId);
    if (!known)
      return Promise.reject(
        new Error(`Unknown OpenCode game thread: ${threadId}`),
      );
    const player = known;
    if (this.active.has(threadId))
      return Promise.reject(
        new Error("The OpenCode thread already has an active turn."),
      );
    return new Promise((resolve, reject) => {
      const active: ActiveTurn = { resolve, reject };
      this.active.set(threadId, active);
      void this.decide(threadId, player, text, images, active).then(
        () => {
          this.active.delete(threadId);
          resolve();
        },
        (error: unknown) => {
          this.active.delete(threadId);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async interrupt(threadId: string): Promise<void> {
    this.player(threadId);
    const active = this.active.get(threadId);
    if (!active?.child) return;
    active.child.kill("SIGTERM");
  }

  async compact(threadId: string): Promise<void> {
    const player = this.player(threadId);
    // JSON turns are stateless per decision; the arena already resends the
    // full snapshot, so compaction only records a checkpoint event.
    this.emit(threadId, {
      type: "compact",
      sessionId: player.sessionId ?? null,
    });
  }

  async history(threadId: string): Promise<Record<string, unknown>> {
    const player = this.player(threadId);
    return {
      threadId,
      playerId: player.id,
      sessionId: player.sessionId ?? null,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.active.values()) active.child?.kill("SIGTERM");
    this.active.clear();
    await Promise.all([...this.players.values()].map((player) => player.log));
  }

  private player(threadId: string): Player {
    const player = this.players.get(threadId);
    if (!player) throw new Error(`Unknown OpenCode game thread: ${threadId}`);
    return player;
  }

  private emit(threadId: string, event: Record<string, unknown>) {
    const player = this.player(threadId);
    const serialized = JSON.stringify({ ...event, threadId, at: Date.now() });
    player.log = player.log.then(() =>
      appendFile(
        join(this.artifactDirectory, `${threadId}.jsonl`),
        `${serialized}\n`,
      ),
    );
    player.onEvent(JSON.parse(serialized) as Record<string, unknown>);
  }

  private async decide(
    threadId: string,
    player: Player,
    text: string,
    images: readonly GameImage[],
    active: ActiveTurn,
  ): Promise<void> {
    // The turn carries the player's own instructions plus the live state.
    // No harness strategy coaching is added; the only extra lines are the
    // machine-readable reply envelope the parser needs.
    const prompt = [
      player.prompt,
      "",
      "Current state:",
      text,
      "",
      "Reply with one JSON object and no other prose.",
      'Shape: {"note":"short plan","intent":{...} | "intents":[{...}],"attackRatio":0..1,"nextDecisionSeconds":1..10}. Omit intent when no action helps.',
    ].join("\n");
    const args = ["run", "--format", "json"];
    args.push("--model", currentModel(), "--variant", currentVariant());
    if (player.sessionId) args.push("--session", player.sessionId);
    for (const image of images) args.push("--file", image.path);
    args.push(prompt);
    let stdout: string;
    try {
      stdout = await this.spawnRun(args, active);
    } catch (error) {
      this.emit(threadId, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const parsed = parseRunEvents(stdout);
    if (parsed.sessionId) player.sessionId = parsed.sessionId;
    this.emit(threadId, {
      type: "response",
      sessionId: player.sessionId ?? null,
      text: parsed.text.slice(0, 8_000),
    });
    const output = parseActionOutput(parsed.text);
    if ("error" in output) {
      this.emit(threadId, { type: "unparsable", message: output.error });
      return;
    }
    if (output.note !== undefined) {
      await player.onTool("think", { note: output.note });
    }
    if (output.action !== undefined) {
      await player.onTool("act", output.action);
    }
  }

  private spawnRun(args: string[], active: ActiveTurn): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.launchArgs, ...args], {
        cwd: this.artifactDirectory,
        windowsHide: true,
        // A piped stdin makes the CLI wait for input; turns pass everything
        // as arguments, so close it up front.
        stdio: ["ignore", "pipe", "pipe"],
      });
      active.child = child;
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("OpenCode turn exceeded its 90-second limit."));
      }, TURN_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              `OpenCode run failed (exit ${code}): ${stderr.slice(0, 500)}`,
            ),
          );
      });
    });
  }

  private runOnce(
    args: string[],
    input: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.launchArgs, ...args], {
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("The OpenCode probe timed out."));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(
              `OpenCode probe failed (exit ${code}): ${stderr.slice(0, 300)}`,
            ),
          );
      });
      if (input) child.stdin?.write(input);
      child.stdin?.end();
    });
  }
}
