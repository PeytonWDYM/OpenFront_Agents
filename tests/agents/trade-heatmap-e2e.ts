// Failure cases: the 12-ship preview cap truncates density, crops count outside
// traffic, a hotspot lands on land, alliances or teams permit piracy, AFK owner
// and destination rules are conflated, shoreline protection is ignored, missing,
// unfinished, deleted or disconnected Ports permit piracy, patrol and detection
// radii are conflated, density accumulates across ticks, or image coordinates drift.
// A crop must not change native target counts or remove a patrol ring that crosses it.
// Disabling Warship overlays must remove only their rings and icons.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  buildTradeHeatmap,
  requestedWarshipBuildSites,
} from "../../src/agents/game/tradeHeatmap";
import { encodePng } from "../../src/agents/vision/png";
import { Raster } from "../../src/agents/vision/raster";
import { drawTradeHeatmap } from "../../src/agents/vision/tradeHeatmap";
import { TradeShipExecution } from "../../src/core/execution/TradeShipExecution";
import { WarshipExecution } from "../../src/core/execution/WarshipExecution";
import {
  GameMode,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { createGame } from "../core/pathfinding/_fixtures";
import { setup } from "../util/Setup";

const infos = ["viewer", "origin", "destination", "friend"].map(
  (id) => new PlayerInfo(id, PlayerType.Human, null, id),
);
const game = await setup(
  "half_land_half_ocean",
  { infiniteGold: true, instantBuild: true },
  infos,
);
const [viewer, origin, destination, friend] = infos.map((info) =>
  game.player(info.id),
);
const port = (owner: Player, y: number) => {
  const tile = game.ref(7, y);
  owner.conquer(tile);
  owner.setSpawnTile(tile);
  return owner.buildUnit(UnitType.Port, tile, {});
};
const home = port(viewer, 2),
  source = port(origin, 5),
  target = port(destination, 12),
  friendlyPort = port(friend, 15);
for (let tick = 0; tick < 25; tick++) game.executeNextTick();
for (let index = 0; index < 18; index++)
  game.addExecution(new TradeShipExecution(origin, source, target));
game.executeNextTick();
game.executeNextTick();
const ships = origin.units(UnitType.TradeShip);
assert.equal(ships.length, 18);
// Move native voyages into open water. Their native protection cooldown expires.
for (const ship of ships) ship.move(game.ref(14, 7));
for (let tick = 0; tick < 21; tick++) game.executeNextTick();
// Native voyages can finish on the small map. Use native units and destinations
// for each eligibility probe, without replacing Game or Player contracts.
const probe = origin.buildUnit(UnitType.TradeShip, game.ref(14, 7), {
  targetUnit: target,
  lastSetSafeFromPirates: -100,
});
for (let index = 0; index < 17; index++)
  origin.buildUnit(UnitType.TradeShip, game.ref(14, 7), {
    targetUnit: target,
    lastSetSafeFromPirates: -100,
  });
const snapshot = () => buildTradeHeatmap(game, viewer);
const sample = snapshot();
assert.ok(sample.traffic.total > 12);
assert.equal(sample.traffic.eligible, sample.traffic.total);
assert.equal(
  sample.bins.reduce((sum, bin) => sum + bin.total, 0),
  sample.traffic.total,
);
assert.equal(sample.sample.kind, "instant");
assert.equal(sample.sample.windowTicks, 0);
assert.equal(sample.tick, game.ticks());
assert.ok(sample.hotspots.length <= 12);
assert.ok(sample.bins.length <= 1024);
assert.ok(
  sample.hotspots.every(
    (spot) =>
      game.isWater(spot.tile) &&
      game.x(spot.tile) === spot.x &&
      game.y(spot.tile) === spot.y,
  ),
);
assert.ok(
  sample.hotspots.every(
    (spot) =>
      spot.launch &&
      viewer.canBuild(UnitType.Warship, spot.tile) === spot.launch.portTile,
  ),
);
const buildChoices = requestedWarshipBuildSites(game, viewer, {});
assert.ok(buildChoices.sites.length > 0 && buildChoices.sites.length <= 12);
assert.equal(buildChoices.sites[0].tile, sample.hotspots[0].tile);
assert.ok(
  buildChoices.sites.every(
    (site) =>
      game.isWater(site.tile) &&
      viewer.canBuild(UnitType.Warship, site.tile) ===
        site.context.launchPortTile,
  ),
);
assert.equal(
  requestedWarshipBuildSites(game, viewer, { x: 0, y: 0, width: 2, height: 2 })
    .sites.length,
  0,
);

const before = sample.traffic.eligible;
probe.setSafeFromPirates();
assert.equal(
  snapshot().traffic.eligible,
  before - 1,
  "Native shoreline protection excludes the ship",
);
probe.delete(false);
const protectedShip = viewer.buildUnit(UnitType.TradeShip, game.ref(14, 7), {
  targetUnit: target,
  lastSetSafeFromPirates: -100,
});
assert.equal(snapshot().traffic.eligible, before - 1, "Own ships are excluded");
protectedShip.delete(false);
const incoming = origin.buildUnit(UnitType.TradeShip, game.ref(14, 7), {
  targetUnit: home,
  lastSetSafeFromPirates: -100,
});
assert.equal(
  snapshot().traffic.eligible,
  before - 1,
  "Own destination excludes piracy",
);
incoming.delete(false);

viewer.createAllianceRequest(friend)!.accept();
const alliedOwner = friend.buildUnit(UnitType.TradeShip, game.ref(14, 7), {
  targetUnit: target,
  lastSetSafeFromPirates: -100,
});
const alliedDestination = origin.buildUnit(
  UnitType.TradeShip,
  game.ref(14, 7),
  { targetUnit: friendlyPort, lastSetSafeFromPirates: -100 },
);
assert.equal(snapshot().traffic.eligible, before - 1);
friend.markDisconnected(true);
assert.equal(
  snapshot().traffic.eligible,
  before - 1,
  "Disconnected allied owners remain protected",
);
viewer.markDisconnected(true);
assert.equal(
  snapshot().traffic.eligible,
  before,
  "Native destination friendliness tests the pirate's disconnected state",
);
viewer.markDisconnected(false);
friend.markDisconnected(false);
alliedOwner.delete(false);
alliedDestination.delete(false);

home.setUnderConstruction(true);
assert.equal(
  snapshot().traffic.eligible,
  0,
  "An unfinished Port cannot receive captures",
);
assert.ok(snapshot().hotspots.every((spot) => !spot.launch));
home.setUnderConstruction(false);
home.markForDeletion();
assert.equal(
  snapshot().traffic.eligible,
  0,
  "A deletion-marked Port cannot receive captures",
);
home.delete(false);
assert.equal(
  snapshot().traffic.eligible,
  0,
  "A missing Port cannot receive captures",
);
const replacement = port(viewer, 2);
assert.ok(snapshot().traffic.eligible > 0);

const cropped = buildTradeHeatmap(game, viewer, {
  x: 14,
  y: 7,
  width: 1,
  height: 1,
});
assert.equal(
  cropped.traffic.total,
  game
    .units(UnitType.TradeShip)
    .filter((ship) => ship.tile() === game.ref(14, 7)).length,
);
assert.equal(
  buildTradeHeatmap(game, viewer, { x: 0, y: 0, width: 2, height: 2 }).traffic
    .total,
  0,
);
assert.equal(
  snapshot().traffic.total,
  snapshot().traffic.total,
  "Repeated observations do not accumulate voyages",
);

const warship = viewer.buildUnit(UnitType.Warship, game.ref(9, 7), {
  patrolTile: game.ref(14, 7),
});
const enemyWarship = origin.buildUnit(UnitType.Warship, game.ref(15, 11), {
  patrolTile: game.ref(15, 11),
});
const withShips = snapshot();
const own = withShips.warships.find((ship) => ship.id === warship.id())!;
assert.equal(own.patrol!.tile, warship.warshipState().patrolTile);
assert.equal(own.targetEligibleTraffic, withShips.traffic.eligible);
assert.equal(own.detectionRadius, 130);
assert.equal(own.patrol!.radius, 100);
assert.equal(withShips.rules.captureManhattanDistance, 5);
assert.equal(
  withShips.warships.find((ship) => ship.id === enemyWarship.id())!.health,
  enemyWarship.toUpdate().health,
);
assert.ok(!("targetUnit" in withShips.warships[0]));
// Native execution chooses one target and chases. It does not capture every ship.
enemyWarship.delete(false);
const execution = new WarshipExecution(warship);
execution.init(game, game.ticks());
const eligibleBeforeChase = snapshot().traffic.eligible;
execution.tick(game.ticks());
assert.ok(viewer.units(UnitType.TradeShip).length <= 1);
assert.ok(snapshot().traffic.eligible >= eligibleBeforeChase - 1);

const teamInfos = ["t1", "t2", "e1", "e2"].map(
  (id, index) =>
    new PlayerInfo(
      id,
      PlayerType.Human,
      null,
      id,
      false,
      index < 2 ? "ALPHA" : "BETA",
    ),
);
const teams = await setup(
  "half_land_half_ocean",
  {
    gameMode: GameMode.Team,
    playerTeams: 2,
    infiniteGold: true,
    instantBuild: true,
  },
  teamInfos,
);
const [t1, t2, e1, e2] = teamInfos.map((info) => teams.player(info.id));
for (const [index, owner] of [t1, t2, e1, e2].entries()) {
  owner.conquer(teams.ref(7, index * 3));
  owner.setSpawnTile(teams.ref(7, index * 3));
  owner.buildUnit(UnitType.Port, teams.ref(7, index * 3), {});
}
assert.ok(t1.isOnSameTeam(t2));
t2.buildUnit(UnitType.TradeShip, teams.ref(14, 7), {
  targetUnit: e1.units(UnitType.Port)[0],
  lastSetSafeFromPirates: -100,
});
e1.buildUnit(UnitType.TradeShip, teams.ref(14, 7), {
  targetUnit: t2.units(UnitType.Port)[0],
  lastSetSafeFromPirates: -100,
});
assert.equal(
  buildTradeHeatmap(teams, t1).traffic.eligible,
  0,
  "Team owners and destinations are excluded",
);

// A full native simulation on a generated coast tests both radius boundaries
// and a second water component. No simulation or spatial-query mocks are used.
const wide = createGame({
  width: 360,
  height: 200,
  grid: Array.from({ length: 360 * 200 }, (_, tile) =>
    tile % 360 === 0 || (tile % 360 >= 300 && tile % 360 <= 303) ? "L" : "W",
  ),
});
wide.endSpawnPhase();
const [pirate, merchant, partner] = ["pirate", "merchant", "partner"].map(
  (id) => wide.addPlayer(new PlayerInfo(id, PlayerType.Human, null, id)),
);
for (const [index, owner] of [pirate, merchant, partner].entries()) {
  owner.conquer(wide.ref(0, index * 30 + 30));
  owner.setSpawnTile(wide.ref(0, index * 30 + 30));
  owner.buildUnit(UnitType.Port, wide.ref(0, index * 30 + 30), {});
  owner.addGold(1_000_000_000n);
}
const scout = pirate.buildUnit(UnitType.Warship, wide.ref(100, 100), {
  patrolTile: wide.ref(230, 100),
});
const boundary = merchant.buildUnit(UnitType.TradeShip, wide.ref(230, 100), {
  targetUnit: partner.units(UnitType.Port)[0],
  lastSetSafeFromPirates: -100,
});
const targetCount = () =>
  buildTradeHeatmap(wide, pirate).warships.find(
    (ship) => ship.id === scout.id(),
  )!.targetEligibleTraffic;
assert.equal(targetCount(), 1, "Detection includes the 130-tile boundary");
boundary.move(wide.ref(231, 100));
assert.equal(
  targetCount(),
  0,
  "Detection excludes 131 tiles from current position",
);
boundary.move(wide.ref(200, 100));
scout.updateWarshipState({ patrolTile: wide.ref(100, 100) });
assert.equal(
  targetCount(),
  1,
  "Patrol eligibility includes the 100-tile boundary",
);
boundary.move(wide.ref(201, 100));
assert.equal(
  targetCount(),
  0,
  "Patrol eligibility excludes 101 tiles despite detection",
);
boundary.move(wide.ref(330, 100));
const disconnected = buildTradeHeatmap(wide, pirate, {
  x: 304,
  y: 0,
  width: 56,
  height: 200,
});
assert.equal(disconnected.traffic.total, 1);
assert.equal(
  disconnected.traffic.eligible,
  0,
  "Piracy needs an owned Port in this water component",
);
assert.ok(disconnected.hotspots.every((spot) => !spot.launch));

for (const [x, y, count, protectedFromPirates] of [
  [140, 120, 8, false],
  [220, 150, 3, false],
  [90, 60, 6, true],
] as const) {
  for (let index = 0; index < count; index++)
    merchant.buildUnit(UnitType.TradeShip, wide.ref(x, y), {
      targetUnit: partner.units(UnitType.Port)[0],
      lastSetSafeFromPirates: protectedFromPirates ? wide.ticks() : -100,
    });
}
merchant.buildUnit(UnitType.Warship, wide.ref(260, 150), {
  patrolTile: wide.ref(220, 130),
});
const quietShipCrop = buildTradeHeatmap(wide, pirate, {
  x: 90,
  y: 90,
  width: 20,
  height: 20,
});
assert.equal(quietShipCrop.traffic.total, 0, "Crop density stays regional");
assert.equal(
  quietShipCrop.warships.find((ship) => ship.id === scout.id())!
    .targetEligibleTraffic,
  8,
  "A quiet crop preserves native targets outside its density region",
);
scout.updateWarshipState({ patrolTile: wide.ref(240, 100) });
const quietPatrolRegion = { x: 330, y: 40, width: 20, height: 20 };
const quietPatrolCrop = buildTradeHeatmap(wide, pirate, quietPatrolRegion);
assert.equal(quietPatrolCrop.traffic.total, 0);
assert.equal(quietPatrolCrop.hotspots.length, 0);
assert.ok(
  quietPatrolCrop.warships.some((ship) => ship.id === scout.id()),
  "A public patrol ring crossing a quiet crop remains visible even when the ship and its detection circle are outside",
);
const cropRaster = new Raster(320, 270);
const cropPixels = { x: 36, y: 24, width: 200, height: 200 };
cropRaster.fill(
  cropPixels.x,
  cropPixels.y,
  cropPixels.width,
  cropPixels.height,
  [35, 68, 91],
);
drawTradeHeatmap(
  cropRaster,
  wide,
  quietPatrolRegion,
  cropPixels,
  quietPatrolCrop,
  232,
);
let visibleOwnRingPixels = 0;
for (let y = cropPixels.y; y < cropPixels.y + cropPixels.height; y++)
  for (let x = cropPixels.x; x < cropPixels.x + cropPixels.width; x++) {
    const at = (y * cropRaster.width + x) * 3;
    if (
      cropRaster.rgb[at] === 114 &&
      cropRaster.rgb[at + 1] === 244 &&
      cropRaster.rgb[at + 2] === 154
    )
      visibleOwnRingPixels++;
  }
assert.ok(
  visibleOwnRingPixels > 0,
  "The saved quiet crop contains the actual intersecting own patrol ring",
);
const hiddenShipsCropRaster = new Raster(320, 270);
hiddenShipsCropRaster.fill(
  cropPixels.x,
  cropPixels.y,
  cropPixels.width,
  cropPixels.height,
  [35, 68, 91],
);
drawTradeHeatmap(
  hiddenShipsCropRaster,
  wide,
  quietPatrolRegion,
  cropPixels,
  quietPatrolCrop,
  232,
  false,
);
for (let y = cropPixels.y; y < cropPixels.y + cropPixels.height; y++)
  for (let x = cropPixels.x; x < cropPixels.x + cropPixels.width; x++) {
    const at = (y * hiddenShipsCropRaster.width + x) * 3;
    assert.deepEqual(
      [...hiddenShipsCropRaster.rgb.subarray(at, at + 3)],
      [35, 68, 91],
      "Disabling Warships removes a patrol ring from the actual raster",
    );
  }
scout.updateWarshipState({ patrolTile: wide.ref(100, 100) });
const regionalSnapshot = buildTradeHeatmap(wide, pirate);
const region = { x: 0, y: 0, width: 360, height: 200 };
const mapPixels = { x: 36, y: 24, width: 528, height: 294 };
const raster = new Raster(600, 390);
for (let py = 0; py < mapPixels.height; py++)
  for (let px = 0; px < mapPixels.width; px++) {
    const tile = wide.ref(
      Math.floor(((px + 0.5) * region.width) / mapPixels.width),
      Math.floor(((py + 0.5) * region.height) / mapPixels.height),
    );
    raster.pixel(
      mapPixels.x + px,
      mapPixels.y + py,
      wide.isWater(tile) ? [35, 68, 91] : [143, 151, 117],
    );
  }
const hiddenShipsRaster = new Raster(raster.width, raster.height);
hiddenShipsRaster.rgb.set(raster.rgb);
const rendered = drawTradeHeatmap(
  raster,
  wide,
  region,
  mapPixels,
  regionalSnapshot,
  336,
);
const renderedWithoutShips = drawTradeHeatmap(
  hiddenShipsRaster,
  wide,
  region,
  mapPixels,
  regionalSnapshot,
  336,
  false,
);
assert.deepEqual(
  renderedWithoutShips.hotspots,
  rendered.hotspots,
  "Warship layers do not change traffic or hotspot data",
);
let densityPixelsWithoutShips = 0;
for (let y = mapPixels.y; y < mapPixels.y + mapPixels.height; y++)
  for (let x = mapPixels.x; x < mapPixels.x + mapPixels.width; x++) {
    const at = (y * hiddenShipsRaster.width + x) * 3;
    const color = [...hiddenShipsRaster.rgb.subarray(at, at + 3)];
    assert.notDeepEqual(
      color,
      [114, 244, 154],
      "Disabling Warships removes own icons and rings",
    );
    assert.notDeepEqual(
      color,
      [255, 104, 111],
      "Disabling Warships removes enemy icons and rings",
    );
    if (color[0] > 100 && color[1] > 100 && color[2] < 100)
      densityPixelsWithoutShips++;
  }
assert.ok(
  densityPixelsWithoutShips > 0,
  "Eligible traffic density stays visible when Warships are disabled",
);
for (const marker of rendered.hotspots) {
  assert.equal(
    marker.pixelX,
    mapPixels.x +
      Math.floor(((marker.x - region.x) * mapPixels.width) / region.width),
  );
  assert.equal(
    marker.pixelY,
    mapPixels.y +
      Math.floor(((marker.y - region.y) * mapPixels.height) / region.height),
  );
}
assert.ok(rendered.hotspots.length > 0);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/trade-heatmap-crop-e2e.png",
  await encodePng(cropRaster.width, cropRaster.height, cropRaster.rgb),
);
await writeFile(
  ".agent-arena/trade-heatmap-e2e.png",
  await encodePng(raster.width, raster.height, raster.rgb),
);
await writeFile(
  ".agent-arena/trade-heatmap-no-warships-e2e.png",
  await encodePng(
    hiddenShipsRaster.width,
    hiddenShipsRaster.height,
    hiddenShipsRaster.rgb,
  ),
);
await writeFile(
  ".agent-arena/trade-heatmap-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      initial: sample,
      current: snapshot(),
      cropped,
      disconnected,
      regionalSnapshot,
      quietShipCrop,
      quietPatrolCrop,
      visibleOwnRingPixels,
      densityPixelsWithoutShips,
      renderedWithoutShips,
      rendered,
      replacementPort: replacement.id(),
    },
    null,
    2,
  ),
);
console.log(
  "Native trade heatmap fixture passed. JSON and PNG: .agent-arena/trade-heatmap-e2e.*",
);
