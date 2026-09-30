// Failure cases: nearby rivals omit public resources, percentage fractions read
// as victory percentages, an upgrade hint looks like a new build, construction
// looks ready, or build errors hide native gold, ownership, and upgrade blockers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { projectDecisionObservation } from "../../src/agents/game/decision";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { UpgradeStructureExecution } from "../../src/core/execution/UpgradeStructureExecution";
import { getSpawnTiles } from "../../src/core/execution/Util";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

const game = await setup("plains", {}, [
  playerInfo("Observer", PlayerType.Human),
  playerInfo("Neighbor", PlayerType.Human),
]);
const self = game.player("Observer");
const rival = game.player("Neighbor");
const tile = game.ref(35, 35);
for (let y = 31; y < 39; y++)
  for (let x = 30; x < 40; x++) self.conquer(game.ref(x, y));
self.setSpawnTile(tile);
self.addGold(2_000_000n);
self.setTroops(10_000);
rival.conquer(game.ref(40, 35));
rival.setSpawnTile(game.ref(40, 35));
rival.setTroops(5_432);
rival.addGold(765_432n);
const builder = new ObservationBuilder(game);
const observation = builder.observe("agent001", self, 0, {}, []);
const decision = projectDecisionObservation(observation);
const neighbor = decision.rivals!.find((row) => row.playerId === rival.id())!;
assert.equal(neighbor.troops, rival.troops());
assert.equal(neighbor.gold, Number(rival.gold()));
assert.equal(neighbor.maxTroops, Math.floor(game.config().maxTroops(rival)));
assert.equal(neighbor.sharesBorder, true);
assert.ok(!("incomingAttacks" in neighbor));
assert.ok(!("outgoingAttacks" in neighbor));
assert.equal(decision.victory.landPercent, 0.8);
assert.equal(decision.victory.percentUnit, "percent (0..100)");
assert.equal(decision.victory.ownedLand, "0.80%");
assert.equal(decision.victory.requiredLand, "80.00%");
assert(decision.victory.tilesRemaining > 0);

const { assertAgentBuild, assertAgentUpgrade } =
  await import("../../src/agents/game/buildLegality");
assert.doesNotThrow(() => assertAgentBuild(game, self, UnitType.City, tile));
game.addExecution(new ConstructionExecution(self, UnitType.City, tile));
game.executeNextTick();
game.executeNextTick();
const city = self.units(UnitType.City)[0];
assert(city.isUnderConstruction());
const construction = projectDecisionObservation(
  builder.observe("agent001", self, 0, {}, []),
);
assert.equal(
  construction.units!.find((unit) => unit.id === city.id())!.underConstruction,
  true,
);
assert.throws(
  () => assertAgentUpgrade(game, self, UnitType.City, city.id()),
  /under construction/,
);
assert.throws(
  () => assertAgentBuild(game, self, UnitType.City, tile),
  /under construction/,
);
for (let tick = 0; tick < 40; tick++) game.executeNextTick();
assert.equal(city.isUnderConstruction(), false);
const ready = builder.observe("agent001", self, 0, {}, []);
const upgrade = projectDecisionObservation(ready).map!.buildSites.find(
  (site) => "upgradeId" in site && site.upgradeId === city.id(),
)!;
assert(upgrade);
assert.equal(upgrade.action, "upgrade_structure");
assert.equal(upgrade.tile, city.tile());
assert.throws(
  () => assertAgentBuild(game, self, UnitType.City, tile),
  /upgrade_structure.*unitId/,
);
assert.doesNotThrow(() =>
  assertAgentUpgrade(game, self, UnitType.City, city.id()),
);
game.addExecution(new UpgradeStructureExecution(self, city.id(), 1));
game.executeNextTick();
assert.equal(city.level(), 2);

const enemyCity = rival.buildUnit(UnitType.City, rival.spawnTile()!, {});
assert.throws(
  () => assertAgentUpgrade(game, self, UnitType.City, enemyCity.id()),
  /not owned/,
);
assert.throws(
  () => assertAgentUpgrade(game, self, UnitType.Factory, city.id()),
  /type.*City/,
);
assert.throws(
  () => assertAgentBuild(game, self, UnitType.City, rival.spawnTile()!),
  /not owned/,
);
assert.throws(
  () => assertAgentBuild(game, self, UnitType.City, -1),
  /invalid tile/,
);
self.removeGold(self.gold());
assert.throws(
  () => assertAgentBuild(game, self, UnitType.City, tile),
  /insufficient gold.*required.*available/i,
);
assert.throws(
  () => assertAgentUpgrade(game, self, UnitType.City, city.id()),
  /insufficient gold/i,
);

