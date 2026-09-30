// Failure cases: water/interior targets become misleading Port hints, coordinate
// labels replace tile IDs, image sites differ from data, or submission hides a
// later affordability failure. Native simulation and images supply the artifact.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { Arena } from "../../src/agents/Arena";
import type { GameToolResult } from "../../src/agents/codex";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { MapImages } from "../../src/agents/vision";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../../src/core/game/Game";
import { createGameRunner } from "../../src/core/GameRunner";
import { ClientMessage, Turn } from "../../src/core/Schemas";

const clientID = "port0001";
const runner = await createGameRunner(
  {
    gameID: "portPlacementE2E",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Europe,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      donateGold: true,
      donateTroops: true,
      bots: 0,
      nations: "disabled",
      randomSpawn: false,
      startingGold: 2_000_000,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
    },
    players: [{ clientID, username: "Port Builder", clanTag: null }],
  },
  undefined,
  new LocalMapLoader(),
  (update) => {
    if ("errMsg" in update) throw new Error(update.errMsg);
  },
);
const game = runner.game;
const intents: Turn["intents"] = [];
const advance = (ticks: number) => {
  for (let i = 0; i < ticks; i++) {
    runner.addTurn({ turnNumber: game.ticks(), intents: intents.splice(0) });
    assert(runner.executeNextTick());
  }
};
const coast = Array.from(
  { length: game.width() * game.height() },
  (_, tile) => tile,
).find(
  (tile) =>
    game.isShore(tile) &&
    !game.isImpassable(tile) &&
    game.x(tile) > 8 &&
    game.y(tile) > 8,
)!;
intents.push({ type: "spawn", tile: coast, clientID });
advance(203);
const self = game.playerByClientID(clientID)!;
for (let tile = 0; tile < game.width() * game.height(); tile++)
  if (game.isLand(tile) && !game.isImpassable(tile)) self.conquer(tile);
const bridge = new AgentGame({ agentCount: 1, tribeCount: 0, nationCount: 0 });
Reflect.set(bridge, "runner", runner);
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
Reflect.set(bridge, "seats", [
  {
    id: "agent001",
    clientId: clientID,
    send(message: ClientMessage) {
      assert.equal(message.type, "intent");
      if (message.type === "intent")
        intents.push({ ...message.intent, clientID });
    },
  },
]);
const builder = new ObservationBuilder(game);
const observe = () =>
  builder.observe("agent001", self, 0, { buildType: UnitType.Port }, []);
