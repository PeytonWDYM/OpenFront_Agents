// Failure cases: malformed later intents submit earlier actions, forged senders pass,
// empty batches pass, large batches or repeated calls are blocked by harness limits,
// invalid timing changes the schedule, submissions reorder, partial failures look atomic,
// native action types disappear, schemas exceed 5,000 bytes, or native actions do not execute.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { validateToolSchemas } from "../../src/agents/codex/toolSchema";
import { submitActions } from "../../src/agents/game/actionBatch";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import {
  type AgentAction,
  AgentActionSchema,
  agentActionToolSchema,
} from "../../src/agents/game/schemas";
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

const runner = await createGameRunner(
  {
    gameID: "agentBatchE2E",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Europe,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      bots: 0,
      nations: "disabled",
      randomSpawn: true,
      donateGold: true,
      donateTroops: true,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
    },
    players: [
      { clientID: "batch001", username: "Batch One", clanTag: null },
      { clientID: "batch002", username: "Batch Two", clanTag: null },
    ],
  },
  undefined,
  new LocalMapLoader(),
  (update) => {
    if ("errMsg" in update) throw new Error(update.errMsg);
  },
);
function step(intents: Turn["intents"] = []) {
  runner.addTurn({ turnNumber: runner.game.ticks(), intents });
  assert.ok(runner.executeNextTick());
}
for (let index = 0; index < 200; index++) step();
const self = runner.game.playerByClientID("batch001")!;
const recipient = runner.game.playerByClientID("batch002")!;
const bridge = new AgentGame({ agentCount: 1, tribeCount: 0, nationCount: 0 });
Reflect.set(bridge, "runner", runner);
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
Reflect.set(bridge, "buildStreaks", new Map([["agent001", 0]]));
const pending: Turn["intents"] = [];
Reflect.set(bridge, "seats", [
  {
    id: "agent001",
    clientId: "batch001",
    send(message: ClientMessage) {
      assert.equal(message.type, "intent");
      if (message.type === "intent")
        pending.push({ ...message.intent, clientID: "batch001" });
    },
  },
]);
const submissions: { type: string; tick: number; attackRatio?: number }[] = [];
const schedules: number[] = [];
const submit = async (intent: AgentAction, attackRatio?: number) => {
  const result = await bridge.act("agent001", intent, attackRatio);
  submissions.push({
    type: intent.type,
    tick: runner.game.ticks(),
    attackRatio,
  });
  return result;
};
const schedule = (seconds: number) => schedules.push(seconds);
const attack = { type: "attack", targetID: null, troops: 100 } as const;
const alliance = {
  type: "allianceRequest",
  recipient: recipient.id(),
} as const;
for (const input of [
  { intents: [] },
  { intent: attack, intents: [alliance] },
  { intents: [attack, { ...alliance, clientID: "batch002" }] },
  { intents: [attack, { type: "spawn", tile: -1 }] },
  { intents: [attack], nextDecisionSeconds: 11 },
  { attackRatio: 0.5, nextDecisionSeconds: 1 },
  { intents: [attack], attackRatio: 2 },
])
  await assert.rejects(submitActions(input, submit, schedule));
