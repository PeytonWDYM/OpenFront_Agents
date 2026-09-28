// Failure cases: malformed later intents submit earlier actions, forged senders pass,
// empty or oversized batches pass, single and batch actions bypass the shared budget,
// invalid timing changes the schedule, submissions reorder, partial failures look atomic,
// native action types disappear, schemas exceed 5,000 bytes, or native actions do not execute.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { validateToolSchemas } from "../../src/agents/codex/toolSchema";
import {
  ActionDecision,
  ActionLimitError,
} from "../../src/agents/game/actionBatch";
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
} from "../../src/core/game/Game";
import { createGameRunner } from "../../src/core/GameRunner";
import type { Turn } from "../../src/core/Schemas";

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
const submissions: { type: string; tick: number; attackRatio?: number }[] = [];
const schedules: number[] = [];
const submit = async (intent: AgentAction, attackRatio?: number) => {
  submissions.push({
    type: intent.type,
    tick: runner.game.ticks(),
    attackRatio,
  });
  step([{ ...intent, clientID: "batch001" }]);
  return {
    accepted: true as const,
    intent,
    tick: runner.game.ticks(),
    attackRatio: attackRatio ?? 0.2,
  };
};
const schedule = (seconds: number) => schedules.push(seconds);
const attack = { type: "attack", targetID: null, troops: 100 } as const;
const alliance = {
  type: "allianceRequest",
  recipient: recipient.id(),
} as const;
const invalid = new ActionDecision();
for (const input of [
  { intents: [] },
  { intents: [attack, attack, attack] },
  { intent: attack, intents: [alliance] },
  { intents: [attack, { ...alliance, clientID: "batch002" }] },
  { intents: [attack, { type: "spawn", tile: -1 }] },
  { intents: [attack], nextDecisionSeconds: 11 },
  { attackRatio: 0.5, nextDecisionSeconds: 1 },
  { intents: [attack], attackRatio: 2 },
])
  await assert.rejects(invalid.submit(input, submit, schedule));
assert.equal(submissions.length, 0);
assert.equal(schedules.length, 0);
const tilesBefore = self.numTilesOwned();
const batch = await invalid.submit(
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
await assert.rejects(
  invalid.submit({ intent: attack, nextDecisionSeconds: 3 }, submit, schedule),
  ActionLimitError,
);
assert.deepEqual(schedules, [2]);
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
const singleFirst = new ActionDecision();
const single = await singleFirst.submit({ intent: attack }, submit, schedule);
assert.ok(
  "intent" in single && single.accepted,
  "Single-action output stays compatible",
);
await assert.rejects(
  singleFirst.submit({ intents: [attack, attack] }, submit, schedule),
  ActionLimitError,
);
await singleFirst.submit({ intents: [attack] }, submit, schedule);
await assert.rejects(
  singleFirst.submit({ intent: attack }, submit, schedule),
  ActionLimitError,
);
const timing = new ActionDecision();
await timing.submit({ nextDecisionSeconds: 1 }, submit, schedule);
await timing.submit({ intents: [attack, attack] }, submit, schedule);
const partial = new ActionDecision();
let attempted = 0;
const partialResult = await partial.submit(
  { intents: [attack, alliance] },
  async (intent, ratio) => {
    attempted++;
    if (attempted === 2) throw new Error("Native connection closed");
    return submit(intent, ratio);
  },
  schedule,
);
assert.ok("results" in partialResult && partialResult.results !== undefined);
assert.deepEqual(
  partialResult.results.map((result) => result.accepted),
  [true, false],
);
assert.equal(partialResult.accepted, false);
await assert.rejects(
  partial.submit({ intent: attack }, submit, schedule),
  ActionLimitError,
);
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
