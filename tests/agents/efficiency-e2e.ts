// Failure cases: repeated overview images inflate quiet decisions, an overview
// never refreshes, fresh tactical images disappear, saved notes vanish, or
// targeted observations lose native IDs. Use the real mirror and image renderer.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Arena } from "../../src/agents/Arena";
import type { GameImage, GameToolResult } from "../../src/agents/codex";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { MapImages } from "../../src/agents/vision";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import { createGameRunner } from "../../src/core/GameRunner";

const runner = await createGameRunner(
  {
    gameID: "agentEfficiencyE2E",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Europe,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      bots: 100,
      nations: 13,
      randomSpawn: true,
      donateGold: true,
      donateTroops: true,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
    },
    players: [
      { clientID: "effic001", username: "Efficiency One", clanTag: null },
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
const game = new AgentGame({ agentCount: 1, tribeCount: 100, nationCount: 13 });
Reflect.set(game, "seats", [
  { id: "agent001", clientId: "effic001", name: "Efficiency One" },
]);
Reflect.set(game, "runner", runner);
Reflect.set(game, "observations", new ObservationBuilder(runner.game));
Reflect.set(game, "gameId_", "agentEfficiencyE2E");
Reflect.set(game, "mapImages", new MapImages("agentEfficiencyE2E"));
Reflect.set(game, "histories", new Map([["agent001", []]]));
Reflect.set(game, "attackRatios", new Map([["agent001", 0.2]]));
const arena = new Arena();
Reflect.set(arena, "state", {
  ...arena.snapshot(),
  phase: "running",
  gameId: "agentEfficiencyE2E",
  players: [
    {
      id: "agent001",
      clientId: "effic001",
      name: "Efficiency One",
      alive: true,
      threadId: "efficiency-thread",
      tokens: 0,
      decisions: 0,
      status: "ready",
    },
  ],
});
Reflect.set(arena, "game", game);
const requests: { text: string; images: readonly GameImage[] }[] = [];
Reflect.set(arena, "runtime", {
  turn: async (
    _threadId: string,
    text: string,
    images: readonly GameImage[],
  ) => {
    requests.push({ text, images });
  },
});
const decide: (id: string) => Promise<unknown> = Reflect.get(
  arena,
  "decide",
).bind(arena);
const tool: (
  id: string,
  name: string,
  args: unknown,
) => Promise<GameToolResult> = Reflect.get(arena, "tool").bind(arena);
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
try {
  await tool("agent001", "think", {
    note: "Keep the eastern harbor as my next target.",
  });
  await decide("agent001");
  now += 10_000;
  runner.addTurn({ turnNumber: runner.game.ticks(), intents: [] });
  assert.ok(runner.executeNextTick());
  await decide("agent001");
  now += 60_000;
  await decide("agent001");
  assert.deepEqual(
    requests.map((request) => request.images.length),
    [2, 1, 2],
  );
  assert.notEqual(requests[0].images[1].path, requests[1].images[0].path);
  assert.ok(
    requests.every((request) =>
      request.text.includes("Keep the eastern harbor as my next target."),
    ),
  );
  const raw = game.observe("agent001");
  const allRivals = await tool("agent001", "observe_world", {
    sections: ["rivals"],
  });
  assert.ok(JSON.stringify(allRivals.data).includes(raw.rivals[0].playerId));
  const decisions = arena.snapshot().players[0].decisions;
  assert.equal(decisions, 3);
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/efficiency-report.json",
    JSON.stringify(
      {
        passed: true,
        realMap: "Europe",
        tribes: 100,
        nations: 13,
        decisions,
        rawObservationBytes: Buffer.byteLength(JSON.stringify(raw)),
        turnTextBytes: requests.map((request) =>
          Buffer.byteLength(request.text),
        ),
        imageCounts: requests.map((request) => request.images.length),
        frames: requests.map((request) =>
          request.images.map((image) => image.path),
        ),
        savedStrategy: "Keep the eastern harbor as my next target.",
        note: "Image counts and payload bytes are savings proxies. This test does not measure model token usage.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      artifact: ".agent-arena/efficiency-report.json",
    }),
  );
} finally {
  Date.now = originalNow;
}