assert.equal(submissions.length, 0);
assert.equal(schedules.length, 0);
const tilesBefore = self.numTilesOwned();
const batch = await submitActions(
  { intents: [attack, alliance], attackRatio: 0.25, nextDecisionSeconds: 2 },
  submit,
  schedule,
);
assert.ok(
  "results" in batch &&
    batch.results !== undefined &&
    batch.results.every((result) => result.accepted),
);
assert.deepEqual(
  submissions.map((result) => result.type),
  ["attack", "allianceRequest"],
);
assert.deepEqual(
  submissions.map((result) => result.attackRatio),
  [0.25, 0.25],
);
assert.deepEqual(schedules, [2]);
await submitActions(
  { intent: attack, nextDecisionSeconds: 3 },
  submit,
  schedule,
);
assert.deepEqual(schedules, [2, 3]);
step(pending.splice(0));
for (let index = 0; index < 100; index++) step();
assert.ok(
  self.numTilesOwned() > tilesBefore,
  "The native attack expands territory",
);
assert.ok(
  recipient
    .incomingAllianceRequests()
    .some((request) => request.requestor() === self),
  "The native alliance request reaches its recipient",
);
const single = await submitActions({ intent: attack }, submit, schedule);
assert.ok(
  "intent" in single && single.accepted,
  "Single-action output stays compatible",
);
await submitActions({ intents: [attack, attack, attack] }, submit, schedule);
await submitActions({ intents: [attack] }, submit, schedule);
await submitActions({ intent: attack }, submit, schedule);
await submitActions({ nextDecisionSeconds: 1 }, submit, schedule);
await submitActions({ intents: [attack, attack] }, submit, schedule);
const partialResult = await submitActions(
  {
    intents: [
      attack,
      {
        type: "build_unit",
        unit: UnitType.Port,
        tile: runner.game.width() * runner.game.height(),
      },
      attack,
    ],
  },
  submit,
  schedule,
);
assert.ok("results" in partialResult && partialResult.results !== undefined);
assert.deepEqual(
  partialResult.results.map((result) => result.accepted),
  [true, false, true],
);
assert.equal(partialResult.accepted, false);
await submitActions({ intent: attack }, submit, schedule);
step(pending.splice(0));

// Give the player five separated coastal sites as a construction fixture.
// All construction and upgrades below execute through normal native intents.
const game = runner.game;
const portSites: number[] = [];
for (
  let tile = 0;
  tile < game.width() * game.height() && portSites.length < 5;
  tile++
) {
  if (
    game.isLand(tile) &&
    game.isShore(tile) &&
    !game.isImpassable(tile) &&
    !game.hasOwner(tile) &&
    portSites.every((site) => game.euclideanDistSquared(site, tile) > 60 ** 2)
  ) {
    self.conquer(tile);
    portSites.push(tile);
  }
}
assert.equal(portSites.length, 5);
self.addGold(50_000_000n);
const fivePorts = await submitActions(
  {
    intents: portSites.map((tile) => ({
      type: "build_unit",
      unit: UnitType.Port,
      tile,
    })),
  },
  submit,
  schedule,
);
assert.ok(
  "results" in fivePorts &&
    fivePorts.results?.every((result) => result.accepted),
);
assert.equal(pending.length, 5, "One call submits five native builds together");
step(pending.splice(0));
for (let index = 0; index < 500; index++) step();
const ports = self.units(UnitType.Port);
assert.equal(ports.length, 5, "Five native ports exist");
assert.ok(ports.every((port) => !port.isUnderConstruction()));
assert.deepEqual(
  ports.map((port) => port.tile()).sort((a, b) => a - b),
  [...portSites].sort((a, b) => a - b),
);
const upgraded = ports[0];
const levelBefore = upgraded.level();
const goldBefore = self.gold();
await submitActions(
  {
    intent: {
      type: "upgrade_structure",
      unit: UnitType.Port,
      unitId: upgraded.id(),
      amount: 5,
    },
  },
  submit,
  schedule,
);
step(pending.splice(0));
assert.equal(
  upgraded.level(),
  levelBefore + 5,
  "Native bulk upgrade applies five levels",
);
assert.ok(self.gold() < goldBefore, "Native upgrades charge gold");
const schemaBytes = Buffer.byteLength(JSON.stringify(agentActionToolSchema));
validateToolSchemas([
  {
    name: "act",
    description: "Native actions",
    inputSchema: agentActionToolSchema,
  },
]);
assert.ok(schemaBytes <= 5000);
assert.equal(AgentActionSchema.options.length, 20);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/batch-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      seed: "agentBatchE2E",
      schemaBytes,
      nativeActionTypes: AgentActionSchema.options.map(
        (option) => option.shape.type.value,
      ),
      batch,
      partialResult,
      fivePorts,
      construction: {
        portSites,
        completedPorts: ports.length,
        upgradedUnitId: upgraded.id(),
        levelBefore,
        levelAfter: upgraded.level(),
      },
      submissions,
      schedules,
      native: {
        tilesBefore,
        tilesAfter: self.numTilesOwned(),
        recipientId: recipient.id(),
      },
    },
    null,
    2,
  ),
);
console.log(
  `Batch E2E passed. Schema: ${schemaBytes} bytes. Artifact: .agent-arena/batch-e2e.json`,
);
