import { z } from "zod";
import { createGameRunner, GameRunner } from "../../core/GameRunner";
import {
  GameInfoSchema,
  GameStartInfo,
  ServerMessage,
  Turn,
} from "../../core/Schemas";
import {
  Game,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
  PlayerBuildable,
  UnitType,
} from "../../core/game/Game";
import {
  ErrorUpdate,
  GameUpdateType,
  GameUpdateViewData,
} from "../../core/game/GameUpdates";
import { getAgentReasoningEffort } from "../Reasoning";
import { MapImages, playerTerritoryRegion } from "../vision";
import { VisionOverlays } from "../vision/options";
import { LocalMapLoader } from "./LocalMapLoader";
import { PlayerSocket } from "./PlayerSocket";
import { projectDecisionObservation } from "./decision";
import { playerEvents } from "./events";
import { DecisionFeedback } from "./feedback";
import { assertAgentNuclearTarget } from "./nuclearTargeting";
import { buildNukePreview, NukePreviewRequest } from "./nukePreview";
import { ObservationBuilder } from "./observation";
import {
  AgentActionSchema,
  AgentEvent,
  AgentGameEvent,
  AgentPlayer,
  AttackRatioSchema,
  ObserveQuery,
  ObserveQuerySchema,
} from "./schemas";

const ADMIN_KEY = "WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION";
// Structure builds grow economy or defense. Weapon builds (nukes, warships)
// and attacks/landings count as offense and reset the build streak.
const STRUCTURE_UNITS: ReadonlySet<string> = new Set([
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
]);
/** A structure build or upgrade without an accompanying attack. */
export function isStructureBuild(intent: { type: string }): boolean {
  if (intent.type === "upgrade_structure") return true;
  return (
    intent.type === "build_unit" &&
    "unit" in intent &&
    typeof (intent as { unit: unknown }).unit === "string" &&
    STRUCTURE_UNITS.has((intent as { unit: string }).unit)
  );
}
/** An attack, landing, or weapon launch. Resets the build streak. */
export function isOffenseIntent(intent: { type: string }): boolean {
  if (intent.type === "attack" || intent.type === "boat") return true;
  return (
    intent.type === "build_unit" &&
    "unit" in intent &&
    typeof (intent as { unit: unknown }).unit === "string" &&
    !STRUCTURE_UNITS.has((intent as { unit: string }).unit)
  );
}
/** Resolve a native ID and public territory without reading the target's resources. */
export function publicPlayerFocus(
  game: Game,
  viewer: Player,
  playerId: string,
) {
  if (!game.hasPlayer(playerId))
    throw new Error(`Unknown player ID: ${playerId}`);
  const target = game.player(playerId);
  const region = playerTerritoryRegion(game, target);
  if (!region) throw new Error("The requested player has no owned territory.");
  return {
    region,
    target: {
      playerId: target.id(),
      name: target.displayName(),
      playerType: target.type(),
      smallId: target.smallID(),
      tiles: target.numTilesOwned(),
      alive: target.isAlive(),
      allied: viewer.isAlliedWith(target),
      teammate: viewer.isOnSameTeam(target),
    },
  };
}
const LobbyResponseSchema = z.object({
  gameID: z.string(),
  workerIndex: z.number().int().min(0).max(1),
});

export interface AgentGameOptions {
  agentCount: number;
  mediumAgentCount?: number;
  tribeCount?: number;
  nationCount?: number;
  map?: GameMapType;
  randomSpawn?: boolean;
  onEvent?: (event: AgentGameEvent) => void;
}

/** A private local lobby with normal player sockets and one native simulation mirror. */
export class AgentGame {
  private seats: PlayerSocket[] = [];
  private runner?: GameRunner;
  private observations?: ObservationBuilder;
  private feedback?: DecisionFeedback;
  private histories = new Map<string, AgentEvent[]>();
  private incomingAttacks = new Map<string, Set<string>>();
  private attackRatios = new Map<string, number>();
  private buildStreaks = new Map<string, number>();
  private mapImages?: MapImages;
  private gameId_ = "";
  private workerId = 0;
  private gameStart_?: GameStartInfo;
  private nextExpectedTurn = 0;
  private processing = Promise.resolve();
  private failure?: Error;
  private closed = false;

