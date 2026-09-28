import { z } from "zod";
import { createGameRunner, GameRunner } from "../../core/GameRunner";
import { GameStartInfo, ServerMessage, Turn } from "../../core/Schemas";
import {
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Player,
} from "../../core/game/Game";
import {
  ErrorUpdate,
  GameUpdateType,
  GameUpdateViewData,
} from "../../core/game/GameUpdates";
import { LocalMapLoader } from "./LocalMapLoader";
import { PlayerSocket } from "./PlayerSocket";
import { playerEvents } from "./events";
import { ObservationBuilder } from "./observation";
import {
  AgentActionSchema,
  AgentEvent,
  AgentGameEvent,
  AgentPlayer,
  ObserveQuery,
  ObserveQuerySchema,
} from "./schemas";

const ADMIN_KEY = "WARNING_DEV_ADMIN_BOT_KEY_DO_NOT_USE_IN_PRODUCTION";
const LobbyResponseSchema = z.object({
  gameID: z.string(),
  workerIndex: z.number().int().min(0).max(1),
});

export interface AgentGameOptions {
  agentCount: number;
  map?: GameMapType;
  randomSpawn?: boolean;
  onEvent?: (event: AgentGameEvent) => void;
}

/** A private local lobby with normal player sockets and one native simulation mirror. */
export class AgentGame {
  private seats: PlayerSocket[] = [];
  private runner?: GameRunner;
  private observations?: ObservationBuilder;
  private histories = new Map<string, AgentEvent[]>();
  private gameId_ = "";
  private workerId = 0;
  private gameStart_?: GameStartInfo;
  private nextExpectedTurn = 0;
  private processing = Promise.resolve();
  private failure?: Error;
  private closed = false;

  constructor(private options: AgentGameOptions) {
    z.number().int().min(1).max(400).parse(options.agentCount);
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
    const lobby = LobbyResponseSchema.parse(
      await this.admin("/api/adminbot/create_game", {
        gameMap: this.options.map ?? GameMapType.Europe,
        gameMapSize: GameMapSize.Compact,
        gameType: GameType.Private,
        gameMode: GameMode.FFA,
        bots: 0,
        nations: "disabled",
        randomSpawn: this.options.randomSpawn ?? true,
        donateGold: true,
        donateTroops: true,
      }),
    );
    this.gameId_ = lobby.gameID;
    this.workerId = lobby.workerIndex;
    for (let index = 0; index < this.options.agentCount; index++) {
      const id = `agent${String(index + 1).padStart(3, "0")}`;
      const seat = new PlayerSocket(id, `Agent ${index + 1}`, this.workerId);
      this.seats.push(seat);
      this.histories.set(id, []);
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
    for (const seat of this.seats) {
      const player = game.playerByClientID(seat.clientId);
      if (!player) continue;
      const events = playerEvents(game, player, update.updates);
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
    );
    observation.gameId = this.gameId_;
    return observation;
  }

  async act(agentId: string, args: unknown) {
    this.player(agentId);
    const intent = AgentActionSchema.parse(args);
    this.seat(agentId).send({ type: "intent", intent });
    return { accepted: true as const, tick: this.runner!.game.ticks(), intent };
  }

  players(): AgentPlayer[] {
    return this.seats.map((seat) => {
      const player = this.runner?.game.playerByClientID(seat.clientId);
      return {
        id: seat.id,
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
