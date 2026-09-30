import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MapImages } from "../../src/agents/vision";
import { drawUnitMarkers } from "../../src/agents/vision/markers";
import {
  VisionOverlaySchema,
  VisionResolutionSchema,
} from "../../src/agents/vision/options";
import { Raster } from "../../src/agents/vision/raster";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

// Failure cases: default trade ships obscure military units, one category switch
// hides another category, legacy units:false keeps markers, groups mix owners or
// types, badges lose exact IDs, resolution changes crop coordinates, same-tick
// presets overwrite images, or image dimensions differ from returned metadata.
// The fixture uses native game units and PNG output without a server or inference.
const game = await setup(
  "half_land_half_ocean",
  {
    infiniteGold: true,
    instantBuild: true,
  },
  [
    playerInfo("Viewer", PlayerType.Human),
    playerInfo("Other", PlayerType.Human),
  ],
);
const self = game.player("Viewer"),
  other = game.player("Other");
for (const [index, player] of [self, other].entries()) {
  const tile = game.ref(3, 3 + index * 8);
  player.setSpawnTile(tile);
  player.conquer(tile);
}
const types = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
];
const structures = types.map((type, index) =>
  self.buildUnit(
    type,
    game.ref(4 + (index % 2) * 2, 1 + Math.floor(index / 2) * 5),
    {},
  ),
);
structures[0].increaseLevel();
structures[4].increaseLevel();
structures[4].increaseLevel();
const port = structures[1];
const warships = [self, self, other].map((owner) =>
  owner.buildUnit(UnitType.Warship, game.ref(10, 3), {
    patrolTile: game.ref(10, 3),
  }),
);
warships[0].increaseLevel();
const transport = self.buildUnit(UnitType.TransportShip, game.ref(10, 10), {});
const tradeShips = Array.from({ length: 24 }, (_, index) => {
  const ship = self.buildUnit(
    UnitType.TradeShip,
    game.ref(12 + (index % 3), Math.floor(index / 3)),
    { targetUnit: port },
  );
  ship.setTargetUnit(port);
  return ship;
});
const images = new MapImages("vision-clarity-e2e");
const region = { x: 0, y: 0, width: 16, height: 16 };
const started = performance.now();
const frame = await images.renderRegion(game, self, region);
const defaultMs = performance.now() - started;
assert.equal(frame.resolution, "high");
assert(frame.width <= 768 && frame.height <= 768);
assert.equal(Math.max(frame.width, frame.height), 768);
assert.equal(frame.overlays.tradeShips, false);
assert.equal(frame.overlays.tradeRoutes, false);
assert(!frame.units.some((unit) => unit.type === UnitType.TradeShip));
assert.equal(frame.tradeTraffic, undefined);
assert.equal(frame.unitCount, structures.length + warships.length + 1);
assert(frame.units.some((unit) => unit.id === transport.id()));
for (const row of frame.units) {
  const unit = game.unit(row.id)!;
  assert.equal(row.type, unit.type());
  assert.equal(row.level, unit.level());
  assert.equal(row.tile, unit.tile());
  assert.equal(row.tile, game.ref(row.x, row.y));
}
const ownFleet = frame.unitGroups.find(
  (group) => group.ownerId === self.id() && group.type === UnitType.Warship,
)!;
assert.equal(ownFleet.count, 2);
assert.deepEqual(
  ownFleet.unitIds,
  warships.slice(0, 2).map((unit) => unit.id()),
);
assert.equal(
  frame.unitGroups.filter((group) => group.type === UnitType.Warship).length,
  2,
);
const noWarships = await images.renderRegion(game, self, region, {
  warships: false,
});
assert(!noWarships.units.some((unit) => unit.type === UnitType.Warship));
assert(noWarships.units.some((unit) => unit.id === transport.id()));
assert(noWarships.units.some((unit) => unit.id === port.id()));
const trade = await images.renderRegion(game, self, region, {
  tradeShips: true,
});
assert.equal(trade.tradeTraffic?.length, 12);
assert.equal(
  trade.unitCount,
  structures.length + warships.length + 1 + tradeShips.length,
);
assert.equal(trade.units.length, 32);
assert(trade.units.some((row) => row.type === UnitType.TradeShip));
assert(trade.tradeTraffic.every((ship) => ship.label === undefined));
assert(!trade.overlays.tradeRoutes);
const routes = await images.renderRegion(game, self, region, {
  units: false,
  tradeRoutes: true,
});
assert.deepEqual(routes.units, []);
assert.equal(routes.tradeTraffic?.length, 12);
const legacy = await images.renderRegion(game, self, region, { units: false });
assert.deepEqual(legacy.units, []);
assert.deepEqual(legacy.unitGroups, []);
const shipsOnly = await images.renderRegion(game, self, region, {
  units: false,
  warships: true,
});
assert(shipsOnly.units.every((unit) => unit.type === UnitType.Warship));
assert.equal(shipsOnly.unitCount, 3);
const standard = await images.renderRegion(
  game,
  self,
  region,
  undefined,
  undefined,
  "standard",
);
assert.equal(standard.resolution, "standard");
assert.equal(Math.max(standard.width, standard.height), 512);
assert.notEqual(standard.path, frame.path);
assert.deepEqual(standard.region, frame.region);
for (const image of [frame, standard, trade, noWarships]) {
  const png = await readFile(image.path);
  assert.equal(png.readUInt32BE(16), image.width);
  assert.equal(png.readUInt32BE(20), image.height);
  const px =
    image.mapPixels.x +
    ((10 - image.region.x) * image.mapPixels.width) / image.region.width;
  assert.equal(
    image.region.x +
      ((px - image.mapPixels.x) * image.region.width) / image.mapPixels.width,
    10,
  );
}
const overviewStart = performance.now();
const overview = (await images.render(game, self)).overview;
const overviewMs = performance.now() - overviewStart;
const pngBytes = {
  crop: (await readFile(frame.path)).length,
  overview: (await readFile(overview.path)).length,
};
assert.equal(Math.max(overview.width, overview.height), 1536);
assert.equal(overview.tradeTraffic, undefined);
assert(overview.units.some((unit) => unit.type === UnitType.Warship));
assert(
  VisionOverlaySchema.safeParse({
    warships: false,
    transports: true,
    structures: true,
    tradeShips: true,
  }).success,
);
assert(!VisionResolutionSchema.safeParse("huge").success);
// Dense fleet metadata must stay bounded, and an omitted marker must not claim a badge.
const hidden = drawUnitMarkers(
  game,
  new Raster(frame.width, frame.height),
  region,
  frame.mapPixels,
  [frame.mapPixels],
  self,
);
assert.deepEqual(hidden.unitGroups, []);
assert.equal(hidden.unitGroupCount, 0);
for (let index = 0; index < 80; index++) {
  const tile = game.ref(8 + (index % 8), Math.floor(index / 8));
  self.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}
const dense = await images.renderRegion(game, self, region, {
  units: false,
  warships: true,
});
assert.equal(dense.unitGroups.length, 32);
assert(dense.unitGroupCount > dense.unitGroups.length);
assert(dense.unitGroups.every((group) => group.unitIds.length <= 32));
const artifact = resolve(".agent-arena/vision-clarity-e2e.json");
await writeFile(
  artifact,
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      defaultMs,
      overviewMs,
      pngBytes,
      frame,
      standard,
      trade,
      noWarships,
      routes,
      overview,
      dense,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: true,
    artifact,
    defaultMs,
    overviewMs,
    pngBytes,
    frame: frame.path,
    trade: trade.path,
  }),
);
