// Failure cases: preview range ignores upgrades, construction offers ready SAMs,
// slots or reload times are wrong, cities hide concentrated capacity, overlapping
// posts stack bonuses, own silos become inbound threats, or detail grows unbounded.
// Compression failures: a large cluster hides a distant cluster, matching only
// the first 32 unit IDs merges different blast footprints, or coverage moves.
// Missile budget failures: gold does not limit idle slots, slots do not limit
// rich players, zero-cost weapons divide by zero, disabled weapons appear,
// construction provides launch slots, or truncated silo details limit totals.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { militaryIntel } from "../../src/agents/game/militaryIntel";
import { buildNukePreview } from "../../src/agents/game/nukePreview";
import { MapImages } from "../../src/agents/vision";
import { Config } from "../../src/core/configuration/Config";
import { PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";

class NativeMilitaryConfig extends TestConfig {
  override nukeMagnitudes(type: UnitType) {
    return Config.prototype.nukeMagnitudes.call(this, type);
  }
  override samRange(level: number) {
    return Config.prototype.samRange.call(this, level);
  }
}
const game = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  [
    new PlayerInfo("self", PlayerType.Human, "self", "self"),
    new PlayerInfo("enemy", PlayerType.Human, "enemy", "enemy"),
  ],
  undefined,
  NativeMilitaryConfig,
);
const self = game.player("self");
const enemy = game.player("enemy");
self.setSpawnTile(game.ref(20, 20));
self.conquer(game.ref(20, 20));
enemy.setSpawnTile(game.ref(160, 160));
enemy.conquer(game.ref(160, 160));
const silo = self.buildUnit(UnitType.MissileSilo, game.ref(20, 20), {});
const city = self.buildUnit(UnitType.City, game.ref(50, 50), {});
city.increaseLevel();
const secondCity = self.buildUnit(UnitType.City, game.ref(60, 50), {});
const boundary = self.buildUnit(UnitType.Factory, game.ref(80, 50), {});
const sam = self.buildUnit(UnitType.SAMLauncher, game.ref(50, 60), {});
sam.increaseLevel();
const constructing = self.buildUnit(
  UnitType.SAMLauncher,
  game.ref(100, 100),
  {},
);
constructing.setUnderConstruction(true);
self.buildUnit(UnitType.DefensePost, game.ref(50, 55), {});
self.buildUnit(UnitType.DefensePost, game.ref(55, 55), {});
const hostile = enemy.buildUnit(UnitType.AtomBomb, game.ref(140, 140), {
  targetTile: city.tile(),
  trajectory: [],
});
self.buildUnit(UnitType.AtomBomb, silo.tile(), {
  targetTile: enemy.spawnTile()!,
  trajectory: [],
});
const preview = buildNukePreview(game, self, {
  type: UnitType.AtomBomb,
  tile: enemy.spawnTile()!,
});
assert.equal(preview.cost, 0);
assert.equal(preview.canBuildReason, null);
assert.ok(preview.readySilos.some((unit) => unit.unitId === silo.id()));
const coverage = preview.sams.find((unit) => unit.unitId === sam.id())!;
assert.equal(coverage.ownerId, self.id());
assert.equal(coverage.level, 2);
assert.equal(coverage.radius, game.config().dynamicSamRange(sam, game.ticks()));
assert.ok(coverage.radius < game.config().samRange(2));
assert.equal(coverage.readySlots, 1);
assert.equal(
  coverage.reloadSlots[0].ticksRemaining,
  game.config().SAMCooldown(),
);
const intel = militaryIntel(game, self);
assert.equal(intel.samLaunchers.length, 2);
assert.equal(
  intel.samLaunchers.find((unit) => unit.unitId === constructing.id())!
    .readySlots,
  0,
);
assert.deepEqual(
  intel.inboundMissiles.map((unit) => unit.unitId),
  [hostile.id()],
);
assert.equal(intel.inboundMissiles[0].currentTile, hostile.tile());
assert.equal(intel.inboundMissiles[0].targetTile, city.tile());
assert.equal(intel.defensePosts.facts.bonusesStack, false);
const concentration = intel.infrastructureConcentration.centers.find(
  (center) => center.unitId === city.id(),
)!;
assert.equal(concentration.atom.cityLevelsAtRisk, 3);
assert.equal(concentration.atom.cityCapacityAtRisk, 750_000);
assert.ok(!concentration.atom.unitIds.includes(boundary.id()));
assert.ok(concentration.atom.unitIds.includes(secondCity.id()));
assert.equal(concentration.defensePostIds.length, 2);
assert.equal(
  buildNukePreview(game, self, { type: UnitType.AtomBomb, tile: silo.tile() })
    .canBuildReason,
  "own_target",
);
const distant = enemy.buildUnit(UnitType.AtomBomb, game.ref(140, 130), {
  targetTile: enemy.spawnTile()!,
  trajectory: [],
});
const carrier = enemy.buildUnit(UnitType.MIRV, game.ref(140, 120), {
  targetTile: city.tile(),
  targetPlayer: self,
});
carrier.setTargetable(true);
const warhead = enemy.buildUnit(UnitType.MIRVWarhead, game.ref(140, 110), {
  targetTile: city.tile(),
  trajectory: [],
});
warhead.setTargetable(true);
const threatIntel = militaryIntel(game, self);
assert.ok(
  !threatIntel.inboundMissiles.some((unit) => unit.unitId === distant.id()),
);
assert.equal(
  threatIntel.inboundMissiles.find((unit) => unit.unitId === carrier.id())!
    .targetableBySAM,
  false,
);
assert.equal(
  threatIntel.inboundMissiles.find((unit) => unit.unitId === warhead.id())!
    .targetableBySAM,
  true,
);
for (let index = 0; index < 40; index++) {
  self.buildUnit(UnitType.SAMLauncher, game.ref(100 + index, 20), {});
  self.buildUnit(UnitType.MissileSilo, game.ref(100 + index, 30), {});
  self.buildUnit(UnitType.DefensePost, game.ref(100 + index, 40), {});
  enemy.buildUnit(UnitType.AtomBomb, game.ref(100 + index, 150), {
    targetTile: city.tile(),
    trajectory: [],
  });
}
const boundedIntel = militaryIntel(game, self);
assert.equal(boundedIntel.samLaunchers.length, 32);
assert.equal(boundedIntel.samLaunchersTotal, 42);
assert.equal(boundedIntel.samLaunchersTruncated, true);
assert.equal(boundedIntel.samReadiness.readySlots, 41);
assert.equal(boundedIntel.samReadiness.totalSlots, 43);
assert.equal(boundedIntel.missileSilos.length, 32);
assert.equal(boundedIntel.missileSilosTotal, 41);
assert.equal(boundedIntel.defensePosts.units.length, 32);
assert.equal(boundedIntel.defensePosts.totalUnits, 42);
assert.equal(boundedIntel.inboundMissiles.length, 32);
assert.equal(boundedIntel.inboundMissilesTotal, 43);
assert.equal(boundedIntel.infrastructureConcentration.centers.length, 12);
assert.ok(
  "missileBudget" in boundedIntel,
  "Expose current funded launch slots",
);
assert.equal(
  boundedIntel.missileBudget.basis,
  "Upper bounds from current gold and ready slots, per weapon independently. No other spending or target legality included.",
);
assert.deepEqual(
  boundedIntel.missileBudget.options,
  [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV].map((type) => ({
    type,
    cost: 0,
    fundedReadyShots: 41,
  })),
  "Infinite gold uses all ready slots, including silos beyond the detail limit",
);
const budgetGame = await setup(
  "plains",
  { disabledUnits: [UnitType.HydrogenBomb], instantBuild: true },
  [new PlayerInfo("self", PlayerType.Human, "self", "self")],
);
const budgetPlayer = budgetGame.player("self");
budgetPlayer.setSpawnTile(budgetGame.ref(10, 10));
budgetPlayer.conquer(budgetGame.ref(10, 10));
budgetPlayer.addGold(100_000_000n);
const budgetSilos = Array.from({ length: 35 }, (_, index) =>
  budgetPlayer.buildUnit(
    UnitType.MissileSilo,
    budgetGame.ref(10 + index, 10),
    {},
  ),
);
const constructingSilo = budgetPlayer.buildUnit(
  UnitType.MissileSilo,
  budgetGame.ref(80, 80),
  {},
);
constructingSilo.setUnderConstruction(true);
const atomCost = budgetGame
  .unitInfo(UnitType.AtomBomb)
  .cost(budgetGame, budgetPlayer);
