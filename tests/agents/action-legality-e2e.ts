// Failure cases: enemy attack IDs cancel incoming forces, foreign transports retreat,
// mixed or inactive warship IDs pass, disconnected water passes, native shore targets
// fail, enemy/water/cooldown deletion passes, or native early/repeated/disconnected
// alliance requests are blocked by UI-only renewal hints.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { assertAgentAction } from "../../src/agents/game/actionLegality";
import type { AgentAction } from "../../src/agents/game/schemas";
import { Config } from "../../src/core/configuration/Config";
import { Executor } from "../../src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { setup } from "../util/Setup";

const game = await setup(
  "world",
  { disableNavMesh: false },
  [
    new PlayerInfo("Self", PlayerType.Human, "legality001", "Self"),
    new PlayerInfo("Other", PlayerType.Human, "legality002", "Other"),
  ],
  undefined,
  Config,
);
const self = game.player("Self");
const other = game.player("Other");
const tiles = Array.from(
  { length: game.width() * game.height() },
  (_, tile) => tile,
);
const shore = tiles.find(
  (tile) => game.isLand(tile) && game.isShore(tile) && !game.isImpassable(tile),
)!;
const water = game.neighbors(shore).find((tile) => game.isWater(tile))!;
const component = game.getWaterComponent(water)!;
const patrol = tiles.find(
  (tile) =>
    game.isLand(tile) &&
    game.isShore(tile) &&
    game.getWaterComponent(tile) === component,
)!;
const disconnected = tiles.find(
  (tile) => game.isWater(tile) && game.getWaterComponent(tile) !== component,
)!;
assert.ok(disconnected !== undefined && patrol !== undefined);
self.conquer(shore);
self.setSpawnTile(shore);
const otherTile = tiles.find(
  (tile) =>
    game.isLand(tile) &&
    !game.isImpassable(tile) &&
    game.manhattanDist(shore, tile) > 50,
)!;
other.conquer(otherTile);
other.setSpawnTile(otherTile);
self.addGold(1_000_000_000n);
other.addGold(1_000_000_000n);
self.setTroops(1_000_000);
other.setTroops(1_000_000);
const executor = new Executor(game, "legalityE2E", "legality001");
function step(ticks = 1) {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}
function submit(action: AgentAction, owner = self) {
  assertAgentAction(game, owner, action);
  game.addExecution(
    executor.createExec({ ...action, clientID: owner.clientID()! }),
  );
  step(2);
}

submit({ type: "attack", targetID: null, troops: 100_000 });
submit({ type: "attack", targetID: null, troops: 100_000 }, other);
const ownAttack = self.outgoingAttacks()[0];
const enemyAttack = other.outgoingAttacks()[0];
assert.ok(ownAttack && enemyAttack);
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "cancel_attack",
      attackID: enemyAttack.id(),
    }),
  /own outgoing attack/i,
);
submit({ type: "cancel_attack", attackID: ownAttack.id() });
assert.equal(
  ownAttack.retreating(),
  true,
  "Native cancellation orders our retreat",
);
assert.equal(enemyAttack.retreating(), false, "Enemy forces remain active");
step(25);
assert.equal(ownAttack.retreated(), true);

const boat = self.buildUnit(UnitType.TransportShip, water, { troops: 100 });
const foreignBoat = other.buildUnit(UnitType.TransportShip, water, {
  troops: 100,
});
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "cancel_boat",
      unitID: foreignBoat.id(),
    }),
  /own active transport/i,
);
submit({ type: "cancel_boat", unitID: boat.id() });
assert.equal(boat.transportShipState().isRetreating, true);
assert.equal(foreignBoat.transportShipState().isRetreating, false);
const ship = self.buildUnit(UnitType.Warship, water, { patrolTile: water });
const foreignShip = other.buildUnit(UnitType.Warship, water, {
  patrolTile: water,
});
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "move_warship",
      unitIds: [ship.id(), foreignShip.id()],
      tile: patrol,
    }),
  /own active warship/i,
);
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "move_warship",
      unitIds: [ship.id()],
      tile: disconnected,
    }),
  /connected water/i,
);
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "move_warship",
      unitIds: [ship.id()],
      tile: tiles.length,
    }),
  /valid patrol tile/i,
);
submit({ type: "move_warship", unitIds: [ship.id()], tile: patrol });
assert.equal(
  ship.warshipState().patrolTile,
  patrol,
  "Native WaterManager accepts the shore target",
);
ship.delete(false);
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "move_warship",
      unitIds: [ship.id()],
      tile: patrol,
    }),
  /own active warship/i,
);

