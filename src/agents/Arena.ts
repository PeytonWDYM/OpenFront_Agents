import { z, ZodError } from "zod";
import { CodexRuntime } from "./codex/index";
import { EventLog } from "./EventLog";
import {
  AgentGame,
  isUrgentAgentEvent,
  projectDecisionObservation,
} from "./game/index";
import type { AgentGameEvent } from "./game/schemas";
import {
  agentActionToolSchema,
  AgentToolInputSchema,
  ObserveQuerySchema,
  quickChatKeys,
} from "./game/schemas";
import { playerPrompt } from "./PlayerPrompt";
import { scriptedAction } from "./ScriptedPlayer";
import { ArenaSettingsSchema, defaultSettings } from "./Settings";
import { TurnQueue } from "./TurnQueue";
import type { AgentPlayer, ArenaJoin, ArenaSnapshot } from "./types";

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
  private readonly suppliedTicks = new Map<string, number>();
  private readonly requestedDelays = new Map<string, number>();
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
    this.suppliedTicks.clear();
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
        tribeCount: settings.tribeCount,
        nationCount: settings.nationCount,
        onEvent: (event) => this.gameEvent(event),
      });
      const lobby = await this.game.create();
      this.state.gameId = lobby.gameId;
      this.state.players = this.game.players().map((player) => ({
        id: player.id,
        clientId: player.clientId,
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
                    "Submit a native gameplay intent, request the next decision delay, or both. Stale or illegal actions may fail.",
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
        Math.ceil(settings.agentCount / 4),
        (id) =>
          this.state.phase === "running" &&
          this.player(id).alive &&
          !this.player(id).error,
        (id) => this.decide(id),
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

  async start(join?: ArenaJoin) {
    if (this.state.phase !== "lobby")
      throw new Error("Create a lobby before starting.");
    if (join) await this.game!.validateJoin(join);
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
      const sections =
        region.sections ??
        (region.x !== undefined ||
        region.y !== undefined ||
        region.width !== undefined ||
        region.height !== undefined
          ? ["map" as const]
          : undefined);
      if (!sections || sections.includes("events")) {
        observation.events = observation.events.filter(
          (event) => event.tick > (this.suppliedTicks.get(id) ?? -1),
        );
        this.suppliedTicks.set(id, observation.tick);
      }
      const projected = projectDecisionObservation(observation, sections);
      return includeQuickChatKeys ? { ...projected, quickChatKeys } : projected;
    }
    if (name !== "act") throw new Error("Unknown game tool.");
    let result: Awaited<ReturnType<AgentGame["act"]>>;
    try {
      const { intent, attackRatio, nextDecisionSeconds } =
        AgentToolInputSchema.parse(args);
      if (nextDecisionSeconds !== undefined) {
        this.requestedDelays.set(id, nextDecisionSeconds * 1_000);
        this.logs.add(
          id,
          "schedule",
          `Requested the next decision in ${nextDecisionSeconds} seconds.`,
        );
      }
      if (intent === undefined) return { accepted: true, nextDecisionSeconds };
      const actions = this.actions.get(id) ?? 0;
      if (actions >= 2) {
        this.halted.add(id);
        const player = this.player(id);
        if (player.threadId)
          void this.runtime!.interrupt(player.threadId).catch(() => {});
        throw new Error("The two-action limit ended this decision.");
      }
      this.actions.set(id, actions + 1);
      result = await this.game!.act(id, intent, attackRatio);
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
          "Invalid act arguments. Supply a native intent, nextDecisionSeconds from 1 to 10, or both. attackRatio requires an intent.",
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
    this.syncPlayers();
    const player = this.player(id);
    if (!player.alive) return;
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
        const vision = await this.game!.vision(id);
        if (this.state.phase !== "running" || this.halted.has(id)) return;
        const frames = [
          vision.overview,
          ...(vision.tactical ? [vision.tactical] : []),
        ];
        for (const [index, frame] of frames.entries())
          this.logs.add(
            id,
            "vision",
            `${index === 0 ? "Overview" : "Tactical"} map at tick ${vision.tick}.`,
            {
              tick: vision.tick,
              region: frame.region,
              mapPixels: frame.mapPixels,
            },
            frame.url,
          );
        observation.events = observation.events.filter(
          (event) => event.tick > (this.suppliedTicks.get(id) ?? -1),
        );
        this.suppliedTicks.set(id, observation.tick);
        const text = JSON.stringify({
          ...projectDecisionObservation(observation),
          images: frames.map((frame) => ({
            tick: vision.tick,
            width: frame.width,
            height: frame.height,
            region: frame.region,
            mapPixels: frame.mapPixels,
          })),
        });
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
          `Use the live map images and this current state. Submit useful actions directly: ${text}`,
          frames,
        );
      }
      player.decisions++;
      this.logs.add(id, "decision", `Decision ${player.decisions} completed.`);
      return this.requestedDelays.get(id);
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
      this.requestedDelays.delete(id);
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
  }

  private gameEvent(event: AgentGameEvent) {
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
    if (event.agentId && this.state.phase === "running") {
      const native = this.game!.players().find(
        (player) => player.id === event.agentId,
      )!;
      if (isUrgentAgentEvent(event, native.playerId!))
        this.queue!.wake(event.agentId);
    }
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
  }
}
