import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { currentModel, currentVariant } from "./config";
import { isTransientRunError, messageText, parseActionOutput } from "./output";
import { OpenCodeServe } from "./serve";

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
  turns: number;
};
type ActiveTurn = {
  controller?: AbortController;
  resolve: () => void;
  reject: (error: Error) => void;
};

/** Per-turn ceiling for the free pool: slower than Codex, so wait longer. */
export const OPENCODE_TURN_TIMEOUT_MS = 240_000;
const TRANSIENT_RETRIES = 2;
const TRANSIENT_WAIT_MS = 15_000;
/** Sessions rotate before context debt can slow the free pool down. */
const SESSION_TURNS = 12;

/** OpenCode-backed turns over one persistent `opencode serve` child.
 *
 * Each decision sends the player's own instructions plus the live snapshot
 * and asks for a single JSON action object. The runtime executes the
 * returned think/act calls through the arena bridge. A shared server
 * removes the per-turn process boot, so decisions pace like persistent
 * model sessions instead of cold CLI starts.
 */
export class OpenCodeRuntime {
  artifactDirectory = "";
  private serve?: OpenCodeServe;
  private players = new Map<string, Player>();
  private active = new Map<string, ActiveTurn>();
  private closed = false;

  async initialize(): Promise<{ authenticated: boolean; models: string[] }> {
    this.serve = await OpenCodeServe.launch();
    this.artifactDirectory = await mkdtemp(
      join(tmpdir(), "openfront-opencode-"),
    );
    await mkdir(this.artifactDirectory, { recursive: true });
    const model = currentModel();
    await writeFile(
      join(this.artifactDirectory, "runtime.json"),
      JSON.stringify(
        {
          provider: "opencode",
          transport: "serve",
          serverVersion: this.serve.version,
          model,
          variant: currentVariant(),
        },
        null,
        2,
      ),
    );
    return { authenticated: true, models: [model] };
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
    const sessionId = await this.createSession(threadId);
    this.players.set(threadId, {
      id: definition.id,
      prompt: definition.prompt,
      onTool,
      onEvent,
      log: Promise.resolve(),
      sessionId,
      turns: 0,
    });
    await writeFile(
      join(this.artifactDirectory, `${threadId}.json`),
      JSON.stringify(
        {
          playerId: definition.id,
          threadId,
          provider: "opencode",
          transport: "serve",
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
      transport: "serve",
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
    const player = this.player(threadId);
    this.active.get(threadId)?.controller?.abort();
    // Best effort: the in-flight message ends on abort either way.
    if (player.sessionId) {
      await this.serve
        ?.request("POST", `/session/${player.sessionId}/abort`)
        .catch(() => undefined);
    }
  }

  async compact(threadId: string): Promise<void> {
    const player = this.player(threadId);
    // Sessions rotate every few turns, so no compaction debt accumulates.
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
    for (const active of this.active.values()) active.controller?.abort();
    this.active.clear();
    await Promise.all([...this.players.values()].map((player) => player.log));
    await this.serve?.close();
    this.serve = undefined;
  }

  private player(threadId: string): Player {
    const player = this.players.get(threadId);
    if (!player) throw new Error(`Unknown OpenCode game thread: ${threadId}`);
    return player;
  }

  private modelRef(): { providerID: string; modelID: string } {
    const [providerID, ...rest] = currentModel().split("/");
    return { providerID, modelID: rest.join("/") };
  }

  private async createSession(threadId: string): Promise<string> {
    const session = (await this.serve?.request("POST", "/session", {
      title: `OpenFront ${threadId}`,
    })) as { id: string };
    if (!session?.id) throw new Error("OpenCode did not return a session.");
    return session.id;
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
    if (
      !player.sessionId ||
      (player.turns > 0 && player.turns % SESSION_TURNS === 0)
    ) {
      player.sessionId = await this.createSession(threadId);
      player.turns = 0;
      this.emit(threadId, {
        type: "rotation",
        sessionId: player.sessionId,
      });
    }
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
    const parts: Record<string, unknown>[] = [{ type: "text", text: prompt }];
    // Frame paths relative to the repo root must become absolute URIs.
    for (const image of images) {
      const absolute = isAbsolute(image.path)
        ? image.path
        : resolve(image.path);
      parts.push({
        type: "file",
        mime: "image/png",
        url: `file:///${absolute.replace(/\\/g, "/")}`,
      });
    }
    const activeController = new AbortController();
    active.controller = activeController;
    let answer: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        const model = this.modelRef();
        answer = await this.serve?.request(
          "POST",
          `/session/${player.sessionId}/message`,
          {
            model: { providerID: model.providerID, modelID: model.modelID },
            variant: currentVariant(),
            system: player.prompt,
            parts,
          },
          activeController.signal,
        );
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < TRANSIENT_RETRIES && isTransientRunError(message)) {
          this.emit(threadId, {
            type: "retry",
            attempt: attempt + 1,
            message: message.slice(0, 300),
          });
          await new Promise((resolve) =>
            setTimeout(resolve, TRANSIENT_WAIT_MS),
          );
          continue;
        }
        this.emit(threadId, { type: "error", message });
        throw error;
      }
    }
    player.turns++;
    const response = messageText(
      (answer as { parts?: unknown })?.parts ?? answer,
    );
    this.emit(threadId, {
      type: "response",
      sessionId: player.sessionId ?? null,
      text: response.slice(0, 8_000),
    });
    const output = parseActionOutput(response);
    if ("error" in output) {
      this.emit(threadId, { type: "unparsable", message: output.error });
      return;
    }
    // Bridge rejections (like the one-build limit) guide the next decision;
    // they must not fail the turn or halt the match.
    if (output.note !== undefined) {
      try {
        await player.onTool("think", { note: output.note });
      } catch (error) {
        this.emit(threadId, {
          type: "tool_error",
          tool: "think",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (output.action !== undefined) {
      try {
        await player.onTool("act", output.action);
      } catch (error) {
        this.emit(threadId, {
          type: "tool_error",
          tool: "act",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
