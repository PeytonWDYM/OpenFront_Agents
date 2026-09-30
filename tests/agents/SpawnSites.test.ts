// Failure cases: candidates cluster in northern rows, region requests leak
// outside their bounds, occupied centers appear legal, or facts read stale owners.
import { expect, test } from "vitest";
import { SpawnSiteFinder } from "../../src/agents/game/spawnSites";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { GameType, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { setup } from "../util/Setup";
import { executeTicks } from "../util/utils";

test("suggests diverse legal sites and honors a requested region", async () => {
  const info = new PlayerInfo("Agent", PlayerType.Human, "agent001", "first");
  const other = new PlayerInfo(
    "Neighbor",
    PlayerType.Human,
    "human001",
    "other",
  );
  const game = await setup(
    "plains",
    { gameType: GameType.Private },
    [info, other],
    undefined,
    undefined,
    false,
  );
  const finder = new SpawnSiteFinder(game);
  const player = game.player(info.id);
  const sites = finder.find(player, 0);
  expect(sites.length).toBe(12);
  expect(
    new Set(sites.map((site) => Math.floor((site.y * 3) / game.height()))).size,
  ).toBe(3);
  expect(
    new Set(sites.map((site) => Math.floor((site.x * 4) / game.width()))).size,
  ).toBe(4);
  expect(
    finder
      .find(player, 12)
      .map((site) => site.tile)
      .sort(),
  ).not.toEqual(sites.map((site) => site.tile).sort());
  expect(
    finder
      .find(player, 24)
      .map((site) => site.tile)
      .sort(),
  ).not.toEqual(sites.map((site) => site.tile).sort());
  const original = sites[0];
  game.addExecution(new SpawnExecution("game", other, original.tile, true));
  executeTicks(game, 3);
  const regional = finder.find(player, 1, {
    x: 50,
    y: 50,
    width: 40,
    height: 40,
  });
  expect(regional.length).toBeGreaterThan(0);
  for (const site of regional) {
    expect(site.x).toBeGreaterThanOrEqual(50);
    expect(site.x).toBeLessThan(90);
    expect(site.y).toBeGreaterThanOrEqual(50);
    expect(site.y).toBeLessThan(90);
    expect(site.canSpawn).toBe(true);
    expect(site.freeLandNearby).toBeGreaterThan(0);
    expect(site.nearestPlacedPlayer?.playerId).toBe(other.id);
  }
  expect(
    finder.find(player, 0).some((site) => site.tile === original.tile),
  ).toBe(false);
});
