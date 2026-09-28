// Failure cases: empty or oversized notes, unknown keys, invalid nested queries,
// combined focus selectors, double-charged observations, foreign private resources,
// repeated events, missing images, automatic actions, and oversized tool schemas.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Arena, ThinkQuerySchema } from "../../src/agents/Arena";
import { EFFORT, MODEL } from "../../src/agents/codex/config";
import type { GameToolResult } from "../../src/agents/codex/index";
import { validateToolSchemas } from "../../src/agents/codex/toolSchema";
import { ActionDecision } from "../../src/agents/game/actionBatch";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import type { AgentEvent } from "../../src/agents/game/schemas";
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

for (const invalid of [
  { note: "" },
  { note: " " },
  { note: "x".repeat(601) },
  { note: "Check transport", unexpected: true },
  { note: "Check transport", observe: { width: 0 } },
  { note: "Check transport", observe: { opponentTroops: true } },
  { note: "Check transport", observe: { playerId: "target", x: 0 } },
  {
    note: "Check transport",
    observe: {
      playerId: "target",
      nukePreview: { type: UnitType.AtomBomb, tile: 0 },
    },
  },
])
  assert.equal(ThinkQuerySchema.safeParse(invalid).success, false);
assert.equal(
  ThinkQuerySchema.parse({ note: "x".repeat(600) }).note.length,
  600,
);
const schema = z.toJSONSchema(ThinkQuerySchema);
const schemaBytes = Buffer.byteLength(JSON.stringify(schema));
validateToolSchemas([
  { name: "think", description: "Record strategy", inputSchema: schema },
]);
assert.equal(MODEL, "gpt-6-luna");
assert.equal(EFFORT, "low");

const runner = await createGameRunner(
  {
    gameID: "agentThinkE2E",
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
      { clientID: "think001", username: "Think One", clanTag: null },
      { clientID: "think002", username: "Think Two", clanTag: null },
    ],
  },
  undefined,
  new LocalMapLoader(),
  (update) => {
    if ("errMsg" in update) throw new Error(update.errMsg);
  },
);
for (let index = 0; index < 200; index++) {
  runner.addTurn({ turnNumber: runner.game.ticks(), intents: [] });
  assert.ok(runner.executeNextTick());
}
const self = runner.game.playerByClientID("think001")!;
const target = runner.game.playerByClientID("think002")!;
const game = new AgentGame({ agentCount: 2, tribeCount: 0, nationCount: 0 });
// Fixture seats provide IDs only. No sockets, server, or model sessions are created.
Reflect.set(game, "seats", [
  { id: "agent001", clientId: "think001", name: "Think One" },
  { id: "agent002", clientId: "think002", name: "Think Two" },
]);
Reflect.set(game, "runner", runner);
Reflect.set(game, "observations", new ObservationBuilder(runner.game));
Reflect.set(game, "gameId_", "agentThinkE2E");
Reflect.set(game, "mapImages", new MapImages("agentThinkE2E"));
const events: AgentEvent[] = [
  {
    type: "chat",
    tick: runner.game.ticks(),
    at: Date.now(),
    data: { otherPlayerId: target.id(), message: "Fixture private reply" },
  },
];
Reflect.set(
  game,
  "histories",
  new Map([
    ["agent001", events],
    ["agent002", []],
  ]),
);
Reflect.set(
  game,
  "attackRatios",
  new Map([
    ["agent001", 0.2],
    ["agent002", 0.2],
  ]),
);

const arena = new Arena();
Reflect.set(arena, "state", {
  ...arena.snapshot(),
  phase: "running",
  gameId: "agentThinkE2E",
  players: [
    {
      id: "agent001",
      clientId: "think001",
      name: "Think One",
      alive: true,
      threadId: null,
      tokens: 0,
      decisions: 0,
      status: "ready",
    },
  ],
});
Reflect.set(arena, "game", game);
const actions = new ActionDecision();
(Reflect.get(arena, "actions") as Map<string, ActionDecision>).set(
  "agent001",
  actions,
);
const tool: (
  id: string,
  name: string,
  args: unknown,
) => Promise<GameToolResult> = Reflect.get(arena, "tool").bind(arena);
const calls = Reflect.get(arena, "calls") as Map<string, number>;
const before = {
  tick: runner.game.ticks(),
  troops: self.troops(),
  tiles: self.numTilesOwned(),
};
const note =
  "Wait for transport capacity. Inspect the coastal target before spending gold.";
const acknowledgement = await tool("agent001", "think", { note });
assert.deepEqual(acknowledgement.data, { recorded: true });
assert.equal(calls.get("agent001"), 1);
const focused = await tool("agent001", "think", {
  note: "Check public coast and my resources",
  observe: { playerId: target.id(), sections: ["self", "rivals", "events"] },
});
assert.equal(
  calls.get("agent001"),
  2,
  "A think observation uses one outer call",
);
const focusedData = z
  .object({
    self: z.object({ playerId: z.string(), troops: z.number() }),
    target: z.object({ playerId: z.string() }),
    rivals: z.array(z.record(z.string(), z.unknown())),
    events: z.array(z.unknown()),
  })
  .parse(focused.data);
assert.equal(focusedData.self.playerId, self.id());
assert.equal(focusedData.self.troops, self.troops());
assert.equal(focusedData.target.playerId, target.id());
assert.ok(
  focusedData.rivals.every(
    (rival) => !("troops" in rival) && !("gold" in rival),
  ),
);
assert.equal(focusedData.events.length, 1);
assert.equal(focused.images?.length, 1);
assert.ok(
  (await readFile(focused.images![0].path))
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
);
const repeated = await tool("agent001", "observe_world", {
  sections: ["events"],
});
assert.deepEqual(
  z.object({ events: z.array(z.unknown()) }).parse(repeated.data).events,
  [],
);
const preview = await tool("agent001", "think", {
  note: "Check nuclear risk before committing",
  observe: {
    nukePreview: { type: UnitType.AtomBomb, tile: target.spawnTile()! },
    sections: ["map"],
  },
});
assert.equal(calls.get("agent001"), 4);
assert.equal(preview.images?.length, 1);
assert.ok(
  z
    .object({ nukePreview: z.object({ type: z.literal(UnitType.AtomBomb) }) })
    .safeParse(preview.data).success,
);
await assert.rejects(
  tool("agent001", "think", { note: "Fifth call" }),
  /four-tool-call limit/,
);
assert.equal(
  arena.inspect("agent001").events.filter((event) => event.type === "think")
    .length,
  3,
);
assert.equal(
  Reflect.get(actions, "actions"),
  0,
  "Think does not use the native-action budget",
);
assert.equal(
  (Reflect.get(arena, "requestedDelays") as Map<string, number>).size,
  0,
);
assert.deepEqual(
  {
    tick: runner.game.ticks(),
    troops: self.troops(),
    tiles: self.numTilesOwned(),
  },
  before,
);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/think-e2e.json",
  JSON.stringify(
    {
      result: "passed",
      schemaBytes,
      model: MODEL,
      effort: EFFORT,
      calls: calls.get("agent001"),
      before,
      focused: focused.data,
      preview: preview.data,
      images: [...focused.images!, ...preview.images!],
      inspector: arena.inspect("agent001"),
    },
    null,
    2,
  ),
);
console.log(
  `Think E2E passed. Schema: ${schemaBytes} bytes. Artifact: .agent-arena/think-e2e.json`,
);
