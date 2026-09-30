// Failure cases: early confirmation skips review, placed agents never get review,
// a third relocation succeeds, queued moves revert on confirmation, or scripted
// decisions leave the native countdown blocked after all reviews finish.
// The last unplaced seat can batch picks while its mirror still says placement.
// Native accepted moves must reduce the later review budget.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Arena } from "../../src/agents/Arena";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { ArenaSettingsSchema } from "../../src/agents/Settings";
import type { ArenaSnapshot } from "../../src/agents/types";
import { MapImages } from "../../src/agents/vision";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import { SpawnTimerExecution } from "../../src/core/execution/SpawnTimerExecution";
import { GameType, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import type { ClientMessage } from "../../src/core/Schemas";
import { setup } from "../util/Setup";

const infos = [
  new PlayerInfo("Agent 1", PlayerType.Human, "agent001", "first"),
  new PlayerInfo("Agent 2", PlayerType.Human, "agent002", "second"),
];
const game = await setup(
  "plains",
  {
    gameType: GameType.Private,
    spawnReadyClientIDs: infos.map((info) => info.clientID!),
    requireSpawnConfirmation: true,
  },
  infos,
  undefined,
  undefined,
  false,
);
game.addExecution(new SpawnTimerExecution());
const bridge = new AgentGame({ agentCount: 2 });
bridge.config.requireSpawnConfirmation = true;
bridge.config.spawnReadyClientIDs = infos.map((info) => info.clientID!);
Reflect.set(bridge, "runner", { game });
Reflect.set(bridge, "observations", new ObservationBuilder(game));
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(
  bridge,
  "histories",
  new Map(infos.map((info) => [info.clientID!, []])),
);
Reflect.set(
  bridge,
  "attackRatios",
  new Map(infos.map((info) => [info.clientID!, 0.2])),
);
const submissions: { agentId: string; tick: number; intent: unknown }[] = [];
Reflect.set(
  bridge,
  "seats",
  infos.map((info) => ({
    id: info.clientID!,
    clientId: info.clientID!,
    name: info.name,
    send(message: ClientMessage) {
      assert.equal(message.type, "intent");
      if (message.type !== "intent")
        throw new Error("Expected a native intent");
      assert.equal(message.intent.type, "spawn");
      if (message.intent.type !== "spawn")
        throw new Error("Expected a spawn intent");
      submissions.push({
        agentId: info.clientID!,
        tick: game.ticks(),
        intent: message.intent,
      });
      game.addExecution(
        new SpawnExecution(
          "spawn-review",
          info,
          message.intent.tile,
          true,
          message.intent.confirm,
        ),
      );
    },
  })),
);
const advance = (ticks: number) => {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
};
const arena = new Arena();
Reflect.set(arena, "game", bridge);
const state: ArenaSnapshot = {
  phase: "running",
  gameId: "spawn-review",
  settings: ArenaSettingsSchema.parse({ mode: "scripted", agentCount: 2 }),
  players: infos.map((info) => ({
    id: info.clientID!,
    clientId: info.clientID!,
    name: info.name,
    alive: true,
    reasoningEffort: "low",
    threadId: null,
    tokens: 0,
    decisions: 0,
    status: "ready",
  })),
  runtime: { authenticated: false, models: [] },
  totalTokens: 0,
};
Reflect.set(arena, "state", state);
const decide = Reflect.get(arena, "decide") as (id: string) => Promise<unknown>;
await decide.call(arena, "agent001");
advance(4);
assert.equal(bridge.spawnReview("agent001").stage, "waiting");
const decisionCount = state.players[0].decisions;
await decide.call(arena, "agent001");
assert.equal(state.players[0].decisions, decisionCount);
await decide.call(arena, "agent002");
const lastSeatChoices = bridge.observe("agent002").map.spawnCandidates;
await bridge.act("agent002", { type: "spawn", tile: lastSeatChoices[3].tile });
await bridge.act("agent002", { type: "spawn", tile: lastSeatChoices[7].tile });
advance(4);
assert.equal(bridge.spawnReview("agent001").stage, "review");
assert.equal(bridge.spawnReview("agent002").stage, "review");
assert.equal(game.player(infos[1].id).numSpawnRelocations(), 2);
assert.equal(bridge.spawnReview("agent002").relocationsRemaining, 0);
await assert.rejects(
  bridge.act("agent002", { type: "spawn", tile: lastSeatChoices[10].tile }),
  /at most two/,
);
assert.equal(game.player(infos[0].id).hasConfirmedSpawn(), false);
advance(1_000);
assert.equal(game.inSpawnPhase(), true);

const choices = bridge.observe("agent001").map.spawnCandidates;
await assert.rejects(
  bridge.act("agent001", {
    type: "spawn",
    tile: game.player(infos[1].id).spawnTile(),
  }),
);
assert.equal(bridge.spawnReview("agent001").relocationsRemaining, 2);
await bridge.act("agent001", {
  type: "spawn",
  tile: choices[3].tile,
  confirm: true,
});
await bridge.act("agent001", { type: "spawn", tile: choices[7].tile });
await assert.rejects(
  bridge.act("agent001", { type: "spawn", tile: choices[10].tile }),
  /at most two/,
);
assert.equal(game.player(infos[0].id).hasConfirmedSpawn(), false);
await decide.call(arena, "agent001");
advance(4);
assert.equal(game.player(infos[0].id).spawnTile(), choices[7].tile);
assert.equal(game.player(infos[0].id).hasConfirmedSpawn(), true);
assert.equal(game.player(infos[1].id).hasConfirmedSpawn(), false);
advance(300);
assert.equal(game.inSpawnPhase(), true);
// A local runtime stand-in resolves its interrupted turn, as Codex does.
// The game simulation and image renderer remain real. No service is contacted.
Reflect.set(bridge, "mapImages", new MapImages("spawn-review-e2e"));
state.settings.mode = "codex";
state.players[1].threadId = "local-review-timeout";
let finishTurn: () => void;
let interruptions = 0;
Reflect.set(arena, "runtime", {
  turn(_threadId: string, prompt: string) {
    assert.match(prompt, /Every agent now has a valid placement/);
    const supplied = JSON.parse(prompt.split("Current game state: ")[1]);
    assert.deepEqual(supplied.images[0].unitGroups, []);
    assert.equal(supplied.images[0].unitGroupCount, 0);
    return new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
  },
  async interrupt() {
    interruptions++;
    finishTurn();
  },
});
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((
  callback: Parameters<typeof setTimeout>[0],
  milliseconds?: number,
  ...args: unknown[]
) =>
  nativeSetTimeout(
    callback,
    milliseconds === 90_000 ? 1 : milliseconds,
    ...args,
  )) as typeof setTimeout;
try {
  await decide.call(arena, "agent002");
} finally {
  globalThis.setTimeout = nativeSetTimeout;
}
assert.equal(interruptions, 1);
advance(4);
assert.equal(game.player(infos[1].id).hasConfirmedSpawn(), true);
advance(game.config().numSpawnPhaseTurns() + 2);
assert.equal(game.inSpawnPhase(), false);
assert.equal(state.phase, "running");

await mkdir(".agent-arena/verification", { recursive: true });
await writeFile(
  ".agent-arena/verification/spawn-review-e2e.json",
  JSON.stringify(
    {
      passed: true,
      checks: [
        "scripted placement",
        "wait for all placements",
        "review after all placements",
        "invalid relocation preserves allowance",
        "two relocation limit",
        "batched last-seat placements reduce the native review budget",
        "agent cannot confirm early",
        "ordered confirmation keeps final relocation",
        "scripted review confirms",
        "timed-out review confirms",
        "countdown after every review",
      ],
      submissions,
      finalTick: game.ticks(),
      players: infos.map((info) => ({
        id: info.id,
        tile: game.player(info.id).spawnTile(),
        confirmed: game.player(info.id).hasConfirmedSpawn(),
      })),
    },
    null,
    2,
  ),
);
console.log(
  "Spawn review E2E passed. Artifact: .agent-arena/verification/spawn-review-e2e.json",
);
