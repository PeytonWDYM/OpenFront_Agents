import { z } from "zod";
import { UnitType } from "../core/game/Game";
import { CodexRuntime, type GameToolResult } from "./codex/index";
import { tokenUsage } from "./codex/protocol";
import { recoveryAction, type RecoveryAction } from "./codex/recovery";
import { EventLog } from "./EventLog";
import { submitActions } from "./game/actionBatch";
import { matchSettingsPrompt } from "./game/config";
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
import type { MapImage, Region } from "./vision";
import { portBuildSiteRegion } from "./vision/buildSites";
import { VisionOverlaySchema, VisionResolutionSchema } from "./vision/options";

function imageMetadata(frame: MapImage, tick: number) {
  return {
    tick,
    width: frame.width,
    height: frame.height,
    resolution: frame.resolution,
    region: frame.region,
    mapPixels: frame.mapPixels,
    overlays: frame.overlays,
    players: frame.players,
    units: frame.units,
    unitCount: frame.unitCount,
    unitGroups: frame.unitGroups,
    unitGroupCount: frame.unitGroupCount,
    ...(frame.buildSites ? { buildSites: frame.buildSites } : {}),
    ...(frame.tradeHeatmap ? { tradeHeatmap: frame.tradeHeatmap } : {}),
  };
}

