// Failure cases: tool observations consume the previous-decision baseline,
// spending counts as lost income, troop commitment counts as combat losses,
// submission counts as construction success, upgrades beyond unit 32 disappear,
// partial upgrades claim the full requested amount, or action bounds hide totals.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { projectDecisionObservation } from "../../src/agents/game/decision";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { UpgradeStructureExecution } from "../../src/core/execution/UpgradeStructureExecution";
import { PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import { ClientMessage } from "../../src/core/Schemas";
import { setup } from "../util/Setup";

const clientID = "feedback001";
const game = await setup("plains", {}, [
  new PlayerInfo("Economist", PlayerType.Human, clientID, "Economist"),
]);
const self = game.player("Economist");
const tile = game.ref(35, 35);
for (let y = 1; y < game.height() - 1; y++)
  for (let x = 1; x < game.width() - 1; x++) self.conquer(game.ref(x, y));
self.setSpawnTile(tile);
self.setTroops(10_000);
self.addGold(100_000_000n);
const builder = new ObservationBuilder(game);
const bridge = new AgentGame({ agentCount: 1 });
Reflect.set(bridge, "runner", { game });
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(bridge, "observations", builder);
Reflect.set(bridge, "histories", new Map([["agent001", []]]));
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
const queued: ClientMessage[] = [];
Reflect.set(bridge, "seats", [
  {
    id: "agent001",
    clientId: clientID,
    send(message: ClientMessage) {
      queued.push(message);
    },
  },
]);
const advance = (ticks: number) => {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
};
assert.equal(bridge.decisionFeedback("agent001"), undefined);
advance(600);
self.addGold(12_000n);
self.addTradeGold(3_000n);
self.addTrainGold(4_000n);
self.addPiracyGold(5_000n);
self.removeGold(2_000n);
self.removeTroops(1_000);
game.stats().attack(self, game.terraNullius(), 1_000);
game.stats().attackCancel(self, game.terraNullius(), 200);
const observer = bridge.observe("agent001");
bridge.decisionObservation("agent001");
const feedback = bridge.decisionFeedback("agent001")!;
assert.equal(feedback.fromTick, 0);
assert.equal(feedback.toTick, 600);
assert.equal(feedback.goldDelta, 10_000);
assert.equal(feedback.goldEarned, 12_000);
assert.equal(feedback.shipTradeGoldEarned, 3_000);
assert.equal(feedback.trainTradeGoldEarned, 4_000);
assert.equal(feedback.piracyGoldEarned, 5_000);
assert.equal(feedback.troopsDelta, -1_000);
assert.equal(feedback.attackTroopsCommitted, 1_000);
assert.equal(feedback.attackTroopsRetreated, 200);
assert.ok(!("combatLosses" in feedback));
const economy = projectDecisionObservation(observer).economy!;
assert.equal(economy.goldIncomePerMinute, 12_000);
assert.equal(economy.shipTradeGoldPerMinute, 3_000);
assert.equal(economy.trainTradeGoldPerMinute, 4_000);
assert.equal(economy.piracyGoldPerMinute, 5_000);

await bridge.act("agent001", { type: "build_unit", unit: UnitType.City, tile });
assert.equal(queued.length, 1);
const submitted = bridge.decisionFeedback("agent001")!;
assert.equal(submitted.actions[0].status, "submitted");
assert.equal(submitted.construction.total, 0);
game.addExecution(new ConstructionExecution(self, UnitType.City, tile));
advance(2);
const started = bridge.decisionFeedback("agent001")!;
assert.equal(started.construction.changes[0].status, "new_owned");
assert.equal(started.construction.changes[0].underConstruction, true);
advance(30);
const completed = bridge.decisionFeedback("agent001")!;
assert.equal(completed.construction.changes[0].status, "completed");

// Seed full native owned state to prove the 32-unit inspector cap is irrelevant.
for (let index = 0; index < 33; index++)
  self.buildUnit(UnitType.City, game.ref(2 + index, 2), {});
bridge.decisionFeedback("agent001");
const cities = self.units(UnitType.City);
const lastCity = cities[cities.length - 1];
await bridge.act("agent001", {
  type: "upgrade_structure",
  unit: UnitType.City,
  unitId: lastCity.id(),
  amount: 3,
});
game.addExecution(new UpgradeStructureExecution(self, lastCity.id(), 3));
advance(1);
const upgraded = bridge.decisionFeedback("agent001")!;
assert.equal(upgraded.construction.changes[0].unitId, lastCity.id());
assert.equal(upgraded.construction.changes[0].level, 4);
assert.equal(upgraded.actions[0].status, "submitted");
assert.equal(upgraded.actions[0].observedLevel, 4);

await bridge.act("agent001", {
  type: "upgrade_structure",
  unit: UnitType.City,
  unitId: lastCity.id(),
  amount: 5,
});
const upgradeCost = game.unitInfo(UnitType.City).cost(game, self);
self.removeGold(self.gold() - upgradeCost);
game.addExecution(new UpgradeStructureExecution(self, lastCity.id(), 5));
advance(1);
const partial = bridge.decisionFeedback("agent001")!;
assert.equal(partial.actions[0].requestedAmount, 5);
assert.equal(partial.actions[0].status, "submitted");
assert.equal(partial.actions[0].observedLevel, 5);
assert.equal(partial.construction.changes[0].previousLevel, 4);
assert.equal(partial.construction.changes[0].level, 5);

self.addGold(100_000_000n);
for (let index = 0; index < 20; index++)
  await bridge.act("agent001", {
    type: "upgrade_structure",
    unit: UnitType.City,
    unitId: lastCity.id(),
    amount: 1,
  });
const bounded = bridge.decisionFeedback("agent001")!;
assert.equal(bounded.actions.length, 12);
assert.equal(bounded.actionsTotal, 20);
assert.equal(bounded.actionsOmitted, 8);
assert.ok(bounded.actions.every((action) => action.status === "submitted"));
assert.equal(queued.length, 23, "Feedback caps never limit submitted actions");

// Two requests can share one observed unit. Keep their acknowledgments separate
// from the one native unit change, including a partially affordable upgrade batch.
self.addGold(100_000_000n);
const duplicateTile = game.ref(80, 80);
for (let i = 0; i < 2; i++)
  await bridge.act("agent001", {
    type: "build_unit",
    unit: UnitType.City,
    tile: duplicateTile,
  });
for (let i = 0; i < 2; i++)
  game.addExecution(
    new ConstructionExecution(self, UnitType.City, duplicateTile),
  );
advance(40);
const duplicateBuilds = bridge.decisionFeedback("agent001")!;
assert.ok(
  duplicateBuilds.actions.every((action) => action.status === "submitted"),
);
assert.equal(duplicateBuilds.construction.total, 1);
for (let i = 0; i < 2; i++)
  await bridge.act("agent001", {
    type: "upgrade_structure",
    unit: UnitType.City,
    unitId: lastCity.id(),
    amount: 5,
  });
const duplicateUpgradeCost = game.unitInfo(UnitType.City).cost(game, self);
self.removeGold(self.gold() - 5n * duplicateUpgradeCost);
for (let i = 0; i < 2; i++)
  game.addExecution(new UpgradeStructureExecution(self, lastCity.id(), 5));
advance(1);
const duplicateUpgrades = bridge.decisionFeedback("agent001")!;
assert.ok(
  duplicateUpgrades.actions.every((action) => action.status === "submitted"),
);
assert.equal(duplicateUpgrades.construction.total, 1);
assert.equal(duplicateUpgrades.construction.changes[0].level, 10);

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/economic-feedback-e2e.json",
  JSON.stringify(
    {
      result: "PASS",
      feedback,
      economy,
      submitted,
      started,
      completed,
      upgraded,
      partial,
      bounded,
      duplicateBuilds,
      duplicateUpgrades,
      modelRequests: 0,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: native economy, decision deltas, construction outcomes, and bounded feedback.",
);
