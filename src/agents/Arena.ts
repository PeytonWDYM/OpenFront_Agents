import { z, ZodError } from "zod";
import { CodexRuntime } from "./codex/index";
import { EventLog } from "./EventLog";
import { AgentGame } from "./game/index";
import {
  AgentActionSchema,
  agentActionToolSchema,
  ObserveQuerySchema,
  quickChatKeys,
} from "./game/schemas";
import { playerPrompt } from "./PlayerPrompt";
import { scriptedAction } from "./ScriptedPlayer";
import { ArenaSettingsSchema, defaultSettings } from "./Settings";
import { TurnQueue } from "./TurnQueue";
import type { AgentPlayer, ArenaSnapshot } from "./types";

const TURN_RESERVATION = 4_096;
const ObserveWorldQuerySchema = ObserveQuerySchema.extend({
  quickChatKeys: z.boolean().optional(),
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class Arena {
  private state: ArenaSnapshot = {
    phase: "idle",
    gameId: null,
    players: [],
    settings: defaultSettings,
    runtime: { authenticated: false, models: [] },
    totalTokens: 0,
  };
  private game: AgentGame | null = null;
  private runtime: CodexRuntime | null = null;
  private queue: TurnQueue | null = null;
  private logs = new EventLog();
  private readonly reservations = new Set<string>();
  private readonly calls = new Map<string, number>();
  private readonly invalidActions = new Map<string, number>();
  private readonly actions = new Map<string, number>();
  private readonly halted = new Set<string>();

  snapshot(): ArenaSnapshot {
    this.syncPlayers();
    return structuredClone(this.state);
  }

  inspect(id: string, full = false) {
    return { player: { ...this.player(id) }, events: this.logs.read(id, full) };
  }

  observe(id: string) {
    this.player(id);
    if (!this.game) throw new Error("Create a lobby first.");
    return this.game.observe(id);
  }

  async create(input: unknown) {
    const settings = ArenaSettingsSchema.parse(input);
    if (["lobby", "running", "paused"].includes(this.state.phase))
      throw new Error("Stop the current arena before creating another lobby.");
    await this.stop();
    this.logs = new EventLog();
    this.halted.clear();
    this.state = {
      phase: "idle",
      gameId: null,
      players: [],
      settings,
      runtime: { authenticated: false, models: [] },
      totalTokens: 0,
    };
    try {
      if (settings.mode === "codex") {
        this.runtime = new CodexRuntime();
        this.state.runtime = await this.runtime.initialize();
        if (!this.state.runtime.authenticated)
          throw new Error("Codex subscription authentication is required.");
        if (!this.state.runtime.models.includes("gpt-6-luna"))
          throw new Error(
            "The authenticated Codex runtime does not offer gpt-6-luna.",
          );
      }
      this.game = new AgentGame({
        agentCount: settings.agentCount,
        onEvent: (event) => this.gameEvent(event),
      });
      const lobby = await this.game.create();
      this.state.gameId = lobby.gameId;
      this.state.players = this.game.players().map((player) => ({
        id: player.id,
        name: player.name,
        alive: true,
        threadId: null,
        tokens: 0,
        decisions: 0,
        status: "ready",
      }));
      for (const player of this.state.players) {
        this.logs.add(
          player.id,
          "ready",
          `${player.name} joined the local lobby.`,
        );
      }
      if (this.runtime) {
        for (const player of this.state.players) {
          const prompt = playerPrompt(player.name);
          this.logs.add(player.id, "instructions", prompt);
          player.threadId = await this.runtime.createPlayer(
            {
              id: player.id,
              prompt,
              tools: [
                {
                  name: "observe_world",
                  description:
                    "Read your current world, legal actions, and a bounded map region.",
                  inputSchema: z.toJSONSchema(ObserveWorldQuerySchema),
                },
                {
                  name: "act",
                  description:
                    "Submit one native gameplay intent as your own player. Execution may reject stale or illegal actions.",
                  inputSchema: agentActionToolSchema,
                },
              ],
            },
            (name, args) => this.tool(player.id, name, args),
            (event) => this.runtimeEvent(player, event),
          );
          this.logs.add(player.id, "thread", player.threadId);
        }
      }
      this.queue = new TurnQueue(
        settings.concurrency,
        settings.decisionIntervalMs,
        (id) =>
          this.state.phase === "running" &&
          this.player(id).alive &&
          !this.player(id).error &&
          (settings.maxDecisionsPerPlayer === undefined ||
            this.player(id).decisions < settings.maxDecisionsPerPlayer),
        (id) => this.reserve(id),
        (id) => this.decide(id),
        (id) => this.reservations.delete(id),
      );
      this.state.phase = "lobby";
    } catch (error) {
      this.state.phase = "error";
      this.state.error = message(error);
      if (this.runtime) this.state.runtime.error = message(error);
      await this.closeResources();
      throw error;
    }
    return this.snapshot();
  }

  async start() {
    if (this.state.phase !== "lobby")
      throw new Error("Create a lobby before starting.");
    try {
      await this.game!.start();
      this.state.phase = "running";
      this.queue!.start(this.state.players.map((player) => player.id));
    } catch (error) {
      this.state.phase = "error";
      this.state.error = message(error);
      throw error;
    }
    return this.snapshot();
  }

  async pause() {
    if (this.state.phase !== "running" && this.state.phase !== "paused")
      throw new Error("The arena is not running.");
    this.halt("paused");
    await this.interruptActive();
    await this.queue!.drain();
    return this.snapshot();
  }

  resume() {
    if (this.state.phase !== "paused")
      throw new Error("Pause the arena before resuming.");
    if (
      this.state.settings.mode === "codex" &&
      this.state.totalTokens + TURN_RESERVATION > this.state.settings.maxTokens
    )
      throw new Error(
        "The token budget is exhausted. Create another arena with a larger budget.",
      );
    this.state.phase = "running";
    delete this.state.error;
    for (const player of this.state.players) {
      if (
        player.error &&
        /quota|rate.limit|usage.limit|exhaust/i.test(player.error)
      ) {
        delete player.error;
        player.status = "ready";
      }
    }
    this.queue!.start();
    return this.snapshot();
  }

  async stop() {
    this.halt("stopped");
    await this.interruptActive();
    await this.queue?.drain();
    await this.closeResources();
    return this.snapshot();
  }

  async compact(id: string) {
    const player = this.player(id);
    if (this.state.phase !== "paused" && this.state.phase !== "lobby")
      throw new Error("Pause agents before compacting a thread.");
    if (!this.runtime || !player.threadId)
      throw new Error("Scripted players do not have Codex threads.");
    await this.queue?.drain();
    if (
      this.state.totalTokens + TURN_RESERVATION >
      this.state.settings.maxTokens
    ) {
      throw new Error("The token budget cannot reserve native compaction.");
    }
    this.reservations.add(id);
    player.status = "compacting";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const runtime = this.runtime;
      const threadId = player.threadId;
      await Promise.race([
        runtime.compact(threadId),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            void runtime.interrupt(threadId).catch(() => {});
            reject(
              new Error("Native compaction exceeded its 90-second limit."),
            );
          }, 90_000);
        }),
      ]);
      this.logs.add(id, "compact", "Native thread compaction completed.");
    } catch (error) {
      player.error = message(error);
      this.state.error = player.error;
      this.logs.add(id, "error", player.error);
      this.halt("error");
      try {
        await this.closeResources();
      } catch (closeError) {
        this.logs.add(
          id,
          "error",
          `Resource cleanup failed: ${message(closeError)}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.reservations.delete(id);
      player.status = player.error ? "error" : "ready";
    }
    return this.inspect(id);
  }

  private player(id: string) {
    const player = this.state.players.find((item) => item.id === id);
    if (!player) throw new Error("Unknown agent player.");
    return player;
  }

  private syncPlayers() {
    if (!this.game) return;
    for (const native of this.game.players()) {
      const player = this.state.players.find((item) => item.id === native.id);
      if (!player) continue;
      player.alive = native.alive;
      if (!native.alive && player.status !== "eliminated") {
        player.status = "eliminated";
        this.halted.add(player.id);
        if (this.runtime && player.threadId)
          void this.runtime.interrupt(player.threadId).catch(() => {});
      }
    }
  }

  private reserve(id: string) {
    this.syncPlayers();
    if (!this.player(id).alive) return false;
    if (
      this.state.settings.mode === "codex" &&
      this.state.totalTokens + (this.reservations.size + 1) * TURN_RESERVATION >
        this.state.settings.maxTokens
    ) {
      this.state.error = "The token budget cannot reserve another decision.";
      this.halt("paused");
      void this.interruptActive();
      return false;
    }
    this.reservations.add(id);
    return true;
  }

  private async tool(id: string, name: string, args: unknown) {
    if (
      this.state.phase !== "running" ||
      this.halted.has(id) ||
      !this.player(id).alive
    )
      throw new Error("This player's decisions have stopped.");
    const calls = (this.calls.get(id) ?? 0) + 1;
    this.calls.set(id, calls);
    if (calls > 4) {
      this.halted.add(id);
      const player = this.player(id);
      if (player.threadId)
        void this.runtime!.interrupt(player.threadId).catch(() => {});
      throw new Error("The four-tool-call limit ended this decision.");
    }
    if (name === "observe_world") {
      const { quickChatKeys: includeQuickChatKeys, ...region } =
        ObserveWorldQuerySchema.parse(args);
      const observation = this.game!.observe(id, region);
      this.logs.add(
        id,
        "observe",
        `World observation at tick ${observation.tick}.`,
      );
      return includeQuickChatKeys
        ? { ...observation, quickChatKeys }
        : observation;
    }
    if (name !== "act") throw new Error("Unknown game tool.");
    let result: Awaited<ReturnType<AgentGame["act"]>>;
    try {
      const { intent } = z
        .object({ intent: AgentActionSchema })
        .strict()
        .parse(args);
      const actions = this.actions.get(id) ?? 0;
      if (actions >= 2) {
        this.halted.add(id);
        const player = this.player(id);
        if (player.threadId)
          void this.runtime!.interrupt(player.threadId).catch(() => {});
        throw new Error("The two-action limit ended this decision.");
      }
      this.actions.set(id, actions + 1);
      result = await this.game!.act(id, intent);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      const failures = (this.invalidActions.get(id) ?? 0) + 1;
      this.invalidActions.set(id, failures);
      this.logs.add(
        id,
        "tool_error",
        "The act arguments did not match the native intent schema.",
      );
      if (failures >= 2) {
        this.halted.add(id);
        const player = this.player(id);
        if (player.threadId)
          void this.runtime!.interrupt(player.threadId).catch(() => {});
      }
      throw Object.assign(
        new Error(
          "Invalid act arguments. Supply {intent: {type: 'attack', targetID: null, troops: 5000}} or another intent from the action schema.",
        ),
        { cause: error },
      );
    }
    const player = this.player(id);
    player.lastAction = JSON.stringify(result.intent);
    this.logs.add(id, "action", `Submitted ${player.lastAction}`, result);
    return result;
  }

  private async decide(id: string) {
    if (this.state.phase !== "running") return;
    const player = this.player(id);
    this.halted.delete(id);
    this.calls.set(id, 0);
    this.invalidActions.set(id, 0);
    this.actions.set(id, 0);
    player.status = "thinking";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const observation = this.game!.observe(id);
      if (observation.spawnPhase) {
        player.status = "waiting";
        return 500;
      }
      if (this.state.settings.mode === "scripted") {
        const action = scriptedAction(observation);
        if (!action) return 500;
        await this.tool(id, "act", { intent: action });
      } else {
        const text = JSON.stringify(observation);
        timeout = setTimeout(() => {
          this.halted.add(id);
          this.logs.add(
            id,
            "limit",
            "The decision time limit ended this turn.",
          );
          void this.runtime!.interrupt(player.threadId!).catch(() => {});
        }, 90_000);
        await this.runtime!.turn(
          player.threadId!,
          `Choose and submit useful actions. Current world: ${text}`,
        );
      }
      player.decisions++;
      this.logs.add(id, "decision", `Decision ${player.decisions} completed.`);
    } catch (error) {
      if (this.state.phase === "running") {
        player.error = message(error);
        this.logs.add(id, "error", player.error);
        this.state.error = player.error;
        this.halt(
          /quota|rate.limit|usage.limit|exhaust/i.test(player.error)
            ? "paused"
            : "error",
        );
        void this.interruptActive();
      }
    } finally {
      clearTimeout(timeout);
      if (player.alive) player.status = player.error ? "error" : "ready";
    }
  }

  private runtimeEvent(player: AgentPlayer, event: Record<string, unknown>) {
    this.logs.add(
      player.id,
      typeof event.type === "string"
        ? event.type
        : typeof event.method === "string"
          ? event.method
          : "codex",
      JSON.stringify(event),
      event,
    );
    if (event.type !== "tokens" || typeof event.totalTokens !== "number")
      return;
    const delta = Math.max(0, event.totalTokens - player.tokens);
    player.tokens += delta;
    this.state.totalTokens += delta;
    if (
      this.state.totalTokens >= this.state.settings.maxTokens &&
      this.state.phase === "running"
    ) {
      this.state.error = "The token budget is exhausted.";
      this.halt("paused");
      void this.interruptActive();
    }
  }

  private gameEvent(event: {
    type: string;
    agentId?: string;
    data: Record<string, unknown>;
  }) {
    if (event.agentId)
      this.logs.add(
        event.agentId,
        `game:${event.type}`,
        JSON.stringify(event.data),
        event,
      );
    if (event.type === "error") {
      this.state.error = JSON.stringify(event.data);
      this.halt("error");
      void this.interruptActive();
    }
    if (event.type === "win") {
      this.halt("stopped");
      void this.interruptActive();
    }
    this.syncPlayers();
  }

  private halt(phase: ArenaSnapshot["phase"]) {
    this.state.phase = phase;
    this.queue?.pause();
    for (const id of this.queue?.activeIds() ?? []) this.halted.add(id);
  }

  private async interruptActive() {
    if (!this.runtime) return;
    const runtime = this.runtime;
    await Promise.allSettled(
      (this.queue?.activeIds() ?? []).map((id) =>
        runtime.interrupt(this.player(id).threadId!),
      ),
    );
  }

  private async closeResources() {
    try {
      await this.game?.close();
    } finally {
      await this.runtime?.close();
    }
    this.game = null;
    this.runtime = null;
    this.queue = null;
    this.reservations.clear();
  }
}
