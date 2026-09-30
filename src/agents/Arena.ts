import { z } from "zod";
import { CodexRuntime, type GameToolResult } from "./codex/index";
import { tokenUsage } from "./codex/protocol";
import { EventLog } from "./EventLog";
import { submitActions } from "./game/actionBatch";
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
import { playerPrompt } from "./PlayerPrompt";
import { getAgentReasoningEffort } from "./Reasoning";
import { scriptedAction } from "./ScriptedPlayer";
import { ArenaSettingsSchema, defaultSettings } from "./Settings";
import { TurnQueue } from "./TurnQueue";
import type { AgentPlayer, ArenaJoin, ArenaSnapshot } from "./types";
import type { MapImage } from "./vision";
import { VisionOverlaySchema } from "./vision/options";

function imageMetadata(frame: MapImage, tick: number) {
  return {
    tick,
    width: frame.width,
    height: frame.height,
    region: frame.region,
    mapPixels: frame.mapPixels,
    overlays: frame.overlays,
    players: frame.players,
    units: frame.units,
    unitCount: frame.unitCount,
  };
}

export const ObserveWorldQuerySchema = ObserveQuerySchema.extend({
  quickChatKeys: z.boolean().optional(),
  image: z
    .boolean()
    .optional()
    .describe("Return a map image of the requested region."),
  overlays: VisionOverlaySchema.optional(),
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
  private readonly strategyNotes = new Map<string, string>();
  private readonly decisionSummaries = new Map<string, string>();
  private readonly overviewAt = new Map<string, number>();
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
    this.strategyNotes.clear();
    this.decisionSummaries.clear();
    this.overviewAt.clear();
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
        mediumAgentCount: settings.mediumAgentCount,
        tribeCount: settings.tribeCount,
        nationCount: settings.nationCount,
        onEvent: (event) => this.gameEvent(event),
      });
      const lobby = await this.game.create();
      this.state.gameId = lobby.gameId;
      this.state.players = this.game.players().map((player, index) => ({
        id: player.id,
        clientId: player.clientId,
        name: player.name,
        reasoningEffort: getAgentReasoningEffort(
          index,
          settings.mediumAgentCount,
        ),
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
              reasoningEffort: player.reasoningEffort,
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
                    "Save a brief plan for later decisions. Optionally request a focused observation. Does not submit actions. Act directly for routine decisions.",
                  inputSchema: z.toJSONSchema(ThinkQuerySchema),
                },
                {
                  name: "act",
                  description:
                    "Submit one intent or a batch of intents in order with native IDs. Batch independent legal actions to reduce tool overhead. Set attackRatio or nextDecisionSeconds when needed. Submissions are not atomic and do not guarantee execution.",
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
    let observationQuery: z.infer<typeof ObserveWorldQuerySchema> | undefined;
    if (name === "think") {
      const { note, observe } = ThinkQuerySchema.parse(args);
      this.strategyNotes.set(id, note);
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
        overlays,
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
        region.buildType !== undefined ||
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
        : await this.game!.visionRegion(id, { x, y, width, height }, overlays);
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
          image: imageMetadata(frame, observation.tick),
        },
        images: [frame],
      };
    }
    if (name !== "act") throw new Error("Unknown game tool.");
    try {
      const result = await submitActions(
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
      if ("results" in result)
        for (const submitted of result.results!)
          if (!submitted.accepted)
            this.logs.add(
              id,
              "tool_error",
              `${submitted.intent.type}: ${submitted.error}`,
            );
      return { data: result };
    } catch (error) {
      const text =
        error instanceof z.ZodError
          ? error.issues
              .slice(0, 3)
              .map(
                (issue) =>
                  `${issue.path.map(String).join(".") || "act"}: ${issue.message}`,
              )
              .join(". ")
          : message(error);
      this.logs.add(id, "tool_error", text);
      throw Object.assign(new Error(text), { cause: error });
    }
  }

  private async decide(id: string) {
    if (this.state.phase !== "running") return;
    this.syncPlayers();
    const player = this.player(id);
    if (!player.alive) return;
    this.halted.delete(id);
    player.status = "thinking";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const observation = this.game!.observe(id);
      if (observation.spawnPhase) {
        player.status = "waiting";
        return 500;
      }
      const decisionFeedback = this.game!.decisionFeedback(id);
      if (this.state.settings.mode === "scripted") {
        const action = scriptedAction(observation);
        if (!action) return 500;
        await this.tool(id, "act", { intent: action });
      } else {
        const vision = await this.game!.vision(id);
        if (this.state.phase !== "running" || this.halted.has(id)) return;
        const includeOverview =
          !vision.tactical ||
          Date.now() - (this.overviewAt.get(id) ?? -Infinity) >= 60_000;
        const frames = [
          ...(includeOverview ? [vision.overview] : []),
          ...(vision.tactical ? [vision.tactical] : []),
        ];
        if (includeOverview) this.overviewAt.set(id, Date.now());
        for (const [index, frame] of frames.entries())
          this.logs.add(
            id,
            "vision",
            `${includeOverview && index === 0 ? "Overview" : "Tactical"} map at tick ${vision.tick}.`,
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
          decisionFeedback,
          ...(this.decisionSummaries.has(id)
            ? { previousDecisionSummary: this.decisionSummaries.get(id) }
            : {}),
          ...(this.strategyNotes.has(id)
            ? { strategyNote: this.strategyNotes.get(id) }
            : {}),
          images: frames.map((frame) => imageMetadata(frame, vision.tick)),
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
          `Current game state and your previous decision summary follow. Choose your next actions: ${text}`,
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
    if (event.method === "item/completed") {
      const finalMessage = z
        .object({
          item: z.object({
            type: z.literal("agentMessage"),
            phase: z.literal("final_answer"),
            text: z.string(),
          }),
        })
        .safeParse(event.params);
      if (finalMessage.success)
        this.decisionSummaries.set(
          player.id,
          finalMessage.data.item.text.slice(0, 600),
        );
    }
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