  constructor(private options: AgentGameOptions) {
    z.number().int().min(1).max(400).parse(options.agentCount);
    z.number()
      .int()
      .min(0)
      .max(options.agentCount)
      .parse(options.mediumAgentCount ?? 0);
    z.number()
      .int()
      .min(0)
      .max(400)
      .parse(options.tribeCount ?? 100);
    z.number()
      .int()
      .min(0)
      .max(400)
      .parse(options.nationCount ?? 52);
  }

  get gameId(): string {
    return this.gameId_;
  }
  get gameStart(): GameStartInfo | undefined {
    return this.gameStart_;
  }

  private async admin(path: string, body: unknown): Promise<unknown> {
    const port = this.gameId_ ? 3001 + this.workerId : 9000;
    const response = await fetch(`http://localhost:${port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-bot-key": ADMIN_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        `Local lobby request failed (${response.status}): ${await response.text()}`,
      );
    return response.json();
  }

  async create(): Promise<{ gameId: string; workerId: number }> {
    if (this.gameId_) throw new Error("The agent lobby already exists");
    const nationCount = this.options.nationCount ?? 52;
    const lobby = LobbyResponseSchema.parse(
      await this.admin("/api/adminbot/create_game", {
        gameMap: this.options.map ?? GameMapType.Europe,
        gameMapSize: GameMapSize.Compact,
        gameType: GameType.Private,
        gameMode: GameMode.FFA,
        bots: this.options.tribeCount ?? 100,
        nations: nationCount === 0 ? "disabled" : nationCount,
        randomSpawn: this.options.randomSpawn ?? true,
        donateGold: true,
        donateTroops: true,
      }),
    );
    this.gameId_ = lobby.gameID;
    this.mapImages = new MapImages(this.gameId_);
    this.workerId = lobby.workerIndex;
    for (let index = 0; index < this.options.agentCount; index++) {
      const id = `agent${String(index + 1).padStart(3, "0")}`;
      const reasoningEffort = getAgentReasoningEffort(
        index,
        this.options.mediumAgentCount ?? 0,
      );
      const seat = new PlayerSocket(
        id,
        `Agent ${index + 1} - ${reasoningEffort}`,
        this.workerId,
      );
      this.seats.push(seat);
      this.histories.set(id, []);
      this.incomingAttacks.set(id, new Set());
      this.attackRatios.set(id, 0.2);
      this.buildStreaks.set(id, 0);
    }
    await Promise.all(
      this.seats.map((seat, index) =>
        seat.join(
          this.gameId_,
          (message) => {
            // Only one connection supplies turns. Other connections seed their own wire tables.
            if (index === 0)
              this.processing = this.processing
                .then(() => this.receive(message))
                .catch((error: unknown) => this.fail(error));
          },
          (error) => this.fail(error),
        ),
      ),
    );
    this.options.onEvent?.({
      type: "lobby_created",
      tick: 0,
      at: Date.now(),
      data: { gameId: this.gameId_, workerId: this.workerId },
    });
    return { gameId: this.gameId_, workerId: this.workerId };
  }

  async validateJoin(join: {
    clientId: string;
    spectator: boolean;
  }): Promise<void> {
    if (!this.gameId_)
      throw new Error("Create the lobby before starting the game");
    const response = await fetch(
      `http://localhost:${3001 + this.workerId}/api/game/${this.gameId_}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok)
      throw new Error(`Native lobby lookup failed (${response.status})`);
    const lobby = GameInfoSchema.parse(await response.json());
    const client = lobby.clients?.find(
      (client) => client.clientID === join.clientId,
    );
    if (!client || (client.spectator ?? false) !== join.spectator)
      throw new Error(
        "The player has not joined the native lobby with the selected role",
      );
  }

  async start(): Promise<void> {
    if (!this.gameId_)
      throw new Error("Create the lobby before starting the game");
    await this.admin(`/api/adminbot/game/${this.gameId_}/intent`, {
      type: "toggle_game_start_timer",
    });
    const deadline = Date.now() + 30_000;
    while (!this.runner) {
      this.checkFailure();
      if (Date.now() >= deadline)
        throw new Error("The native game did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.checkFailure();
  }

  private async receive(message: ServerMessage): Promise<void> {
    if (this.failure || this.closed) return;
    if (message.type === "start") {
      if (this.runner)
        throw new Error("Unexpected duplicate native start message");
      this.gameStart_ = message.gameStartInfo;
      this.runner = await createGameRunner(
        message.gameStartInfo,
        undefined,
        new LocalMapLoader(),
        (update) => this.update(update),
      );
      this.observations = new ObservationBuilder(this.runner.game);
      this.feedback = new DecisionFeedback(this.runner.game);
      for (const turn of message.turns) this.applyTurn(turn);
      this.options.onEvent?.({
        type: "game_started",
        tick: this.runner.game.ticks(),
        at: Date.now(),
        data: { gameId: this.gameId_ },
      });
    } else if (message.type === "turn") {
      this.applyTurn(message.turn);
    } else if (message.type === "desync") {
      throw new Error(`Native mirror desynced at turn ${message.turn}`);
    }
  }

  private applyTurn(turn: Turn): void {
    if (!this.runner)
      throw new Error("A native turn arrived before game start");
    if (turn.turnNumber < this.nextExpectedTurn) return;
    if (turn.turnNumber !== this.nextExpectedTurn)
      throw new Error(
        `Native turn gap: expected ${this.nextExpectedTurn}, received ${turn.turnNumber}`,
      );
    this.runner.addTurn(turn);
    if (!this.runner.executeNextTick())
      throw new Error(`Native turn ${turn.turnNumber} failed`);
    this.nextExpectedTurn++;
  }

  private update(update: GameUpdateViewData | ErrorUpdate): void {
    if ("errMsg" in update) {
      this.fail(new Error(update.errMsg));
      return;
    }
    const game = this.runner!.game;
    this.observations!.recordIncome();
    for (const seat of this.seats) {
      const player = game.playerByClientID(seat.clientId);
      if (!player) continue;
      const events = playerEvents(
        game,
        player,
        update.updates,
        this.incomingAttacks.get(seat.id)!,
      );
      this.feedback!.recordEvents(player, events);
      const history = this.histories.get(seat.id)!;
      history.push(...events);
      this.histories.set(
        seat.id,
        history.filter((event) => event.at >= Date.now() - 60_000).slice(-128),
      );
      for (const event of events)
        this.options.onEvent?.({ ...event, agentId: seat.id });
    }
    for (const hash of update.updates[GameUpdateType.Hash]) {
      for (const seat of this.seats)
        seat.send({ type: "hash", hash: hash.hash, turnNumber: hash.tick });
    }
    for (const winner of update.updates[GameUpdateType.Win]) {
      // The server records normal winner reports from each participating client.
      for (const seat of this.seats)
        seat.send({
          type: "winner",
          winner: winner.winner,
          allPlayersStats: winner.allPlayersStats,
        });
      this.options.onEvent?.({
        type: "win",
        tick: game.ticks(),
        at: Date.now(),
        data: { winner: winner.winner },
      });
    }
  }

  private fail(error: unknown): void {
    if (this.closed || this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.options.onEvent?.({
      type: "error",
      tick: this.runner?.game.ticks() ?? 0,
      at: Date.now(),
      data: { message: this.failure.message },
    });
  }
  private checkFailure(): void {
    if (this.closed) throw new Error("The agent game is closed");
    if (this.failure) throw this.failure;
  }
  private seat(agentId: string): PlayerSocket {
    const seat = this.seats.find((seat) => seat.id === agentId);
    if (!seat) throw new Error(`Unknown agent ${agentId}`);
    return seat;
  }
  private player(agentId: string): Player {
    this.checkFailure();
    if (!this.runner) throw new Error("The native game has not started");
    return this.runner.game.playerByClientID(this.seat(agentId).clientId)!;
  }

  observe(agentId: string, query: ObserveQuery = {}) {
    const player = this.player(agentId);
    const observation = this.observations!.observe(
      agentId,
      player,
      this.seats.indexOf(this.seat(agentId)),
      ObserveQuerySchema.parse(query),
      this.histories.get(agentId)!,
      this.attackRatios.get(agentId)!,
      this.buildStreaks.get(agentId) ?? 0,
    );
    observation.gameId = this.gameId_;
    return observation;
  }

  decisionObservation(agentId: string) {
    return projectDecisionObservation(this.observe(agentId));
  }

  /** Advance feedback only when the agent starts a decision. */
  decisionFeedback(agentId: string) {
    const player = this.player(agentId);
    this.observations!.recordIncome();
    return this.feedback!.begin(player);
  }

  async vision(agentId: string, overlays?: VisionOverlays) {
    const player = this.player(agentId);
    return this.mapImages!.render(this.runner!.game, player, overlays);
  }

  async visionRegion(
    agentId: string,
    region: { x: number; y: number; width: number; height: number },
    overlays?: VisionOverlays,
  ) {
    return this.mapImages!.renderRegion(
      this.runner!.game,
      this.player(agentId),
      region,
      overlays,
    );
  }

  playerFocus(agentId: string, playerId: string) {
    const viewer = this.player(agentId);
    return publicPlayerFocus(this.runner!.game, viewer, playerId);
  }

  async visionNukePreview(agentId: string, request: NukePreviewRequest) {
    const player = this.player(agentId);
    const preview = buildNukePreview(this.runner!.game, player, request);
    const frame = await this.mapImages!.renderNukePreview(
      this.runner!.game,
      player,
      preview,
    );
    return {
      frame,
      metadata: {
        type: preview.type,
        rocketDirectionUp: preview.rocketDirectionUp,
        target: preview.target,
        source: preview.source,
        canBuild: preview.canBuild,
        blast: preview.blast,
        betrayedAllyIds: preview.betrayedAllyIds,
        targetingAlly: preview.targetingAlly,
        targetingSelf: preview.targetingSelf,
        ownStructuresAtRisk: preview.ownStructuresAtRisk,
        friendlyStructuresAtRisk: preview.friendlyStructuresAtRisk,
        interception: preview.interception,
      },
    };
  }

  async act(agentId: string, args: unknown, attackRatio?: number) {
    const player = this.player(agentId);
    const ratio =
      attackRatio === undefined
        ? this.attackRatios.get(agentId)!
        : AttackRatioSchema.parse(attackRatio);
    let intent = AgentActionSchema.parse(args);
    if (intent.type === "build_unit") {
      if (
        !PlayerBuildable.has(intent.unit) ||
        intent.unit === UnitType.TransportShip
      )
        throw new Error(
          "This unit spawns through its parent structure. Use the boat intent for troop transports.",
        );
      const game = this.runner!.game;
      assertAgentNuclearTarget(game, player, intent.unit, intent.tile);
      if (
        !game.isValidRef(intent.tile) ||
        player.canBuild(intent.unit, intent.tile) === false
      )
        throw new Error(
          `Cannot build ${intent.unit} at tile ${intent.tile}. Required gold: ${game.unitInfo(intent.unit).cost(game, player)}; available: ${player.gold()}. Use a current matching buildSite or inspect the target region.`,
        );
    }
    if (
      (intent.type === "attack" &&
        (intent.troops === null || attackRatio !== undefined)) ||
      (intent.type === "boat" && attackRatio !== undefined)
    )
      intent = { ...intent, troops: player.troops() * ratio };
    this.seat(agentId).send({ type: "intent", intent });
    this.feedback!.recordSubmitted(player, intent);
    this.attackRatios.set(agentId, ratio);
    if (isOffenseIntent(intent)) this.buildStreaks.set(agentId, 0);
    else if (isStructureBuild(intent))
      this.buildStreaks.set(agentId, (this.buildStreaks.get(agentId) ?? 0) + 1);
    return {
      accepted: true as const,
      tick: this.runner!.game.ticks(),
      intent,
      attackRatio: ratio,
    };
  }

  players(): AgentPlayer[] {
    return this.seats.map((seat) => {
      const player = this.runner?.game.playerByClientID(seat.clientId);
      return {
        id: seat.id,
        clientId: seat.clientId,
        name: seat.name,
        playerId: player?.id(),
        alive: player
          ? this.runner!.game.inSpawnPhase() || player.isAlive()
          : true,
      };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const seat of this.seats) seat.close();
    await this.processing;
  }
}
