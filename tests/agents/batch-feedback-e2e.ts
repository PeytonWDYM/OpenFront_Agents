// Failure cases: queued actions claim execution, array order promises build priority,
// competing builds hide collisions, persistent army ratios imply one shared allocation,
// unlimited bulk actions acquire a quota, or an absent/destroyed asset implies failure.
// Missile cases: upgrades hide launch costs, an earlier affordable missile loses
// its budget during upgrade init, same-target salvos imply placement collisions,
// or sufficient gold and ready silo slots still permit only one missile.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { submitActions } from "../../src/agents/game/actionBatch";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { MatchStats } from "../../src/agents/game/matchStats";
import { Executor } from "../../src/core/execution/ExecutionManager";
import { PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import type { ClientMessage } from "../../src/core/Schemas";
import { setup } from "../util/Setup";

const clientID = "batchFeed001";
const game = await setup("plains", {}, [
  new PlayerInfo("Self", PlayerType.Human, clientID, "Self"),
]);
const self = game.player("Self");
for (let y = 1; y < game.height() - 1; y++)
  for (let x = 1; x < game.width() - 1; x++) self.conquer(game.ref(x, y));
self.setSpawnTile(game.ref(5, 5));
self.setTroops(10_000);
self.addGold(100_000_000n);
const city = self.buildUnit(UnitType.City, game.ref(20, 20), {});
const feedback = new DecisionFeedback(game);
const bridge = new AgentGame({ agentCount: 1 });
Reflect.set(bridge, "runner", { game });
Reflect.set(bridge, "feedback", feedback);
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
Reflect.set(bridge, "buildStreaks", new Map([["agent001", 0]]));
const pending: ClientMessage[] = [];
Reflect.set(bridge, "seats", [
  {
    id: "agent001",
    clientId: clientID,
    send(message: ClientMessage) {
      pending.push(message);
    },
  },
]);
const submit = (intent: Parameters<AgentGame["act"]>[1], ratio?: number) =>
  bridge.act("agent001", intent, ratio);
const executor = new Executor(game, "batchFeedbackE2E", clientID);
function advance(ticks: number) {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}
function execute(ticks: number) {
  for (const message of pending.splice(0)) {
    assert.equal(message.type, "intent");
    if (message.type === "intent")
      game.addExecution(executor.createExec({ ...message.intent, clientID }));
  }
  advance(ticks);
}
feedback.begin(self);
const buildTile = game.ref(75, 75);
const budget = game.unitInfo(UnitType.City).cost(game, self);
self.removeGold(self.gold() - budget);
const mixed = await submitActions(
  {
    intents: [
      { type: "build_unit", unit: UnitType.City, tile: buildTile },
      { type: "upgrade_structure", unit: UnitType.City, unitId: city.id() },
    ],
  },
  submit,
  () => {},
);
assert.ok(
  "warnings" in mixed &&
    mixed.warnings?.some((warning) =>
      /upgrades.*before.*construction/i.test(warning),
    ),
);
assert.ok("status" in mixed && mixed.status === "submitted");
assert.ok("execution" in mixed && mixed.execution === "pending execution");
const submitted = feedback.begin(self)!;
assert.ok(submitted.actions.every((action) => action.status === "submitted"));
assert.ok(
  submitted.actions.every(
    (action) =>
      action.observation === "not observed" ||
      action.type === "upgrade_structure",
  ),
);
execute(2);
assert.equal(
  city.level(),
  2,
  "Upgrade init spends before the earlier construction tick",
);
assert.equal(
  self.units(UnitType.City).length,
  1,
  "The new build cannot spend the same budget",
);
const mixedOutcome = feedback.begin(self)!;
assert.equal(mixedOutcome.construction.changes[0].status, "upgraded");

self.addGold(100_000_000n);
const duplicate = await submitActions(
  {
    intents: Array.from({ length: 2 }, () => ({
      type: "build_unit",
      unit: UnitType.City,
      tile: buildTile,
    })),
  },
  submit,
  () => {},
);
assert.ok(
  "warnings" in duplicate &&
    duplicate.warnings?.some((warning) => /same tile/i.test(warning)),
);
execute(35);
const duplicated = feedback.begin(self)!;
assert.ok(
  duplicated.actions.every((action) => action.observation === "observed"),
);
assert.equal(duplicated.construction.total, 1);
const newCity = self
  .units(UnitType.City)
  .find((unit) => unit.tile() === buildTile)!;
assert.ok(newCity);

const doomedTile = game.ref(75, 20);
await submitActions(
  { intent: { type: "build_unit", unit: UnitType.City, tile: doomedTile } },
  submit,
  () => {},
);
execute(35);
const doomed = self
  .units(UnitType.City)
  .find((unit) => unit.tile() === doomedTile)!;
assert.ok(doomed && !doomed.isUnderConstruction());
doomed.delete(false);
const vanished = feedback.begin(self)!;
assert.equal(vanished.actions[0].observation, "not observed");
assert.equal(
  vanished.actions[0].status,
  "submitted",
  "Execution and destruction between decisions is not failed submission",
);

const army = await submitActions(
  {
    intents: [
      { type: "attack", targetID: null, troops: null },
      { type: "attack", targetID: null, troops: null },
    ],
  },
  submit,
  () => {},
);
assert.ok(
  "warnings" in army &&
    army.warnings?.some((warning) =>
      /each.*action|each.*intent/i.test(warning),
    ),
);
assert.ok(
  "results" in army &&
    army.results?.every(
      (result) =>
        "intent" in result &&
        result.intent.type === "attack" &&
        result.intent.troops === 2000,
    ),
);
pending.splice(0);
const unlimited = await submitActions(
  {
    intents: Array.from({ length: 40 }, () => ({
      type: "upgrade_structure",
      unit: UnitType.City,
      unitId: city.id(),
      amount: 1,
    })),
  },
  submit,
  () => {},
);
assert.ok(
  "results" in unlimited &&
    unlimited.results?.length === 40 &&
    unlimited.accepted,
);
execute(1);
assert.equal(city.level(), 42, "Bulk submissions keep native limits only");

self.addGold(100_000_000n);
const silo = self.buildUnit(UnitType.MissileSilo, game.ref(10, 50), {});
const missileTarget = game.ref(90, 50);
self.relinquish(missileTarget);
const launchCost = game.unitInfo(UnitType.AtomBomb).cost(game, self);
const upgradeCost = game.unitInfo(UnitType.MissileSilo).cost(game, self);
self.removeGold(self.gold() - upgradeCost);
assert.notEqual(self.canBuild(UnitType.AtomBomb, missileTarget), false);
assert.ok(self.canUpgradeUnit(silo));
const missileMixed = await submitActions(
  {
    intents: [
      { type: "build_unit", unit: UnitType.AtomBomb, tile: missileTarget },
      {
        type: "upgrade_structure",
        unit: UnitType.MissileSilo,
        unitId: silo.id(),
      },
    ],
  },
  submit,
  () => {},
);
assert.ok(missileMixed.accepted, "Both actions are affordable at submission");
execute(3);
assert.equal(silo.level(), 2, "Upgrade init charges before missile ticks");
assert.ok(self.gold() < launchCost);
assert.equal(
  self.units(UnitType.AtomBomb).length,
  0,
  "An earlier missile cannot launch after the upgrade spends its budget",
);
assert.ok(
  "warnings" in missileMixed &&
    missileMixed.warnings?.some(
      (warning) =>
        /upgrades.*before/i.test(warning) &&
        /missile.*launch/i.test(warning) &&
        /cost|gold|budget/i.test(warning) &&
        /regardless of array order/i.test(warning),
    ),
  "Missile-only build batches must explain native upgrade charge order",
);
const missileBudget = {
  launchCost: launchCost.toString(),
  upgradeCost: upgradeCost.toString(),
  goldAfterUpgrade: self.gold().toString(),
  missilesAfterUpgrade: self.units(UnitType.AtomBomb).length,
};

// Clear the new slot's native cooldown to provide two ready launch slots.
silo.reloadMissile();
self.addGold(launchCost * 3n);
const salvo = await submitActions(
  {
    intents: Array.from({ length: 2 }, () => ({
      type: "build_unit",
      unit: UnitType.AtomBomb,
      tile: missileTarget,
    })),
  },
  submit,
  () => {},
);
assert.ok("results" in salvo && salvo.results?.length === 2 && salvo.accepted);
assert.ok(
  !("warnings" in salvo) ||
    !salvo.warnings?.some((warning) => /same tile|placement/i.test(warning)),
  "Missiles with the same target do not compete for structure placement",
);
execute(3);
assert.equal(self.units(UnitType.AtomBomb).length, 2);
assert.equal(silo.missileTimerQueue().length, 2);
const salvoOutcome = {
  missilesLaunched: self.units(UnitType.AtomBomb).length,
  occupiedLaunchSlots: silo.missileTimerQueue().length,
};
const economy = new MatchStats(game).observe(self).economy;
assert.equal(economy.incomeWindowSeconds, 120);
assert.equal(economy.incomeBasis, "trailing native counters");
assert.equal(economy.completedPorts, 0);
assert.equal(economy.activePortLevels, 0);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/batch-feedback-e2e.json",
  JSON.stringify(
    {
      result: "PASS",
      mixed,
      submitted,
      mixedOutcome,
      duplicate,
      duplicated,
      vanished,
      army,
      unlimitedCount: "results" in unlimited ? unlimited.results?.length : 0,
      missileMixed,
      missileBudget,
      salvo,
      salvoOutcome,
      economy,
      modelRequests: 0,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: native build and missile batch charge order, salvo launches, pending receipts, state-only feedback, and unlimited actions.",
);