const city = self.buildUnit(UnitType.City, shore, {});
const foreignCity = other.buildUnit(UnitType.City, otherTile, {});
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "delete_unit",
      unitId: foreignCity.id(),
    }),
  /own active unit/i,
);
assert.throws(
  () =>
    assertAgentAction(game, self, { type: "delete_unit", unitId: boat.id() }),
  /owned land/i,
);
step(game.config().deleteUnitCooldown());
submit({ type: "delete_unit", unitId: city.id() });
assert.equal(city.isMarkedForDeletion(), true);
const anotherCity = self.buildUnit(UnitType.City, shore, {});
assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "delete_unit",
      unitId: anotherCity.id(),
    }),
  /cooldown/i,
);

assert.throws(
  () =>
    assertAgentAction(game, self, {
      type: "allianceExtension",
      recipient: other.id(),
    }),
  /active alliance/i,
);
submit({ type: "allianceRequest", recipient: other.id() });
submit({ type: "allianceRequest", recipient: self.id() }, other);
const alliance = self.allianceWith(other)!;
assert.ok(alliance);
const extension = { type: "allianceExtension", recipient: other.id() } as const;
assert.equal(self.allianceInfo(other)!.inExtensionWindow, false);
assert.equal(self.allianceInfo(other)!.canExtend, false);
// Compare with the native execution before checking the harness. The native
// request accepts early agreement despite the unavailable UI hint.
game.addExecution(
  executor.createExec({ ...extension, clientID: self.clientID()! }),
);
step(2);
assert.equal(alliance.agreedToExtend(self), true);
assert.doesNotThrow(() => assertAgentAction(game, self, extension));
game.addExecution(
  executor.createExec({ ...extension, clientID: self.clientID()! }),
);
const repeatedUpdates =
  game.executeNextTick()[GameUpdateType.AllianceExtension];
assert.ok(
  repeatedUpdates.some(
    (update) =>
      update.playerID === self.smallID() && update.allianceID === alliance.id(),
  ),
  "Native repeated requests emit an alliance update",
);
step(1);
assert.equal(
  alliance.agreedToExtend(self),
  true,
  "Native repeated request preserves agreement",
);
submit({ type: "allianceExtension", recipient: self.id() }, other);
assert.equal(
  alliance.agreedToExtend(self),
  false,
  "Mutual renewal clears agreements before the disconnected comparison",
);
game.addExecution(
  executor.createExec({
    type: "mark_disconnected",
    isDisconnected: true,
    clientID: other.clientID()!,
  }),
);
step(2);
assert.equal(other.isDisconnected(), true);
assert.equal(self.allianceInfo(other)!.canExtend, false);
game.addExecution(
  executor.createExec({ ...extension, clientID: self.clientID()! }),
);
step(2);
assert.equal(
  alliance.agreedToExtend(self),
  true,
  "Native request records a new agreement with a disconnected living recipient",
);
assert.doesNotThrow(() => assertAgentAction(game, self, extension));
submit(extension);
assert.equal(
  alliance.agreedToExtend(self),
  true,
  "A disconnected living recipient remains a native alliance target",
);
for (const tile of [...other.tiles()]) self.conquer(tile);
assert.equal(other.isAlive(), false);
game.addExecution(
  executor.createExec({
    type: "allianceExtension",
    recipient: self.id(),
    clientID: other.clientID()!,
  }),
);
step(2);
assert.equal(
  alliance.agreedToExtend(other),
  false,
  "Native extension rejects a dead participant",
);
assert.throws(
  () => assertAgentAction(game, self, extension),
  /living players/i,
);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/action-legality-e2e.json",
  JSON.stringify(
    {
      result: "PASS",
      component,
      shorePatrol: patrol,
      disconnected,
      ownAttack: ownAttack.id(),
      enemyAttack: enemyAttack.id(),
      transport: boat.id(),
      city: city.id(),
      allianceRequested: alliance.agreedToExtend(self),
      nativeEarlyExtension: true,
      nativeRepeatedExtension: true,
      nativeDisconnectedRecipient: true,
      nativeDeadParticipantRejected: true,
      modelRequests: 0,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: native action ownership, shore connectivity, retreat, deletion, and renewal.",
);
