// Failure cases: an exact 80% share reports a win, fallout stays in the denominator,
// overtime and timers disappear, allies count toward an FFA win, team land is
// counted incorrectly, public leaderboard columns are missing, spending lowers
// gross income, duplicate observations change rates, or private attacks leak.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { MatchStats } from "../../src/agents/game/matchStats";
import { WinCheckExecution } from "../../src/core/execution/WinCheckExecution";
import { GameMode, PlayerType, UnitType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

const game = await setup("plains", { maxTimerValue: 10 }, [
  playerInfo("Leader", PlayerType.Human),
  playerInfo("Observer", PlayerType.Human),
  playerInfo("Tribe", PlayerType.Bot),
]);
const leader = game.player("Leader");
const self = game.player("Observer");
const land: number[] = [];
game.map().forEachTile((tile) => {
  if (game.isLand(tile)) land.push(tile);
});
const target = Math.floor(land.length * 0.8);
for (const tile of land.slice(0, target)) leader.conquer(tile);
self.conquer(land[target]);
leader.setSpawnTile(land[0]);
self.setSpawnTile(land[target]);
leader.addGold(250_000n);
leader.setTroops(15_000);
const city = leader.buildUnit(UnitType.City, land[0], {});
city.increaseLevel();
const stats = new MatchStats(game);
const initial = stats.observe(leader);
assert.equal(initial.victory.requiredLandPercent, 80);
assert.equal(initial.victory.landTiles, game.totalLandTiles());
assert.equal(initial.victory.requiredTiles, target + 1);
assert.equal(initial.victory.tilesRemaining, 1);
assert.equal(initial.victory.timerRemainingSeconds, 600);
assert.equal(initial.leaderboard.selfRank, 1);
const first = initial.leaderboard.players[0];
assert.equal(first.playerId, leader.id());
assert.equal(first.gold, Number(leader.gold()));
assert.equal(first.troops, leader.troops());
assert.equal(first.maxTroops, Math.floor(game.config().maxTroops(leader)));
assert.equal(first.unitLevels.City, 2);
assert.equal(
  first.landPercent,
  (leader.numTilesOwned() / game.totalLandTiles()) * 100,
);
assert.ok(!("incomingAttacks" in first));
assert.ok(!("outgoingAttacks" in first));
const check = new WinCheckExecution();
check.init(game, game.ticks());
check.checkWinnerFFA();
assert.equal(
  game.getWinner(),
  null,
  "Native victory requires more than exactly 80%",
);
leader.conquer(land[target + 1]);
game.executeNextTick();
assert.equal(stats.observe(leader).victory.tilesRemaining, 0);
check.checkWinnerFFA();
assert.ok(game.getWinner());
game.map().setFallout(land[land.length - 1], true);
game.executeNextTick();
assert.equal(stats.observe(leader).victory.landTiles, land.length - 1);

const economy = await setup("plains", {}, [
  playerInfo("Economist", PlayerType.Human),
]);
const economist = economy.player("Economist");
economist.conquer(economy.ref(35, 35));
economist.setSpawnTile(economy.ref(35, 35));
const economyStats = new MatchStats(economy);
economyStats.observe(economist);
for (let tick = 0; tick < 600; tick++) economy.executeNextTick();
economist.addGold(12_000n);
economist.addTradeGold(3_000n);
economist.addTrainGold(4_000n);
economist.addPiracyGold(5_000n);
economist.removeGold(2_000n);
const income = economyStats.observe(economist).leaderboard.players[0];
assert.equal(income.goldIncomePerMinute, 12_000);
assert.equal(income.shipTradeGoldPerMinute, 3_000);
assert.equal(income.trainTradeGoldPerMinute, 4_000);
assert.equal(income.piracyGoldPerMinute, 5_000);
assert.deepEqual(
  economyStats.observe(economist).leaderboard.players[0],
  income,
);

const overtime = await setup(
  "plains",
  { overtime: { enabled: true, startMinutes: 1 } },
  [playerInfo("Overtime", PlayerType.Human)],
);
const overtimePlayer = overtime.player("Overtime");
overtimePlayer.conquer(overtime.ref(35, 35));
for (let tick = 0; tick < 1_200; tick++) overtime.executeNextTick();
assert.equal(
  new MatchStats(overtime).observe(overtimePlayer).victory.requiredLandPercent,
  78,
);
assert.equal(
  new MatchStats(overtime).observe(overtimePlayer).victory
    .timerRemainingSeconds,
  null,
);

const teamGame = await setup(
  "plains",
  { gameMode: GameMode.Team, playerTeams: 2 },
  [
    playerInfo("Team One", PlayerType.Human),
    playerInfo("Team Two", PlayerType.Human),
    playerInfo("Team Three", PlayerType.Human),
  ],
);
const teamPlayers = teamGame.allPlayers();
teamPlayers.forEach((player, index) =>
  player.conquer(teamGame.ref(35 + index * 5, 35)),
);
const teamSelf = teamPlayers[0];
const teamView = new MatchStats(teamGame).observe(teamSelf);
assert.equal(teamView.victory.side, teamSelf.team());
assert.equal(
  teamView.victory.tilesOwned,
  teamGame.teamTilesOwned(teamSelf.team()!),
);
assert.ok(teamView.leaderboard.teams.length > 0);

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/match-stats-e2e.json",
  JSON.stringify(
    {
      result: "PASS",
      nativeWinner: leader.name(),
      initial,
      income,
      overtime: new MatchStats(overtime).observe(overtimePlayer).victory,
      team: teamView,
      modelRequests: 0,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: native victory, public leaderboard, rates, overtime, and teams.",
);