const disabled = await setup("plains", { disabledUnits: [UnitType.City] }, [
  playerInfo("Disabled", PlayerType.Human),
]);
const disabledSelf = disabled.player("Disabled");
disabledSelf.conquer(tile);
disabledSelf.addGold(2_000_000n);
assert.throws(
  () => assertAgentBuild(disabled, disabledSelf, UnitType.City, tile),
  /disabled/,
);

// New build and upgrade sites stay distinct in broad native placement queries.
self.addGold(2_000_000n);
for (let y = 60; y < 95; y++)
  for (let x = 60; x < 95; x++) self.conquer(game.ref(x, y));
const broad = projectDecisionObservation(
  builder.observe("agent001", self, 0, { buildType: UnitType.City }, []),
);
assert(broad.map!.buildSites.some((site) => site.action === "build_unit"));
assert(
  broad.map!.buildSites.some((site) => site.action === "upgrade_structure"),
);
for (const site of broad.map!.buildSites)
  if (site.action === "build_unit")
    assert.notEqual(self.canBuild(UnitType.City, site.tile), false);
  else assert.equal("upgradeId" in site && site.upgradeId, city.id());

const port = self.buildUnit(UnitType.Port, tile, {});
self.buildUnit(UnitType.TradeShip, game.ref(45, 35), { targetUnit: port });
const trafficObservation = builder.observe("agent001", self, 0, {}, []);
assert.equal(trafficObservation.map.tradeTraffic.length, 1);
assert.ok(
  !("tradeTraffic" in projectDecisionObservation(trafficObservation).map!),
);
assert.equal(
  projectDecisionObservation(trafficObservation, ["map"]).map!.tradeTraffic!
    .length,
  1,
);
assert.equal(
  projectDecisionObservation(trafficObservation, ["units"]).tradeTraffic!
    .length,
  1,
);

const spawnGame = await setup(
  "plains",
  {},
  [
    playerInfo("Chooser", PlayerType.Human),
    playerInfo("Placed", PlayerType.Human),
    ...Array.from({ length: 8 }, (_, index) =>
      playerInfo(`Bot${index}`, PlayerType.Bot),
    ),
  ],
  undefined,
  undefined,
  false,
);
const chooser = spawnGame.player("Chooser");
const placed = spawnGame.player("Placed");
placed.conquer(spawnGame.ref(80, 80));
placed.setSpawnTile(spawnGame.ref(80, 80));
const spawnBuilder = new ObservationBuilder(spawnGame);
const spawn = spawnBuilder.observe("agent001", chooser, 0, {}, []);
assert.equal(spawn.map.spawnCandidates.length, 12);
const quadrants = new Set(
  spawn.map.spawnCandidates.map(
    (site) => `${Math.floor(site.x / 50)},${Math.floor(site.y / 50)}`,
  ),
);
assert.equal(quadrants.size, 4);
for (const site of spawn.map.spawnCandidates) {
  assert.equal(site.canSpawn, true);
  assert(getSpawnTiles(spawnGame, site.tile, false).length > 0);
  assert.equal(site.nearestPlacedPlayer?.playerId, placed.id());
  assert.equal(site.coastDistance, null);
  assert(site.freeLandNearby > 0);
}
const region = { x: 50, y: 50, width: 40, height: 40 };
const regionalSpawn = spawnBuilder.observe("agent001", chooser, 0, region, []);
assert(regionalSpawn.map.spawnCandidates.length > 0);
for (const site of regionalSpawn.map.spawnCandidates) {
  assert(site.x >= 50 && site.x < 90);
  assert(site.y >= 50 && site.y < 90);
}
assert(
  spawn.rivals.some(
    (row) =>
      row.playerId === placed.id() && row.position?.tile === placed.spawnTile(),
  ),
);

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/actionable-data-e2e.json",
  JSON.stringify(
    {
      result: "PASS",
      decision,
      construction,
      upgrade,
      upgradedLevel: city.level(),
      broad,
      spawn,
      regionalSpawn,
      modelRequests: 0,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: public rival resources, percentage units, native construction, upgrades, and rejection reasons.",
);
