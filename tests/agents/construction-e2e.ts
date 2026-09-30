// Failure cases: unaffordable or invalid builds reported as accepted, missing
// routine prices, Transport build hints, and accepted builds that never execute.
// Build-site query failures: only one fresh Port appears, suggested ports collide
// at native spacing, an explicit region returns distant sites, or an upgrade ID
// is mislabeled as a new port. This check uses the native compact Europe map.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { projectDecisionObservation } from "../../src/agents/game/decision";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
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

const clientID = "build001";
const runner = await createGameRunner(
  {
    gameID: "agentConstructionE2E",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Europe,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      bots: 0,
      nations: "disabled",
      randomSpawn: false,
      startingGold: 50_000,
      donateGold: true,
      donateTroops: true,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
    },
    players: [{ clientID, username: "Builder", clanTag: null }],
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
    assert.ok(runner.executeNextTick());
  }
};
let shore = 0;
for (let tile = 0; tile < game.width() * game.height(); tile++) {
  if (
    game.isLand(tile) &&
    game.isShore(tile) &&
    !game.isImpassable(tile) &&
    game.x(tile) > 8 &&
    game.y(tile) > 8
  ) {
    shore = tile;
    break;
  }
}
intents.push({ type: "spawn", tile: shore, clientID });
advance(203);
const self = game.playerByClientID(clientID)!;
const bridge = new AgentGame({ agentCount: 1, tribeCount: 0, nationCount: 0 });
Reflect.set(bridge, "runner", runner);
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
// The fixture transport feeds submitted intents to the real native runner.
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
const observe = () => builder.observe("agent001", self, 0, {}, []);
const initialGold = Number(self.gold());
assert.ok(initialGold < 125_000);
await assert.rejects(
  bridge.act("agent001", {
    type: "build_unit",
    unit: UnitType.City,
    tile: shore,
  }),
  /Cannot build City/,
);
assert.equal(
  intents.length,
  0,
  "Rejected builds never reach the native runner",
);
const prices = projectDecisionObservation(observe()).buildCosts;
assert.ok(
  prices?.some((cost) => cost.type === UnitType.City && cost.cost === 125_000),
);
assert.ok(
  !observe().map.buildSites.some(
    (site) => site.type === UnitType.TransportShip,
  ),
);
await assert.rejects(
  bridge.act("agent001", {
    type: "build_unit",
    unit: UnitType.TransportShip,
    tile: shore,
  }),
  /boat/,
);
self.addGold(500_000n);
// Seed enough owned coast to test two structures without a spacing conflict.
for (let tile = 0; tile < game.width() * game.height(); tile++) {
  if (
    game.isLand(tile) &&
    !game.isImpassable(tile) &&
    game.manhattanDist(tile, shore) < 60
  )
    self.conquer(tile);
}
const citySite = observe().map.buildSites.find(
  (site) => site.type === UnitType.City,
)!;
assert.ok(citySite);
await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.City,
  tile: citySite.tile,
});
advance(30);
assert.equal(self.units(UnitType.City).length, 1);
assert.ok(!self.units(UnitType.City)[0].isUnderConstruction());
const portShore = [...self.tiles()].find(
  (tile) => game.isShore(tile) && self.canBuild(UnitType.Port, tile) !== false,
);
assert.ok(portShore !== undefined);
const portTile = self.canBuild(UnitType.Port, portShore);
assert.notEqual(portTile, false);
await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.Port,
  tile: Number(portTile),
});
advance(60);
assert.equal(self.units(UnitType.Port).length, 1);
assert.ok(!self.units(UnitType.Port)[0].isUnderConstruction());
self.addGold(100_000_000n);
for (let tile = 0; tile < game.width() * game.height(); tile++) {
  if (game.isLand(tile) && game.isShore(tile) && !game.isImpassable(tile))
    self.conquer(tile);
}
const queriedSites = builder.observe(
  "agent001",
  self,
  0,
  { buildType: UnitType.Port },
  [],
).map.buildSites;
const freshPorts = queriedSites.filter((site) => site.upgradeId === false);
assert(
  freshPorts.length >= 5,
  "The site query must expose at least five legal fresh Ports on this coast",
);
assert(queriedSites.length <= 12);
for (const [index, site] of freshPorts.entries()) {
  assert.equal(site.type, UnitType.Port);
  assert.equal(site.x, game.x(site.tile));
  assert.equal(site.y, game.y(site.tile));
  assert.notEqual(self.canBuild(UnitType.Port, site.tile), false);
  for (const previous of freshPorts.slice(0, index))
    assert(
      game.euclideanDistSquared(site.tile, previous.tile) >=
        game.config().structureMinDist() ** 2,
    );
}
const first = freshPorts[0];
const siteRegion = {
  x: game.x(first.tile),
  y: game.y(first.tile),
  width: 1,
  height: 1,
};
const regionalSites = builder.observe(
  "agent001",
  self,
  0,
  { ...siteRegion, buildType: UnitType.Port },
  [],
).map.buildSites;
assert(regionalSites.every((site) => site.tile === first.tile));
const port = self.units(UnitType.Port)[0];
const upgradeSites = builder.observe(
  "agent001",
  self,
  0,
  {
    buildType: UnitType.Port,
    x: game.x(port.tile()),
    y: game.y(port.tile()),
    width: 1,
    height: 1,
  },
  [],
).map.buildSites;
assert(upgradeSites.some((site) => site.upgradeId === port.id()));
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/construction-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      initialGold,
      prices,
      queriedSites,
      regionalSites,
      tick: game.ticks(),
      units: self.units().map((unit) => ({
        type: unit.type(),
        level: unit.level(),
        underConstruction: unit.isUnderConstruction(),
      })),
    },
    null,
    2,
  ),
);
console.log(
  "Construction E2E passed. Artifact: .agent-arena/construction-e2e.json",
);