budgetPlayer.removeGold(budgetPlayer.gold() - (atomCost * 3n + atomCost / 2n));
const lowGoldIntel = militaryIntel(budgetGame, budgetPlayer);
assert.equal(lowGoldIntel.missileSilos.length, 32);
assert.equal(lowGoldIntel.siloReadiness.readySlots, 35);
assert.deepEqual(
  lowGoldIntel.missileBudget.options,
  [UnitType.AtomBomb, UnitType.MIRV].map((type) => ({
    type,
    cost: Number(budgetGame.unitInfo(type).cost(budgetGame, budgetPlayer)),
    fundedReadyShots: type === UnitType.AtomBomb ? 3 : 0,
  })),
  "Current gold limits shots and disabled Hydrogen weapons stay absent",
);
for (const unit of budgetSilos.slice(0, 33)) unit.delete(false);
budgetPlayer.addGold(100_000_000n);
const richGoldIntel = militaryIntel(budgetGame, budgetPlayer);
assert.equal(richGoldIntel.siloReadiness.readySlots, 2);
assert.equal(richGoldIntel.siloReadiness.underConstructionUnits, 1);
assert.ok(
  richGoldIntel.missileBudget.options.every(
    (option) => option.fundedReadyShots === 2,
  ),
  "Ready completed slots limit rich players",
);
const image = await new MapImages("military-intel-e2e").renderNukePreview(
  game,
  self,
  preview,
);
assert.ok(image.width > 0 && image.height > 0);
const clusterGame = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  [new PlayerInfo("self", PlayerType.Human, "self", "self")],
  undefined,
  NativeMilitaryConfig,
);
const clusterPlayer = clusterGame.player("self");
const cityClusters = [
  Array.from({ length: 13 }, (_, index) =>
    clusterPlayer.buildUnit(UnitType.City, clusterGame.ref(15 + index, 15), {}),
  ),
  Array.from({ length: 6 }, (_, index) =>
    clusterPlayer.buildUnit(
      UnitType.City,
      clusterGame.ref(175 + index, 175),
      {},
    ),
  ),
];
const clusterSam = clusterPlayer.buildUnit(
  UnitType.SAMLauncher,
  clusterGame.ref(15, 18),
  {},
);
const clusterPost = clusterPlayer.buildUnit(
  UnitType.DefensePost,
  clusterGame.ref(15, 20),
  {},
);
const clusterIntel = militaryIntel(
  clusterGame,
  clusterPlayer,
).infrastructureConcentration;
assert.equal(
  clusterIntel.centers.length,
  2,
  "Represent each distinct Atom/Hydrogen footprint once",
);
assert.equal(clusterIntel.totalCenters, 2);
assert.equal(clusterIntel.totalCandidateCenters, 21);
assert.equal(clusterIntel.truncated, false);
assert.equal(
  clusterIntel.basis,
  "distinct Atom and Hydrogen structure footprints",
);
assert.deepEqual(
  clusterIntel.centers.map((center) => center.unitId),
  cityClusters.map((cluster) => cluster[0].id()),
);
assert.deepEqual(clusterIntel.centers[0].samIds, [clusterSam.id()]);
assert.deepEqual(clusterIntel.centers[0].defensePostIds, [clusterPost.id()]);
assert.deepEqual(clusterIntel.centers[1].samIds, []);
assert.deepEqual(clusterIntel.centers[1].defensePostIds, []);
const fullFootprintGame = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  [new PlayerInfo("self", PlayerType.Human, "self", "self")],
  undefined,
  NativeMilitaryConfig,
);
const fullFootprintPlayer = fullFootprintGame.player("self");
const leftCenter = fullFootprintPlayer.buildUnit(
  UnitType.City,
  fullFootprintGame.ref(70, 80),
  {},
);
const rightCenter = fullFootprintPlayer.buildUnit(
  UnitType.City,
  fullFootprintGame.ref(90, 80),
  {},
);
for (let index = 0; index < 32; index++)
  fullFootprintPlayer.buildUnit(
    UnitType.City,
    fullFootprintGame.ref(80, 80),
    {},
  );