export const ObserveWorldQuerySchema = ObserveQuerySchema.extend({
  quickChatKeys: z.boolean().optional(),
  tradeHeatmap: z
    .boolean()
    .optional()
    .describe(
      "Current public ship density, piracy eligibility, and patrols. Returns data and an image. Off by default.",
    ),
  image: z
    .boolean()
    .optional()
    .describe("Return a map image of the requested region."),
  overlays: VisionOverlaySchema.optional(),
  resolution: VisionResolutionSchema.optional().describe(
    "Map image detail preset. Defaults to high.",
  ),
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
})
  .refine(
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
  )
  .refine((query) => !query.tradeHeatmap || query.nukePreview === undefined, {
    message: "Choose tradeHeatmap or nukePreview for the requested image.",
  });
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
const RECOVERY_DELAY_MS = 10_000;
const MAX_RECOVERY_ATTEMPTS = 3;
type PendingRecovery = {
  action: Extract<RecoveryAction, "retry" | "replace">;
  nextAt: number;
};

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
  private readonly recoveries = new Map<string, PendingRecovery>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly resumableFailures = new Set<string>();
  private readonly threadUsage = new Map<
    string,
    z.infer<typeof tokenUsage>["tokenUsage"]["total"]
  >();

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
    this.recoveries.clear();
    this.recoveryAttempts.clear();
    this.resumableFailures.clear();
    this.threadUsage.clear();
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
        ...settings,
        onEvent: (event) => this.gameEvent(event),
      });
      const lobby = await this.game.create();
      this.state.settings = { ...settings, gameMap: this.game.config.gameMap };
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
          const prompt =
            matchSettingsPrompt(this.game.config) + playerPrompt(player.name);
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
                    "Read resources, military readiness, victory, public players, native legality, costs, and communication. Select sections or a region. Request image, tradeHeatmap, or nukePreview for a map.",
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
            (name, args, isActive) =>
              this.tool(player.id, name, args, isActive),
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
          (!this.player(id).error || this.recoveries.has(id)),
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
    if (this.state.runtime.error)
      throw new Error(
        "The Codex runtime is unavailable. Stop the arena and create a new lobby.",
      );
    for (const player of this.state.players) {
      if (
        player.error &&
        !this.recoveries.has(player.id) &&
        !this.resumableFailures.has(player.id) &&
        ["placement", "waiting", "review"].includes(
          this.game!.spawnReview(player.id).stage,
        )
      )
        throw new Error(
          this.state.error ??
            `${player.name} cannot complete spawn readiness: ${player.error}`,
        );
    }
    this.state.phase = "running";
    delete this.state.error;
    for (const player of this.state.players) {
      const recovery = this.recoveries.get(player.id);
      if (recovery) recovery.nextAt = Date.now() + RECOVERY_DELAY_MS;
      if (this.resumableFailures.delete(player.id)) {
        delete player.error;
        player.status = "ready";
      }
    }
    this.queue!.start();
    return this.snapshot();
  }

  async stop() {
    this.halt("stopped");
    this.recoveries.clear();
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
        this.recoveries.delete(player.id);
        if (this.runtime && player.threadId)
          void this.runtime.interrupt(player.threadId).catch(() => {});
      }
    }
  }

  private async tool(
    id: string,
    name: string,
    args: unknown,
    isActive?: () => boolean,
  ): Promise<GameToolResult> {
    const requireActive = () => {
      if (
        this.state.phase !== "running" ||
        this.halted.has(id) ||
        !this.player(id).alive ||
        (isActive && !isActive())
      )
        throw new Error("This player's decisions have stopped.");
    };
    requireActive();
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
        resolution,
        nukePreview,
        playerId,
        tradeHeatmap,
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
        (tradeHeatmap === true ||
        focus !== undefined ||
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
      const data = {
        ...(includeQuickChatKeys
          ? {
              ...projected,
              ...(focus ? { target: focus.target } : {}),
              quickChatKeys,
            }
          : { ...projected, ...(focus ? { target: focus.target } : {}) }),
        ...(observation.spawnPhase
          ? { spawnReview: this.game!.spawnReview(id) }
          : {}),
      };
      if (!image && !nukePreview && !focus && !tradeHeatmap) return { data };
      const portSites =
        region.buildType === UnitType.Port
          ? observation.map.buildSites
          : undefined;
      let imageRegion: Region = observation.map.region;
      if (
        portSites?.length &&
        !focus &&
        region.x === undefined &&
        region.y === undefined &&
        region.width === undefined &&
        region.height === undefined
      ) {
        imageRegion = portBuildSiteRegion(
          portSites,
          observation.map.width,
          observation.map.height,
        );
      }
      const preview = nukePreview
        ? await this.game!.visionNukePreview(id, nukePreview, resolution)
        : undefined;
      const heatmap = tradeHeatmap
        ? await this.game!.visionTradeHeatmap(
            id,
            focus !== undefined ||
              region.x !== undefined ||
              region.y !== undefined ||
              region.width !== undefined ||
              region.height !== undefined
              ? imageRegion
              : undefined,
            overlays,
            resolution,
          )
        : undefined;
      const frame = heatmap
        ? heatmap.frame
        : preview
          ? preview.frame
          : await this.game!.visionRegion(
              id,
              imageRegion,
              overlays,
              portSites,
              resolution,
            );
      requireActive();
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
          ...(heatmap ? { tradeHeatmap: heatmap.metadata } : {}),
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
          requireActive();
          const result = await this.game!.act(id, intent, attackRatio);
          requireActive();
          const player = this.player(id);
          player.lastAction = JSON.stringify(result.intent);
          this.logs.add(id, "action", `Submitted ${player.lastAction}`, result);
          return result;
        },
        (nextDecisionSeconds) => {
          requireActive();
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
    const recovery = this.recoveries.get(id);
    if (player.error && !recovery) return;
    if (recovery && recovery.nextAt > Date.now())
      return recovery.nextAt - Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reviewTurn = false;
    let completed = false;
    try {
      if (recovery) {
        this.logs.add(
          id,
          "recovery",
          `Recovery attempt ${this.recoveryAttempts.get(id)} of ${MAX_RECOVERY_ATTEMPTS}.`,
        );
        if (recovery.action === "replace") {
          player.threadId = await this.runtime!.replacePlayer(player.threadId!);
          recovery.action = "retry";
          this.logs.add(id, "thread", player.threadId);
          this.suppliedTicks.delete(id);
          this.overviewAt.delete(id);
        }
        if (this.state.phase !== "running" || !player.alive) return;
        this.recoveries.delete(id);
        delete player.error;
      }
      this.halted.delete(id);
      player.status = "thinking";
      const observation = this.game!.observe(id);
      const spawnReview = this.game!.spawnReview(id);
      if (
        observation.spawnPhase &&
        (this.game!.config.randomSpawn ||
          spawnReview.stage === "waiting" ||
          spawnReview.stage === "confirmed")
      ) {
        player.status = "waiting";
        return 500;
      }
      reviewTurn = spawnReview.stage === "review";
      const decisionFeedback = this.game!.decisionFeedback(id);
      if (this.state.settings.mode === "scripted") {
        if (!reviewTurn) {
          const action = scriptedAction(observation);
          if (!action) return 500;
          await this.tool(id, "act", { intent: action });
        }
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
          ...(observation.spawnPhase ? { spawnReview } : {}),
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
          observation.spawnPhase
            ? reviewTurn
              ? `Every agent now has a valid placement. Review the current map and neighbors. Keep your current location or submit up to two spawn relocations during this turn. You may choose any legal tile. Suggestions are not exhaustive. This turn's end confirms your latest valid placement. The countdown starts after every agent finishes review. Current game state: ${text}`
              : `Choose any legal spawn tile and submit a spawn intent. spawnCandidates are geographic suggestions, not an exhaustive list. You will have one review turn after all agents place a spawn, with up to two optional relocations. Current game state: ${text}`
            : `Current game state and your previous decision summary follow. Choose your next actions: ${text}`,
          frames,
        );
      }
      player.decisions++;
      completed = true;
      this.recoveryAttempts.delete(id);
      this.logs.add(id, "decision", `Decision ${player.decisions} completed.`);
      return this.requestedDelays.get(id);
    } catch (error) {
      if (this.state.phase === "running" && player.alive) {
        player.error = message(error);
        this.logs.add(id, "error", player.error);
        this.halted.add(id);
        const action = recoveryAction(error);
        const attempts = (this.recoveryAttempts.get(id) ?? 0) + 1;
        if (
          (action === "retry" || action === "replace") &&
          attempts <= MAX_RECOVERY_ATTEMPTS
        ) {
          this.recoveryAttempts.set(id, attempts);
          // A failed replacement still needs a new session on its next attempt.
          this.recoveries.set(id, {
            action: recovery?.action === "replace" ? "replace" : action,
            nextAt: Date.now() + RECOVERY_DELAY_MS,
          });
          this.logs.add(
            id,
            "recovery",
            "This agent will recover in 10 seconds.",
          );
          return RECOVERY_DELAY_MS;
        }
        this.recoveries.delete(id);
        this.logs.add(
          id,
          "recovery",
          attempts > MAX_RECOVERY_ATTEMPTS
            ? "Recovery stopped after three attempts."
            : "Automatic recovery is unavailable for this error.",
        );
        if (action === "pause") {
          this.resumableFailures.add(id);
          this.state.error = player.error;
          this.halt("paused");
          void this.interruptActive();
        } else {
          const stage = this.game!.spawnReview(id).stage;
          if (
            stage === "placement" ||
            stage === "waiting" ||
            stage === "review"
          ) {
            this.state.error = `${player.name} cannot complete spawn ${stage}: ${player.error}`;
            this.halt("paused");
            void this.interruptActive();
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      if (reviewTurn && completed && this.state.phase === "running")
        this.game!.confirmSpawn(id);
      this.requestedDelays.delete(id);
      if (player.alive)
        player.status = this.recoveries.has(id)
          ? "recovering"
          : player.error
            ? "error"
            : "ready";
    }
  }

  private runtimeEvent(player: AgentPlayer, event: Record<string, unknown>) {
    if (
      event.type === "runtime_error" &&
      (this.state.phase === "running" || this.state.phase === "paused")
    ) {
      player.error = String(event.message);
      player.status = "error";
      this.recoveries.clear();
      this.state.error = String(event.message);
      this.state.runtime.error = this.state.error;
      this.halt("paused");
      void this.interruptActive();
    }
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
    const threadId =
      typeof event.threadId === "string" ? event.threadId : player.threadId!;
    const previous = this.threadUsage.get(threadId);
    const delta = Math.max(0, totalTokens - (previous?.totalTokens ?? 0));
    this.threadUsage.set(threadId, { totalTokens, ...usage });
    player.tokens += delta;
    player.tokenUsage ??= {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    for (const key of Object.keys(usage) as (keyof typeof usage)[])
      player.tokenUsage[key] += Math.max(
        0,
        usage[key] - (previous?.[key] ?? 0),
      );
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
