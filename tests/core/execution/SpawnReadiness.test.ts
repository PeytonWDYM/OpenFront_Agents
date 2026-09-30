// Failure cases: delayed or invalid spawns start the timer, unrelated humans
// block agents, snapshots reset the timer, or ordinary games change behavior.
import { describe, expect, test } from "vitest";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import {
  SpawnTimerExecution,
  SpawnTimerExecutionSnapshot,
} from "../../../src/core/execution/SpawnTimerExecution";
import { GameType, PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { GameConfigSchema, ServerMessage } from "../../../src/core/Schemas";
import { readVersioned } from "../../../src/core/snapshot/SnapshotType";
import {
  decodeServerMessage,
  encodeServerMessage,
} from "../../../src/core/ZbinWire";
import { applyGameConfigPatch } from "../../../src/server/ConfigPatch";
import { setup } from "../../util/Setup";
import { roundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

const first = new PlayerInfo("First", PlayerType.Human, "agent001", "first");
const slow = new PlayerInfo("Slow", PlayerType.Human, "agent002", "slow");
const spectator = new PlayerInfo(
  "Human",
  PlayerType.Human,
  "human001",
  "human",
);

async function agentGame() {
  const config = {
    gameType: GameType.Private,
    spawnReadyClientIDs: ["agent001", "agent002"],
  };
  const game = await setup(
    "plains",
    config,
    [first, slow, spectator],
    undefined,
    undefined,
    false,
  );
  game.addExecution(new SpawnTimerExecution());
  return game;
}

describe("agent spawn readiness", () => {
  test("waits for actual valid spawns, then gives the full native countdown", async () => {
    const game = await agentGame();
    game.addExecution(
      new SpawnExecution("game_id", first, game.ref(20, 20), true),
    );
    executeTicks(game, 1_000);
    expect(game.inSpawnPhase()).toBe(true);
    expect(game.player(first.id).hasSpawned()).toBe(true);
    expect(game.player(slow.id).hasSpawned()).toBe(false);
    const waiting = game.executeNextTick();
    expect(waiting[GameUpdateType.SpawnCountdown][0]).toMatchObject({
      elapsedTicks: 0,
    });

    game.addExecution(new SpawnExecution("game_id", slow, -1, true));
    executeTicks(game, 250);
    expect(game.inSpawnPhase()).toBe(true);
    expect(game.player(slow.id).hasSpawned()).toBe(false);

    game.addExecution(
      new SpawnExecution("game_id", slow, game.ref(75, 75), true),
    );
    executeTicks(game, 3);
    const started = game.executeNextTick();
    expect(started[GameUpdateType.SpawnCountdown][0]).toMatchObject({
      elapsedTicks: 1,
    });
    executeTicks(game, game.config().numSpawnPhaseTurns() - 1);
    expect(game.inSpawnPhase()).toBe(true);
    game.executeNextTick();
    expect(game.inSpawnPhase()).toBe(false);
    expect(game.player(slow.id).isAlive()).toBe(true);
    expect(game.player(spectator.id).hasSpawned()).toBe(false);
  });

  test("snapshot restore preserves readiness wait and elapsed countdown", async () => {
    const original = await agentGame();
    executeTicks(original, 400);
    const { restored: waiting } = await roundTrip(original, "plains");
    executeTicks(waiting, 400);
    expect(waiting.inSpawnPhase()).toBe(true);
    waiting.addExecution(
      new SpawnExecution("game_id", first, waiting.ref(20, 20), true),
      new SpawnExecution("game_id", slow, waiting.ref(75, 75), true),
    );
    executeTicks(waiting, 70);
    const { restored } = await roundTrip(waiting, "plains");
    while (waiting.inSpawnPhase()) {
      expect(restored.executeNextTick()[GameUpdateType.SpawnCountdown]).toEqual(
        waiting.executeNextTick()[GameUpdateType.SpawnCountdown],
      );
      expect(restored.inSpawnPhase()).toBe(waiting.inSpawnPhase());
    }
  });

  test("ordinary multiplayer retains its fixed spawn deadline", async () => {
    const game = await setup(
      "plains",
      { gameType: GameType.Private },
      [slow],
      undefined,
      undefined,
      false,
    );
    game.addExecution(new SpawnTimerExecution());
    executeTicks(game, game.config().numSpawnPhaseTurns() + 2);
    expect(game.inSpawnPhase()).toBe(false);
    expect(game.player(slow.id).hasSpawned()).toBe(false);
  });

  test("readiness IDs survive native schema, config patches, and binary wire", async () => {
    const game = await agentGame();
    const config = GameConfigSchema.parse(game.config().gameConfig());
    expect(config.spawnReadyClientIDs).toEqual(["agent001", "agent002"]);
    const patched = { ...config, spawnReadyClientIDs: undefined };
    applyGameConfigPatch(patched, config);
    expect(patched.spawnReadyClientIDs).toEqual(config.spawnReadyClientIDs);
    const message: ServerMessage = {
      type: "lobby_info",
      myClientID: "agent001",
      lobby: {
        gameID: "gM3xQ1zR",
        serverTime: 1,
        startsAt: 2,
        gameConfig: config,
        clients: [],
      },
    };
    expect(
      decodeServerMessage(encodeServerMessage(message, undefined), undefined),
    ).toEqual(message);
  });

  test("old timer snapshots migrate without a readiness delay", () => {
    expect(
      readVersioned(SpawnTimerExecutionSnapshot, {
        v: 1,
        d: { initialized: true },
      }),
    ).toMatchObject({ countdownStartTick: null });
  });
});