fullFootprintPlayer.buildUnit(UnitType.City, fullFootprintGame.ref(45, 80), {});
fullFootprintPlayer.buildUnit(
  UnitType.City,
  fullFootprintGame.ref(115, 80),
  {},
);
const fullFootprintIntel = militaryIntel(
  fullFootprintGame,
  fullFootprintPlayer,
).infrastructureConcentration;
const leftEntry = fullFootprintIntel.centers.find(
  (center) => center.unitId === leftCenter.id(),
)!;
const rightEntry = fullFootprintIntel.centers.find(
  (center) => center.unitId === rightCenter.id(),
)!;
assert.ok(
  leftEntry && rightEntry,
  "Distinct complete footprints must survive matching truncated detail IDs",
);
assert.equal(leftEntry.atom.unitIds.length, 32);
assert.deepEqual(leftEntry.atom.unitIds, rightEntry.atom.unitIds);
assert.equal(leftEntry.atom.unitIdsTruncated, true);
assert.equal(fullFootprintIntel.totalCenters, 5);
assert.equal(fullFootprintIntel.totalCandidateCenters, 36);
assert.ok(!JSON.stringify(fullFootprintIntel).includes("footprintSignature"));
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/military-intel-e2e.json",
  JSON.stringify(
    {
      passed: true,
      preview,
      intel,
      threatIntel,
      boundedIntel,
      missileBudgetBounds: {
        infiniteGold: boundedIntel.missileBudget,
        lowGold: lowGoldIntel.missileBudget,
        richGold: richGoldIntel.missileBudget,
      },
      clusterIntel,
      fullFootprintIntel,
      image,
    },
    null,
    2,
  ),
);
console.log(
  "Military intelligence E2E passed: .agent-arena/military-intel-e2e.json",
);
