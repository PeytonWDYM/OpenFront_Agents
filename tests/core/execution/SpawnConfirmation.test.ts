// Failure cases: placement starts the countdown before review, an invalid move
// loses territory, a confirmed seat can move, or snapshots lose confirmation.
// Queued initial picks must not bypass the review timing or relocation budget.
import { describe, expect, test } from "vitest";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
import { SpawnTimerExecution } from "../../../src/core/execution/SpawnTimerExecution";
import { GameType, PlayerInfo, PlayerType } from "../../../src/core/game/Game";
import { GameConfigSchema, SpawnIntentSchema } from "../../../src/core/Schemas";
import { applyGameConfigPatch } from "../../../src/server/ConfigPatch";
import { setup } from "../../util/Setup";
import { roundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

const first = new PlayerInfo("First", PlayerType.Human, "agent001", "first");
const second = new PlayerInfo("Second", PlayerType.Human, "agent002", "second");
async function reviewGame() {
  const game = await setup(
    "plains",
    {
      gameType: GameType.Private,
      spawnReadyClientIDs: ["agent001", "agent002"],
      requireSpawnConfirmation: true,
    },
    [first, second],
    undefined,
    undefined,
    false,
  );
  game.addExecution(new SpawnTimerExecution());
  game.addExecution(
    new SpawnExecution("game", first, game.ref(20, 20), true, true),
    new SpawnExecution("game", second, game.ref(75, 75), true),
  );
  executeTicks(game, 4);
  return game;
}

describe("agent spawn confirmation", () => {
  test("rejects queued moves before review and caps native review relocations", async () => {
    const game = await setup(
      "plains",
      {
        gameType: GameType.Private,
        spawnReadyClientIDs: ["agent001", "agent002"],
        requireSpawnConfirmation: true,
      },
      [first, second],
      undefined,
      undefined,
      false,
    );
    game.addExecution(
      new SpawnExecution("game", first, game.ref(20, 20), true),
      new SpawnExecution("game", first, game.ref(20, 75), true),
    );
    executeTicks(game, 3);
    expect(game.player(first.id).spawnTile()).toBe(game.ref(20, 20));
    game.addExecution(
      new SpawnExecution("game", second, game.ref(75, 75), true),
    );
    executeTicks(game, 3);
    game.addExecution(
      new SpawnExecution("game", first, game.ref(20, 75), true),
      new SpawnExecution("game", first, game.ref(75, 20), true),
      new SpawnExecution("game", first, game.ref(50, 50), true),
    );
    executeTicks(game, 3);
    expect(game.player(first.id).spawnTile()).toBe(game.ref(75, 20));
    const { restored } = await roundTrip(game, "plains");
    restored.addExecution(
      new SpawnExecution("game", first, restored.ref(50, 50), true),
    );
    executeTicks(restored, 3);
    expect(restored.player(first.id).spawnTile()).toBe(restored.ref(75, 20));
  });
  test("holds the full countdown until both placed seats finish review", async () => {
    const game = await reviewGame();
    executeTicks(game, 1_000);
    expect(game.inSpawnPhase()).toBe(true);
    const player = game.player(first.id);
    expect(player.hasConfirmedSpawn()).toBe(false);
    const tiles = [...player.tiles()];
    game.addExecution(
      new SpawnExecution("game", first, player.spawnTile(), true, true),
    );
    executeTicks(game, 10);
    expect(player.hasConfirmedSpawn()).toBe(true);
    expect([...player.tiles()]).toEqual(tiles);
    expect(game.inSpawnPhase()).toBe(true);
    game.addExecution(
      new SpawnExecution(
        "game",
        second,
        game.player(second.id).spawnTile(),
        true,
        true,
      ),
    );
    executeTicks(game, 4);
    executeTicks(game, game.config().numSpawnPhaseTurns() - 1);
    expect(game.inSpawnPhase()).toBe(true);
    executeTicks(game, 1);
    expect(game.inSpawnPhase()).toBe(false);
  });

  test("preserves a valid placement after a failed move and freezes confirmed seats", async () => {
    const game = await reviewGame();
    const player = game.player(first.id);
    const tiles = [...player.tiles()];
    game.addExecution(
      new SpawnExecution(
        "game",
        first,
        game.player(second.id).spawnTile(),
        true,
      ),
    );
    executeTicks(game, 3);
    expect([...player.tiles()]).toEqual(tiles);
    expect(player.hasConfirmedSpawn()).toBe(false);
    game.addExecution(
      new SpawnExecution("game", first, player.spawnTile(), true, true),
    );
    executeTicks(game, 3);
    game.addExecution(
      new SpawnExecution("game", first, game.ref(20, 75), true),
    );
    executeTicks(game, 3);
    expect(player.spawnTile()).toBe(game.ref(20, 20));
    expect(player.hasConfirmedSpawn()).toBe(true);
  });

  test("preserves review confirmation in snapshots and native config patches", async () => {
    const game = await reviewGame();
    game.addExecution(
      new SpawnExecution("game", first, game.ref(20, 20), true, true),
    );
    executeTicks(game, 3);
    const { restored } = await roundTrip(game, "plains");
    expect(restored.player(first.id).hasConfirmedSpawn()).toBe(true);
    expect(restored.player(second.id).hasConfirmedSpawn()).toBe(false);
    executeTicks(restored, 300);
    expect(restored.inSpawnPhase()).toBe(true);
    const config = GameConfigSchema.parse(game.config().gameConfig());
    const patched = { ...config, requireSpawnConfirmation: undefined };
    applyGameConfigPatch(patched, config);
    expect(patched.requireSpawnConfirmation).toBe(true);
    expect(
      SpawnIntentSchema.parse({ type: "spawn", tile: 20, confirm: true })
        .confirm,
    ).toBe(true);
  });
});
