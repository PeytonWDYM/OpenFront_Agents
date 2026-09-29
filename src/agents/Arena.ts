import { z, ZodError } from "zod";
import { CodexRuntime, type GameToolResult } from "./codex/index";
import { tokenUsage } from "./codex/protocol";
import { EventLog } from "./EventLog";
import { ActionDecision, ActionLimitError } from "./game/actionBatch";
import {
  AgentGame,
  isUrgentAgentEvent,
  projectDecisionObservation,
} from "./game/index";
import { NukePreviewRequestSchema } from "./game/nukePreview";
import type { AgentGameEvent } from "./game/schemas";
import {
  agentActionToolSchema,
  ObserveQuerySchema,
  quickChatKeys,
} from "./game/schemas";
import { OPENCODE_TURN_TIMEOUT_MS, OpenCodeRuntime } from "./opencode/index";
import { playerPrompt } from "./PlayerPrompt";
import { scriptedAction } from "./ScriptedPlayer";
import { ArenaSettingsSchema, defaultSettings } from "./Settings";
import { TurnQueue } from "./TurnQueue";
import type { AgentPlayer, ArenaJoin, ArenaSnapshot } from "./types";

export const ObserveWorldQuerySchema = ObserveQuerySchema.extend({
  quickChatKeys: z.boolean().optional(),
  image: z
    .boolean()
    .optional()
    .describe("Return a map image of the requested region."),
  nukePreview: NukePreviewRequestSchema.optional().describe(
    "Preview an atom or hydrogen bomb trajectory, blast, and SAM coverage risk. Returns an image.",
  ),
  playerId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Focus an image on this native player's current public territory. Do not combine with coordinates or nukePreview. Private sections still describe you.",
    ),
}).refine(
  (query) =>
    query.playerId === undefined ||
    (query.nukePreview === undefined &&
      query.x === undefined &&
      query.y === undefined &&
      query.width === undefined &&
      query.height === undefined),
  {
    message:
      "Choose playerId focus, a coordinate region, or nukePreview. These view selectors cannot be combined.",
  },
);
export const ThinkQuerySchema = z
  .object({
    note: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe(
        "Brief strategy summary. Record a goal or next step, not detailed reasoning.",
      ),
    observe: ObserveWorldQuerySchema.optional(),
  })
  .strict();
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Stall-style OpenCode turn failures skip one decision instead of halting. */
export function isSkippableTurnError(text: string, mode: string): boolean {
  return (
    mode === "opencode" &&
    /four-minute ceiling|exit null|timed out|interrupt|abort/i.test(text)
  );
}

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
  private runtime: CodexRuntime | OpenCodeRuntime | null = null;
  private queue: TurnQueue | null = null;
  private logs = new EventLog();
  private readonly suppliedTicks = new Map<string, number>();
  private readonly requestedDelays = new Map<string, number>();
  private readonly calls = new Map<string, number>();
  private readonly invalidActions = new Map<string, number>();
  private readonly actions = new Map<string, ActionDecision>();
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
      } else if (settings.mode === "opencode") {
        this.runtime = new OpenCodeRuntime();
        this.state.runtime = await this.runtime.initialize();
        if (!this.state.runtime.authenticated)
          throw new Error(
            "OpenCode authentication is required. Run opencode auth login first.",
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
                    "Read current own resources, victory progress, public leaderboard, trade traffic, map and unit levels, native legality, costs, and communication choices. Select sections or a region. Request image or nukePreview for a focused map.",
                  inputSchema: z.toJSONSchema(ObserveWorldQuerySchema),
                },
                {
                  name: "think",
                  description:
                    "Record a brief strategy note before costly naval, nuclear, or diplomatic choices. Optionally request a focused observation with the same privacy rules as observe_world. Uses one tool call. Does not submit actions. Act directly for routine decisions to save usage.",
                  inputSchema: z.toJSONSchema(ThinkQuerySchema),
                },
                {
                  name: "act",
                  description:
                    "Submit one intent or 1..2 intents in order with native IDs. Each intent uses the two-action budget. Set attackRatio or nextDecisionSeconds when needed. Submissions are not atomic and do not guarantee execution.",
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
      // OpenCode matches Codex concurrency; slow free-pool turns set the
      // pace per agent, and the queue still defaults each agent to a
      // decision every ten seconds once its turn completes.
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

  private async tool(
    id: string,
    name: string,
    args: unknown,
  ): Promise<GameToolResult> {
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
    let observationQuery: z.infer<typeof ObserveWorldQuerySchema> | undefined;
    if (name === "think") {
      const { note, observe } = ThinkQuerySchema.parse(args);
      this.logs.add(id, "think", note);
      if (observe === undefined) return { data: { recorded: true } };
      observationQuery = observe;
    } else if (name === "observe_world") {
      observationQuery = ObserveWorldQuerySchema.parse(args);
    }
    if (observationQuery !== undefined) {
      const {
        quickChatKeys: includeQuickChatKeys,
        image,
        nukePreview,
        playerId,
        ...region
      } = observationQuery;
      const focus =
        playerId !== undefined
          ? this.game!.playerFocus(id, playerId)
          : undefined;
      const observation = this.game!.observe(
        id,
        focus ? { ...region, ...focus.region } : region,
      );
      this.logs.add(
        id,
        "observe",
        `World observation at tick ${observation.tick}.`,
      );
      const sections =
        region.sections ??
        (focus !== undefined ||
        region.x !== undefined ||
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
      const projected =
        focus && region.sections === undefined
          ? {
              gameId: observation.gameId,
              tick: observation.tick,
              spawnPhase: observation.spawnPhase,
              map: {
                width: observation.map.width,
                height: observation.map.height,
                region: focus.region,
              },
            }
          : projectDecisionObservation(observation, sections);
      const data = includeQuickChatKeys
        ? {
            ...projected,
            ...(focus ? { target: focus.target } : {}),
            quickChatKeys,
          }
        : { ...projected, ...(focus ? { target: focus.target } : {}) };
      if (!image && !nukePreview && !focus) return { data };
      const { x, y, width, height } = observation.map.region;
      const preview = nukePreview
        ? await this.game!.visionNukePreview(id, nukePreview)
        : undefined;
      const frame = preview
        ? preview.frame
        : await this.game!.visionRegion(id, { x, y, width, height });
      this.logs.add(
        id,
        "vision",
        `Requested map region at tick ${observation.tick}.`,
        {
          tick: observation.tick,
          region: frame.region,
          mapPixels: frame.mapPixels,
        },
        frame.url,
      );
      return {
        data: {
          ...data,
          ...(preview ? { nukePreview: preview.metadata } : {}),
          image: {
            tick: observation.tick,
            width: frame.width,
            height: frame.height,
            region: frame.region,
            mapPixels: frame.mapPixels,
          },
        },
        images: [frame],
      };
    }
    if (name !== "act") throw new Error("Unknown game tool.");
    try {
      const result = await this.actions.get(id)!.submit(
        args,
        async (intent, attackRatio) => {
          const result = await this.game!.act(id, intent, attackRatio);
          const player = this.player(id);
          player.lastAction = JSON.stringify(result.intent);
          this.logs.add(id, "action", `Submitted ${player.lastAction}`, result);
          return result;
        },
        (nextDecisionSeconds) => {
          this.requestedDelays.set(id, nextDecisionSeconds * 1_000);
          this.logs.add(
            id,
            "schedule",
            `Requested the next decision in ${nextDecisionSeconds} seconds.`,
          );
        },
      );
      return { data: result };
    } catch (error) {
      if (error instanceof ActionLimitError) {
        this.halted.add(id);
        const player = this.player(id);
        if (player.threadId)
          void this.runtime!.interrupt(player.threadId).catch(() => {});
      }
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
          "Invalid act arguments. Supply intent or 1..2 intents, nextDecisionSeconds from 1 to 10, or both. attackRatio requires actions.",
        ),
        { cause: error },
      );
    }
  }

  private async decide(id: string) {
    if (this.state.phase !== "running") return;
    this.syncPlayers();
    const player = this.player(id);
    if (!player.alive) return;
    this.halted.delete(id);
    this.calls.set(id, 0);
    this.invalidActions.set(id, 0);
    this.actions.set(id, new ActionDecision());
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
        timeout = setTimeout(
          () => {
            this.halted.add(id);
            this.logs.add(
              id,
              "limit",
              "The decision time limit ended this turn.",
            );
            void this.runtime!.interrupt(player.threadId!).catch(() => {});
          },
          this.state.settings.mode === "opencode"
            ? OPENCODE_TURN_TIMEOUT_MS
            : 90_000,
        );
        await this.runtime!.turn(
          player.threadId!,
          `Use this current state and map. The offense summary shows legal attacks, landings, and affordable missiles alongside construction options; weigh them against expansion and defense, keeping in mind that idle economy tends to lose ground to expanding rivals. Choose useful actions: ${text}`,
          frames,
        );
      }
      player.decisions++;
      this.logs.add(id, "decision", `Decision ${player.decisions} completed.`);
      return this.requestedDelays.get(id);
    } catch (error) {
      if (this.state.phase === "running") {
        // A stalled free-pool turn is routine, not fatal: skip it and let
        // the queue schedule the next decision instead of halting the match.
        if (isSkippableTurnError(message(error), this.state.settings.mode)) {
          this.logs.add(id, "decision", `Skipped: ${message(error)}`);
          return;
        }
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
    if (event.type !== "tokens") return;
    const { totalTokens, ...usage } =
      tokenUsage.shape.tokenUsage.shape.total.parse(event);
    const delta = Math.max(0, totalTokens - player.tokens);
    player.tokens += delta;
    player.tokenUsage = usage;
    this.state.totalTokens += delta;
    this.state.tokenUsage = this.state.players.reduce(
      (combined, seat) => {
        if (seat.tokenUsage) {
          for (const key of Object.keys(combined) as (keyof typeof combined)[])
            combined[key] += seat.tokenUsage[key];
        }
        return combined;
      },
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    );
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
