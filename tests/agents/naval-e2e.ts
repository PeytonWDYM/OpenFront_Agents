// Failure cases: missing Warship hints, Port tiles replacing water patrol targets,
// hint limits hiding legal Warships, unfinished Ports or insufficient gold allowing
// a launch, disconnected water targets, hidden public trade destinations, wrong
// affiliations, region filtering after the traffic cap, and private trade data leaks.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { projectDecisionObservation } from "../../src/agents/game/decision";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { TradeShipExecution } from "../../src/core/execution/TradeShipExecution";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../../src/core/game/Game";
import { createGameRunner } from "../../src/core/GameRunner";
import { GameStartInfo, Turn } from "../../src/core/Schemas";

const start: GameStartInfo = {
  gameID: "agentNavalE2E",
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
    startingGold: 1_000_000_000,
    donateGold: true,
    donateTroops: true,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
  },
  players: [
    { clientID: "naval001", username: "Sailor One", clanTag: null },
    { clientID: "naval002", username: "Sailor Two", clanTag: null },
  ],
};
const runner = await createGameRunner(
  start,
  undefined,
  new LocalMapLoader(),
  (update) => {
    if ("errMsg" in update) throw new Error(update.errMsg);
  },
);
const game = runner.game;
const advance = (ticks: number, intents: Turn["intents"] = []) => {
  for (let index = 0; index < ticks; index++) {
    runner.addTurn({
      turnNumber: game.ticks(),
      intents: index === 0 ? intents : [],
    });
    assert.ok(runner.executeNextTick());
  }
};
const coasts: number[] = [];
for (let tile = 0; tile < game.width() * game.height(); tile++) {
  if (
    game.isLand(tile) &&
    game.isShore(tile) &&
    !game.isImpassable(tile) &&
    game.x(tile) > 8 &&
    game.y(tile) > 8
  )
    coasts.push(tile);
}
const shore = coasts[0];
const water = game.neighbors(shore).find((tile) => game.isWater(tile))!;
const component = game.getWaterComponent(water);
const otherShore = coasts.find(
  (tile) =>
    game.manhattanDist(shore, tile) > 400 &&
    game.hasWaterComponent(tile, component!),
)!;
assert.ok(otherShore !== undefined && component !== null);
advance(203, [
  { type: "spawn", tile: shore, clientID: "naval001" },
  { type: "spawn", tile: otherShore, clientID: "naval002" },
]);
const self = game.playerByClientID("naval001")!;
const other = game.playerByClientID("naval002")!;
const builder = new ObservationBuilder(game);
const observe = () => builder.observe("naval", self, 0, {}, []);
const warshipHint = () =>
  observe().map.buildSites.find((site) => site.type === UnitType.Warship);
const artifact: Record<string, unknown> = { seed: start.gameID };

