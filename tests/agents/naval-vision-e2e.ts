import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { MapImages } from "../../src/agents/vision";
import {
  drawUnitMarkers,
  TradeTrafficMarker,
} from "../../src/agents/vision/markers";
import { resolveOverlays } from "../../src/agents/vision/options";
import { encodePng } from "../../src/agents/vision/png";
import { Raster, Region } from "../../src/agents/vision/raster";
import {
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { setup } from "../util/Setup";

// Failure cases: ship IDs or public owners disappear, team and ally colors merge,
// destination cues use private paths or point at the source, off-crop ships enter
// details, labels overlap, cues leave the map, dense traffic exceeds twelve details,
// tiny crops overflow, or the shared overview includes viewer-specific relations.
// This native simulation fixture is a synthetic 16x16 coast, not a geographic map.
const game = await setup(
  "half_land_half_ocean",
  {
    gameMode: GameMode.Team,
    playerTeams: 3,
    infiniteGold: true,
    instantBuild: true,
  },
  [
    new PlayerInfo("Viewer", PlayerType.Human, "viewer", "viewer", false, "A"),
    new PlayerInfo("Team", PlayerType.Human, "team", "team", false, "A"),
    new PlayerInfo("Ally", PlayerType.Human, "ally", "ally", false, "B"),
    new PlayerInfo("Other", PlayerType.Human, "other", "other", false, "C"),
  ],
);
const owners = ["viewer", "team", "ally", "other"].map((id) => game.player(id));
const self = owners[0];
for (const [index, player] of owners.entries()) {
  const tile = game.ref(3, index * 4 + 1);
  player.setSpawnTile(tile);
  player.conquer(tile);
}
self.createAllianceRequest(owners[2])!.accept();
const ports = owners.map((owner, index) =>
  owner.buildUnit(UnitType.Port, game.ref(7, index * 4 + 1), {}),
);
const ships = owners.map((owner, index) => {
  const ship = owner.buildUnit(
    UnitType.TradeShip,
    game.ref(11, index * 4 + 2),
    { targetUnit: ports[(index + 1) % ports.length] },
  );
  ship.setTargetUnit(ports[(index + 1) % ports.length]);
  return ship;
});
const images = new MapImages("synthetic-coast-naval-vision-e2e");
const region = { x: 5, y: 0, width: 11, height: 16 };
const frame = await images.renderRegion(game, self, region, {
  tradeRoutes: true,
  tradeShips: true,
});
// Independent layer failures: route cues disappear when unit markers are off.
const routeOnly = await images.renderRegion(game, self, region, {
  labels: false,
  grid: false,
  units: false,
  tradeRoutes: true,
});
assert.equal(routeOnly.tradeTraffic?.length, 4);
assert.deepEqual(routeOnly.units, []);
assert(routeOnly.tradeTraffic?.every((ship) => ship.label === undefined));
assert(frame.tradeTraffic, "Personal images must explain their trade labels");
assert.equal(frame.tradeTraffic.length, 4);
const colors = [
  [255, 241, 116],
  [91, 221, 139],
  [100, 223, 246],
  [239, 104, 99],
];
const affiliations = ["self", "team", "ally", "other"];
const png = await readFile(frame.path);
const chunks: Buffer[] = [];
for (let at = 8; at < png.length; ) {
  const length = png.readUInt32BE(at);
  if (png.subarray(at + 4, at + 8).toString() === "IDAT")
    chunks.push(png.subarray(at + 8, at + 8 + length));
  at += length + 12;
}
const pixels = inflateSync(Buffer.concat(chunks));
const pixel = (x: number, y: number) => [
  ...pixels.subarray(
    y * (frame.width * 3 + 1) + 1 + x * 3,
    y * (frame.width * 3 + 1) + 4 + x * 3,
  ),
];
const position = (tile: number) => ({
  x:
    frame.mapPixels.x +
    Math.floor(
      ((game.x(tile) - region.x) * frame.mapPixels.width) / region.width,
    ),
  y:
    frame.mapPixels.y +
    Math.floor(
      ((game.y(tile) - region.y) * frame.mapPixels.height) / region.height,
    ),
});
for (const [index, ship] of ships.entries()) {
  const detail: TradeTrafficMarker = frame.tradeTraffic.find(
    (row) => row.id === ship.id(),
  )!;
  assert.equal(detail.ownerId, ship.owner().id());
  assert.equal(detail.ownerSmallId, ship.owner().smallID());
  assert.equal(detail.affiliation, affiliations[index]);
  assert.equal(detail.label, undefined, "Precise ship IDs belong in metadata");
  assert.equal(detail.destination?.id, ship.toUpdate().targetUnitId);
  assert.equal(detail.destination?.x, game.x(ship.targetUnit()!.tile()));
  const point = position(ship.tile());
  let colored = 0;
  for (let y = point.y - 10; y <= point.y + 10; y++)
    for (let x = point.x - 10; x <= point.x + 10; x++)
      if (pixel(x, y).every((channel, at) => channel === colors[index][at]))
        colored++;
  assert(
    colored > 15,
    "A recognizable ship icon must use the native affiliation color",
  );
  const endpoint = position(ship.targetUnit()!.tile());
  assert.deepEqual(
    pixel(endpoint.x, endpoint.y - 3),
    colors[index],
    "A diamond must mark the public destination",
  );
}
assert.deepEqual(
  Object.keys(frame.tradeTraffic[0]).sort(),
  [
    "affiliation",
    "destination",
    "id",
    "ownerId",
    "ownerSmallId",
    "tile",
    "type",
    "x",
    "y",
  ].sort(),
);
assert(
  !JSON.stringify(frame.tradeTraffic).match(
    /sourcePort|origOwner|cargo|gold|path|troops/,
  ),
);
const overviewA = (await images.render(game, self)).overview;
const overviewB = (await images.render(game, owners[3])).overview;
assert.equal(overviewA, overviewB);
assert.equal(overviewA.tradeTraffic, undefined);
const offCrop = await images.renderRegion(
  game,
  self,
  {
    x: 9,
    y: 0,
    width: 5,
    height: 3,
  },
  { tradeShips: true },
);
assert.deepEqual(
  offCrop.tradeTraffic?.map((row) => row.id),
  [ships[0].id()],
);
assert.equal(offCrop.tradeTraffic![0].destination?.inRegion, false);
const tiny = await images.renderRegion(game, self, {
  x: 11,
  y: 2,
  width: 1,
  height: 1,
});
assert(tiny.width <= 768 && tiny.height <= 768);
const occupied: Region[] = [];
const markerRaster = new Raster(frame.width, frame.height);
const markerDetails = drawUnitMarkers(
  game,
  markerRaster,
  region,
  frame.mapPixels,
  occupied,
  self,
  resolveOverlays({ tradeShips: true }),
);
const labelBoxes = occupied;
assert(markerDetails.tradeTraffic.every((row) => row.label === undefined));
for (const [index, box] of labelBoxes.entries()) {
  assert(box.x >= frame.mapPixels.x && box.y >= frame.mapPixels.y);
  assert(box.x + box.width <= frame.mapPixels.x + frame.mapPixels.width);
  assert(box.y + box.height <= frame.mapPixels.y + frame.mapPixels.height);
  for (const previous of labelBoxes.slice(0, index))
    assert(
      box.x >= previous.x + previous.width ||
        box.x + box.width <= previous.x ||
        box.y >= previous.y + previous.height ||
        box.y + box.height <= previous.y,
      "Unit icons and badges must not overlap",
    );
}
const skinnyRegion = { x: 11, y: 0, width: 1, height: 16 };
const skinnyPixels = { x: 10, y: 10, width: 2, height: 80 };
const clipped = new Raster(24, 100);
const beforeClip = clipped.rgb.slice();
const skinnyDetails = drawUnitMarkers(
  game,
  clipped,
  skinnyRegion,
  skinnyPixels,
  [],
  self,
);
assert(skinnyDetails.tradeTraffic.every((row) => row.label === undefined));
for (let y = 0; y < clipped.height; y++)
  for (let x = 0; x < clipped.width; x++) {
    if (
      x >= skinnyPixels.x &&
      x < skinnyPixels.x + skinnyPixels.width &&
      y >= skinnyPixels.y &&
      y < skinnyPixels.y + skinnyPixels.height
    )
      continue;
    const at = (y * clipped.width + x) * 3;
    assert.deepEqual(
      clipped.rgb.subarray(at, at + 3),
      beforeClip.subarray(at, at + 3),
      "Trade overlays must stay inside the requested map pixels",
    );
  }
ships[0].setTargetUnit(undefined);
assert.equal(
  (
    await images.renderRegion(game, self, region, { tradeShips: true })
  ).tradeTraffic?.find((row) => row.id === ships[0].id())?.destination,
  undefined,
);
ships[0].setTargetUnit(ports[1]);
ships[0].setOwner(owners[3]);
assert.equal(
  (
    await images.renderRegion(game, self, region, { tradeShips: true })
  ).tradeTraffic?.find((row) => row.id === ships[0].id())?.affiliation,
  "other",
);
for (let index = 0; index < 18; index++) {
  const ship = owners[3].buildUnit(
    UnitType.TradeShip,
    game.ref(9 + Math.floor(index / 16), index % 16),
    { targetUnit: ports[0] },
  );
  ship.setTargetUnit(ports[0]);
}
const dense = await images.renderRegion(game, self, region, {
  tradeShips: true,
});
assert.equal(dense.tradeTraffic?.length, 12);
const artifact = resolve(".agent-arena/synthetic-coast-naval-vision-e2e.json");
const fixturePng = resolve(".agent-arena/synthetic-coast-public-trade.png");
const fixtureRaster = new Raster(frame.width, frame.height);
for (let y = 0; y < frame.height; y++) {
  const start = y * (frame.width * 3 + 1) + 1;
  fixtureRaster.rgb.set(
    pixels.subarray(start, start + frame.width * 3),
    y * frame.width * 3,
  );
}
fixtureRaster.fill(0, 0, frame.width, 20, [15, 23, 34]);
fixtureRaster.text("SYNTHETIC COAST FIXTURE", 8, 7);
await writeFile(
  fixturePng,
  await encodePng(frame.width, frame.height, fixtureRaster.rgb),
);
await writeFile(
  artifact,
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      fixture:
        "Synthetic 16x16 coast with manually placed native ships and ports. Not a geographic map or live game.",
      frame: { ...frame, path: fixturePng },
      offCrop,
      tiny,
      dense,
      detailedLabelsDoNotOverlap: true,
      overlayPixelsClipped: true,
      missingPublicDestinationOmitted: true,
      privacy:
        "Only public current owner, position and destination. Straight-line cues are not sailing paths.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: true,
    artifact,
    frame: fixturePng,
    inferenceRequests: 0,
  }),
);
