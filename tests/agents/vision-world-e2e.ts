import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { MapImages } from "../../src/agents/vision";
import {
  GameMapType,
  PlayerType,
  Structures,
  UnitType,
} from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

// Failure cases: full-size geography exceeds image limits, high and standard
// overwrite each other, metadata moves units away from native tiles, or default
// trade clutter returns on a real map. Units are placed manually in the native
// simulation. This check never connects to a server or runs model inference.
const game = await setup(
  "giantworldmap",
  {
    gameMap: GameMapType.GiantWorldMap,
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
const land = (x: number, y: number) =>
  game.isLand(game.ref(x, y)) && !game.isImpassable(game.ref(x, y));
const nearest = (x: number, y: number, wantsLand: boolean) => {
  for (let radius = 0; radius <= 200; radius++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const px = x + dx,
          py = y + dy;
        if (px < 0 || py < 0 || px >= game.width() || py >= game.height())
          continue;
        if (wantsLand ? land(px, py) : game.isWater(game.ref(px, py)))
          return game.ref(px, py);
      }
  throw new Error("Fixture has no nearby terrain tile");
};
for (const [index, player] of [self, other].entries()) {
  const origin = nearest(1960 + index * 130, 430 + index * 100, true);
  player.setSpawnTile(origin);
  for (let dy = -70; dy <= 70; dy++)
    for (let dx = -70; dx <= 70; dx++) {
      const x = game.x(origin) + dx,
        y = game.y(origin) + dy;
      if (land(x, y)) player.conquer(game.ref(x, y));
    }
}
const origin = self.spawnTile()!;
const structures = Structures.types.map((type, index) => {
  const tile = nearest(
    game.x(origin) - 45 + (index % 3) * 35,
    game.y(origin) - 35 + Math.floor(index / 3) * 60,
    true,
  );
  const unit = self.buildUnit(type, tile, {});
  for (let level = 0; level < index % 3; level++) unit.increaseLevel();
  return unit;
});
const water = nearest(game.x(origin), game.y(origin), false);
for (let index = 0; index < 4; index++)
  self.buildUnit(UnitType.Warship, water, { patrolTile: water });
self.buildUnit(
  UnitType.TransportShip,
  nearest(game.x(water) + 30, game.y(water), false),
  {},
);
const port = structures.find((unit) => unit.type() === UnitType.Port)!;
for (let index = 0; index < 100; index++) {
  const tile = nearest(
    game.x(water) - 60 + (index % 10) * 12,
    game.y(water) - 60 + Math.floor(index / 10) * 12,
    false,
  );
  const ship = other.buildUnit(UnitType.TradeShip, tile, { targetUnit: port });
  ship.setTargetUnit(port);
}
const images = new MapImages("vision-giantworld-e2e");
const renderStart = performance.now();
const high = await images.render(game, self);
const highMs = performance.now() - renderStart;
const standardStart = performance.now();
const standard = await images.render(game, self, undefined, "standard");
const standardMs = performance.now() - standardStart;
assert.equal(Math.max(high.overview.width, high.overview.height), 1536);
assert.equal(Math.max(standard.overview.width, standard.overview.height), 1024);
assert.notEqual(high.overview.path, standard.overview.path);
assert.deepEqual(high.overview.region, {
  x: 0,
  y: 0,
  width: 4108,
  height: 1948,
});
assert(high.tactical);
assert(!high.tactical.units.some((unit) => unit.type === UnitType.TradeShip));
assert.equal(
  high.tactical.unitGroups.find((group) => group.type === UnitType.Warship)
    ?.count,
  4,
);
for (const image of [high.overview, high.tactical, standard.overview]) {
  const png = await readFile(image.path);
  assert.equal(png.readUInt32BE(16), image.width);
  assert.equal(png.readUInt32BE(20), image.height);
  for (const row of image.units)
    assert.equal(game.unit(row.id)!.tile(), row.tile);
}
const artifact = resolve(".agent-arena/vision-giantworld-e2e.json");
const bytes = {
  high: (await readFile(high.overview.path)).length,
  standard: (await readFile(standard.overview.path)).length,
};
await writeFile(
  artifact,
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      fixture:
        "Native 4108x1948 Giant World Map with manually placed territories and units",
      highMs,
      standardMs,
      bytes,
      high,
      standard,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: true,
    artifact,
    highMs,
    standardMs,
    bytes,
    overview: high.overview.path,
    tactical: high.tactical.path,
  }),
);