try {
  assert.equal(warshipHint(), undefined, "Warships require an owned Port");
  const portTile = self.canBuild(UnitType.Port, shore);
  const otherPortTile = other.canBuild(UnitType.Port, otherShore);
  assert.notEqual(portTile, false);
  assert.notEqual(otherPortTile, false);
  advance(2, [
    {
      type: "build_unit",
      unit: UnitType.Port,
      tile: shore,
      clientID: "naval001",
    },
    {
      type: "build_unit",
      unit: UnitType.Port,
      tile: otherShore,
      clientID: "naval002",
    },
  ]);
  const port = self.units(UnitType.Port)[0];
  const otherPort = other.units(UnitType.Port)[0];
  assert.ok(port && otherPort && port.isUnderConstruction());
  assert.equal(warshipHint(), undefined, "An unfinished Port cannot launch");
  for (let index = 0; index < 600 && port.isUnderConstruction(); index++)
    advance(1);
  assert.ok(!port.isUnderConstruction() && !otherPort.isUnderConstruction());
  const hint = warshipHint();
  assert.ok(hint, "A completed coastal Port exposes a legal Warship hint");
  assert.ok(
    game.isWater(hint.tile),
    "Warship intents use water patrol targets",
  );
  assert.notEqual(self.canBuild(UnitType.Warship, hint.tile), false);
  assert.notEqual(hint.tile, port.tile(), "The launch Port is not the target");
  assert.ok(observe().map.buildSites.length <= 8);
  assert.equal(
    observe().map.buildSites.filter((site) => site.type === UnitType.Warship)
      .length,
    1,
  );
  const savedGold = self.gold();
  self.removeGold(savedGold);
  assert.equal(warshipHint(), undefined, "Insufficient gold removes the hint");
  self.addGold(savedGold);
  const disconnected = Array.from(
    { length: game.width() * game.height() },
    (_, tile) => tile,
  ).find(
    (tile) =>
      game.isWater(tile) &&
      game.getWaterComponent(tile) !== component &&
      self.canBuild(UnitType.Warship, tile) === false,
  );
  assert.ok(disconnected !== undefined, "Fixture includes disconnected water");
  const disconnectedView = builder.observe(
    "naval",
    self,
    0,
    { x: game.x(disconnected), y: game.y(disconnected), width: 1, height: 1 },
    [],
  );
  assert.ok(
    !disconnectedView.map.buildSites.some(
      (site) => site.type === UnitType.Warship && site.tile === disconnected,
    ),
  );
  advance(2, [
    {
      type: "build_unit",
      unit: UnitType.Warship,
      tile: hint.tile,
      clientID: "naval001",
    },
  ]);
  const warship = self.units(UnitType.Warship)[0];
  assert.ok(warship, "Native build_unit execution launches the hinted Warship");
  assert.equal(warship.warshipState().patrolTile, hint.tile);
  artifact.launch = { hint, portId: port.id(), warshipId: warship.id() };

  // Native trade executions provide public targetUnit IDs without fixture ships.
  for (let index = 0; index < 14; index++)
    game.addExecution(new TradeShipExecution(other, otherPort, port));
  game.addExecution(new TradeShipExecution(self, port, otherPort));
  advance(2);
  const traffic = observe().map.tradeTraffic;
  assert.ok(traffic.length > 0 && traffic.length <= 12);
  const nativeShips = game.units(UnitType.TradeShip);
  assert.ok(nativeShips.length > 12);
  const observedShip = traffic[0];
  const nativeShip = nativeShips.find((ship) => ship.id() === observedShip.id)!;
  assert.ok(nativeShip);
  assert.equal(observedShip.tile, nativeShip.tile());
  assert.equal(observedShip.ownerId, nativeShip.owner().id());
  assert.equal(observedShip.ownerSmallId, nativeShip.owner().smallID());
  const destination = nativeShip.targetUnit()!;
  assert.deepEqual(observedShip.destination, {
    id: destination.id(),
    tile: destination.tile(),
    x: game.x(destination.tile()),
    y: game.y(destination.tile()),
    ownerId: destination.owner().id(),
    ownerSmallId: destination.owner().smallID(),
    affiliation: destination.owner() === self ? "self" : "other",
  });
  assert.deepEqual(Object.keys(observedShip).sort(), [
    "affiliation",
    "destination",
    "id",
    "ownerId",
    "ownerSmallId",
    "tile",
    "type",
    "x",
    "y",
  ]);
  const laterShip = nativeShips.find(
    (ship) => !traffic.some((row) => row.id === ship.id()),
  )!;
  assert.ok(laterShip);
  const regional = builder.observe(
    "naval",
    self,
    0,
    {
      x: game.x(laterShip.tile()),
      y: game.y(laterShip.tile()),
      width: 1,
      height: 1,
      sections: ["map", "units"],
    },
    [],
  );
  assert.ok(
    regional.map.tradeTraffic.some((ship) => ship.id === laterShip.id()),
  );
  assert.ok(regional.map.tradeTraffic.length <= 12);
  assert.ok(
    regional.self.units.every((unit) =>
      self.units().some((own) => own.id() === unit.id),
    ),
  );
  assert.ok(!("tradeTraffic" in projectDecisionObservation(observe()).map!));
  assert.ok(
    projectDecisionObservation(observe(), ["map"]).map!.tradeTraffic!.length >
      0,
  );
  advance(2, [
    { type: "allianceRequest", recipient: other.id(), clientID: "naval001" },
  ]);
  advance(2, [
    { type: "allianceRequest", recipient: self.id(), clientID: "naval002" },
  ]);
  assert.ok(self.isAlliedWith(other));
  const alliedTraffic = observe().map.tradeTraffic;
  assert.ok(alliedTraffic.some((ship) => ship.affiliation === "ally"));
  assert.ok(
    alliedTraffic.some((ship) => ship.destination?.affiliation === "self"),
  );
  artifact.tradeTraffic = alliedTraffic;
  artifact.regionalTradeTraffic = regional.map.tradeTraffic;
  port.delete();
  assert.equal(warshipHint(), undefined, "An inactive Port cannot launch");
  artifact.result = "passed";
} catch (error) {
  artifact.result = "failed";
  artifact.error = String(error);
  throw error;
} finally {
  artifact.tick = game.ticks();
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/naval-e2e.json",
    JSON.stringify(artifact, null, 2),
  );
}
