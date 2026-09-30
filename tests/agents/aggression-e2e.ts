// Failure cases: missing offense signals,
// build streaks that never reset, affordable missiles hidden with a ready
// silo, and decision snapshots without offense data.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  AgentGame,
  isOffenseIntent,
  isStructureBuild,
} from "../../src/agents/game/AgentGame";
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
import type { ClientMessage, Turn } from "../../src/core/Schemas";

// Intent classification never confuses economy with offense.
assert.equal(isStructureBuild({ type: "upgrade_structure" }), true);
assert.equal(
  isStructureBuild({ type: "build_unit", unit: UnitType.City } as never),
  true,
);
assert.equal(
  isStructureBuild({ type: "build_unit", unit: UnitType.MissileSilo } as never),
  true,
);
assert.equal(
  isStructureBuild({ type: "build_unit", unit: UnitType.AtomBomb } as never),
  false,
);
assert.equal(
  isStructureBuild({ type: "build_unit", unit: UnitType.MIRV } as never),
  false,
);
assert.equal(isOffenseIntent({ type: "attack" }), true);
assert.equal(isOffenseIntent({ type: "boat" }), true);
assert.equal(
  isOffenseIntent({ type: "build_unit", unit: UnitType.HydrogenBomb } as never),
  true,
);
assert.equal(
  isOffenseIntent({ type: "build_unit", unit: UnitType.City } as never),
  false,
);

const clientID = "aggro001";
const runner = await createGameRunner(
  {
    gameID: "agentAggressionE2E",
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
    players: [
      { clientID, username: "Aggressor", clanTag: null },
      { clientID: "aggro002", username: "Rival", clanTag: null },
    ],
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
let home = 0;
for (let tile = 0; tile < game.width() * game.height(); tile++) {
  if (
    game.isLand(tile) &&
    !game.isShore(tile) &&
    !game.isImpassable(tile) &&
    game.x(tile) > 8 &&
    game.y(tile) > 8
  ) {
    home = tile;
    break;
  }
}
let inland = 0;
for (let tile = 0; tile < game.width() * game.height(); tile++) {
  if (
    game.isLand(tile) &&
    !game.isImpassable(tile) &&
    game.manhattanDist(home, tile) > 200
  ) {
    inland = tile;
    break;
  }
}
intents.push({ type: "spawn", tile: home, clientID });
intents.push({ type: "spawn", tile: inland, clientID: "aggro002" });
advance(203);
const self = game.playerByClientID(clientID)!;
const bridge = new AgentGame({ agentCount: 1, tribeCount: 0, nationCount: 0 });
Reflect.set(bridge, "runner", runner);
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(bridge, "observations", new ObservationBuilder(game));
Reflect.set(bridge, "histories", new Map([["agent001", []]]));
Reflect.set(bridge, "incomingAttacks", new Map([["agent001", new Set()]]));
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
Reflect.set(bridge, "buildStreaks", new Map([["agent001", 0]]));
Reflect.set(bridge, "gameId_", "agentAggressionE2E");
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
self.addGold(500_000n);
// Expand through the real attack execution so native border bookkeeping
// stays accurate (direct conquer() calls bypass it).
intents.push({ type: "attack", targetID: null, troops: 500, clientID });
advance(150);
const observe = () => bridge.observe("agent001");
const before = observe();
assert.ok(
  before.offense.attackableBorders > 0,
  "Expansion borders can be attacked",
);
assert.equal(before.offense.readySilos, 0);
assert.deepEqual(before.offense.affordableMissiles, []);
assert.equal(before.offense.buildStreak, 0);
const projected = projectDecisionObservation(before);
assert.ok(projected.offense, "Decision snapshots carry offense signals");

const citySite = before.map.buildSites.find(
  (site) => site.type === UnitType.City,
)!;
assert.ok(citySite);
await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.City,
  tile: citySite.tile,
});
assert.equal(
  observe().offense.buildStreak,
  1,
  "A lone structure build raises the streak",
);
advance(30);
await bridge.act("agent001", { type: "attack", targetID: null, troops: 200 });
assert.equal(observe().offense.buildStreak, 0, "An attack resets the streak");

const cityCenter = self.units(UnitType.City)[0]?.tile() ?? home;
let siloTile = -1;
let best = -1;
for (const tile of self.tiles()) {
  if (!game.isLand(tile) || game.isImpassable(tile)) continue;
  const distance = game.manhattanDist(tile, cityCenter);
  if (distance > best) {
    best = distance;
    siloTile = tile;
  }
}
assert.ok(siloTile >= 0, "An owned land tile is available for the silo");
self.buildUnit(UnitType.MissileSilo, siloTile, {});
for (let index = 0; index < 300; index++) {
  advance(1);
  if (
    self
      .units(UnitType.MissileSilo)
      .some((unit) => !unit.isUnderConstruction() && unit.isActive())
  )
    break;
}
const ready = self
  .units(UnitType.MissileSilo)
  .filter((unit) => !unit.isUnderConstruction() && unit.isActive());
assert.ok(ready.length > 0, "A completed silo becomes active");
self.addGold(5_000_000n);
const armed = observe();
assert.ok(armed.offense.readySilos > 0);
assert.ok(
  armed.offense.affordableMissiles.includes(UnitType.AtomBomb),
  "A ready silo plus gold lists affordable missiles",
);
assert.ok(armed.map.buildSites.some((site) => site.type === UnitType.AtomBomb));

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/aggression-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      offense: armed.offense,
      structureCounts: armed.offense.structureCounts,
      tick: game.ticks(),
    },
    null,
    2,
  ),
);
console.log(
  "Aggression E2E passed. Artifact: .agent-arena/aggression-e2e.json",
);