const before = observe();
assert.equal(before.map.portPlacement?.terrain, "owned coastal land");
assert.equal(before.map.portPlacement?.requiresAdjacentWater, true);
assert.equal(
  before.map.portPlacement?.minStructureDistance,
  game.config().structureMinDist(),
);
assert.equal(
  before.map.portPlacement?.constructionTicks,
  game.unitInfo(UnitType.Port).constructionDuration ?? 0,
);
const sites = before.map.buildSites.filter((site) => site.upgradeId === false);
assert(sites.length >= 2);
for (const site of sites) {
  assert(game.isLand(site.tile));
  assert(game.isShore(site.tile));
  assert.equal(game.owner(site.tile), self);
  assert(game.neighbors(site.tile).some((tile) => game.isWater(tile)));
  assert.equal(self.canBuild(UnitType.Port, site.tile), site.tile);
}
const interior = [...self.tiles()].find((tile) => !game.isShore(tile))!;
assert.equal(
  builder.observe(
    "agent001",
    self,
    0,
    {
      buildType: UnitType.Port,
      x: game.x(interior),
      y: game.y(interior),
      width: 1,
      height: 1,
    },
    [],
  ).map.buildSites.length,
  0,
  "A one-tile inland region has no Port site",
);
const water = game.neighbors(sites[0].tile).find((tile) => game.isWater(tile))!;
await assert.rejects(
  bridge.act("agent001", {
    type: "build_unit",
    unit: UnitType.Port,
    tile: water,
  }),
  /owned coastal land/,
);
const images = new MapImages("port-placement-e2e");
const region = {
  x: Math.max(0, game.x(sites[0].tile) - 25),
  y: Math.max(0, game.y(sites[0].tile) - 25),
  width: 60,
  height: 60,
};
region.width = Math.min(region.width, game.width() - region.x);
region.height = Math.min(region.height, game.height() - region.y);
const regional = builder.observe(
  "agent001",
  self,
  0,
  { ...region, buildType: UnitType.Port },
  [],
).map.buildSites;
// A broad Port query must fit its image to legal sites far from the spawn.
const farSpawn = [...self.tiles()].find(
  (tile) => game.manhattanDist(tile, sites[0].tile) > 200,
)!;
assert(farSpawn !== undefined);
self.setSpawnTile(farSpawn);
Reflect.set(bridge, "observations", builder);
Reflect.set(bridge, "mapImages", images);
Reflect.set(bridge, "histories", new Map([["agent001", []]]));
const arena = new Arena();
Reflect.set(arena, "state", {
  ...arena.snapshot(),
  phase: "running",
  players: [
    {
      id: "agent001",
      clientId: clientID,
      name: "Port Builder",
      alive: true,
      threadId: null,
      tokens: 0,
      decisions: 0,
      status: "ready",
    },
  ],
});
Reflect.set(arena, "game", bridge);
const tool: (
  id: string,
  name: string,
  args: unknown,
) => Promise<GameToolResult> = Reflect.get(arena, "tool").bind(arena);
const globalQuery = await tool("agent001", "observe_world", {
  buildType: UnitType.Port,
  image: true,
});
const imageResult = z.object({
  image: z.object({
    region: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
    buildSites: z.array(z.object({ tile: z.number() })),
  }),
});
const queriedImage = imageResult.parse(globalQuery.data).image;
for (const site of sites) {
  assert(game.x(site.tile) >= queriedImage.region.x);
  assert(game.x(site.tile) < queriedImage.region.x + queriedImage.region.width);
  assert(game.y(site.tile) >= queriedImage.region.y);
  assert(
    game.y(site.tile) < queriedImage.region.y + queriedImage.region.height,
  );
}
assert.deepEqual(
  queriedImage.buildSites.map((site) => site.tile),
  sites.map((site) => site.tile),
);
const explicitQuery = await tool("agent001", "observe_world", {
  ...region,
  buildType: UnitType.Port,
  image: true,
});
assert.deepEqual(imageResult.parse(explicitQuery.data).image.region, region);
const image = await images.renderRegion(
  game,
  self,
  region,
  undefined,
  regional,
);
assert(image.buildSites?.length);
for (const marker of image.buildSites) {
  assert.equal(marker.tile, regional[Number(marker.label.slice(1)) - 1].tile);
  assert.equal(marker.x, game.x(marker.tile));
  assert.equal(marker.y, game.y(marker.tile));
}
const plain = await images.renderRegion(game, self, region);
assert.equal(plain.buildSites, undefined);
assert.notEqual(plain.path, image.path);
const clean = await images.renderRegion(game, self, region, false, regional);
assert.equal(clean.buildSites, undefined, "overlays:false keeps the map clean");
const png = await readFile(image.path);
const chunks: Buffer[] = [];
for (let at = 8; at < png.length; ) {
  const length = png.readUInt32BE(at);
  if (png.subarray(at + 4, at + 8).toString() === "IDAT")
    chunks.push(png.subarray(at + 8, at + 8 + length));
  at += length + 12;
}
const pixels = inflateSync(Buffer.concat(chunks));
for (const marker of image.buildSites) {
  const x =
    image.mapPixels.x +
    Math.floor(((marker.x - region.x) * image.mapPixels.width) / region.width);
  const y =
    image.mapPixels.y +
    Math.floor(
      ((marker.y - region.y) * image.mapPixels.height) / region.height,
    );
  const offset = y * (image.width * 3 + 1) + 1 + x * 3;
  assert.deepEqual([...pixels.subarray(offset, offset + 3)], [100, 255, 170]);
}
const accepted = await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.Port,
  tile: sites[0].tile,
});
assert.equal(accepted.accepted, true);
assert.equal(
  self.units(UnitType.Port).length,
  0,
  "Submission does not construct a Port",
);
advance(2);
const port = self.units(UnitType.Port)[0];
assert(port);
assert.equal(port.tile(), sites[0].tile);
assert(port.isUnderConstruction());
advance((game.unitInfo(UnitType.Port).constructionDuration ?? 0) + 2);
assert.equal(port.isUnderConstruction(), false);
const second = observe().map.buildSites.find(
  (site) => site.upgradeId === false,
)!;
// Reproduce the live Factory-then-Port batch. Both are affordable when sent,
// but the Factory spends gold and raises the shared Port/Factory price.
self.removeGold(self.gold());
const factoryCost = game.unitInfo(UnitType.Factory).cost(game, self);
self.addGold(factoryCost + 20_000n);
const pendingFactory = await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.Factory,
  tile: second.tile,
});
const pending = await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.Port,
  tile: second.tile,
});
advance(2);
assert.equal(self.units(UnitType.Factory).length, 1);
assert.equal(
  self.units(UnitType.Port).length,
  1,
  "Native execution rejects a Port after gold changes",
);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/port-placement-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      portPlacement: before.map.portPlacement,
      sites,
      globalQueryImage: queriedImage,
      image,
      completed: {
        tile: port.tile(),
        underConstruction: port.isUnderConstruction(),
      },
      acceptedButUnaffordable: {
        factoryAccepted: pendingFactory.accepted,
        goldBeforeBatch: Number(factoryCost + 20_000n),
        portCostBeforeBatch: Number(factoryCost),
        portCostAfterFactory: Number(
          game.unitInfo(UnitType.Port).cost(game, self),
        ),
        accepted: pending.accepted,
        tile: second.tile,
        constructed: false,
      },
    },
    null,
    2,
  ),
);
console.log(
  "Port placement E2E passed. Artifact: .agent-arena/port-placement-e2e.json",
);
