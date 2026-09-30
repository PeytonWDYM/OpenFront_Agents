// Failure cases: one failure stops all agents, retry runs before 10 seconds,
// recovery changes native seats, stale calls mutate a replacement, usage resets,
// retries never stop, pause/stop/win/elimination permit recovery, or safety,
// account and deterministic input failures cause thread churn.
// The real JSON-RPC transport talks to a local fixture. No paid inference runs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Arena } from "../../src/agents/Arena";
import { CodexRuntime } from "../../src/agents/codex";
import { CodexTransport } from "../../src/agents/codex/transport";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { TurnQueue } from "../../src/agents/TurnQueue";
import type { AgentPlayer, ArenaSnapshot } from "../../src/agents/types";
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
    gameID: "recoveryFixture",
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
      { clientID: "recover1", username: "Recovery One", clanTag: null },
      { clientID: "recover2", username: "Recovery Two", clanTag: null },
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
const game = new AgentGame({ agentCount: 2, tribeCount: 0, nationCount: 0 });
Reflect.set(game, "seats", [
  { id: "agent001", clientId: "recover1", name: "Recovery One" },
  { id: "agent002", clientId: "recover2", name: "Recovery Two" },
]);
Reflect.set(game, "runner", runner);
Reflect.set(game, "feedback", new DecisionFeedback(runner.game));
Reflect.set(game, "observations", new ObservationBuilder(runner.game));
Reflect.set(game, "gameId_", "recoveryFixture");
Reflect.set(game, "mapImages", new MapImages("recoveryFixture"));
Reflect.set(
  game,
  "histories",
  new Map([
    ["agent001", []],
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
const visions = await Promise.all([
  game.vision("agent001"),
  game.vision("agent002"),
]);
game.vision = async (id) => visions[id === "agent001" ? 0 : 1];
// Keep the simulation and seats alive while each contained runtime closes.
game.close = async () => {};
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
const evidence: Record<string, unknown>[] = [];
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), "Contained runtime did not reach the expected state.");
}
async function scenario(mode: string) {
  const arena = new Arena();
  const state: ArenaSnapshot = {
    ...arena.snapshot(),
    phase: "running",
    gameId: "recoveryFixture",
    players: ["agent001", "agent002"].map((id, index) => ({
      id,
      clientId: `recover${index + 1}`,
      name: `Recovery ${index + 1}`,
      reasoningEffort: "low",
      alive: true,
      threadId: null,
      tokens: 0,
      decisions: 0,
      status: "ready",
    })),
  };
  Reflect.set(arena, "state", state);
  Reflect.set(arena, "game", game);
  const runtime = new CodexRuntime();
  runtime.artifactDirectory = await mkdtemp(
    join(tmpdir(), "openfront-recovery-test-"),
  );
  const trace = join(runtime.artifactDirectory, "protocol.jsonl");
  const onMessage: (
    method: string,
    params: Record<string, unknown>,
    id?: string | number,
  ) => Promise<void> = Reflect.get(runtime, "onMessage").bind(runtime);
  const fail: (error: Error) => void = Reflect.get(runtime, "fail").bind(
    runtime,
  );
  const transport = new CodexTransport(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("tests/agents/fixtures/recovery-app-server.ts"),
      trace,
    ],
    runtime.artifactDirectory,
    runtime.artifactDirectory,
    onMessage,
    fail,
  );
  Reflect.set(runtime, "transport", transport);
  Reflect.set(runtime, "authenticated", true);
  Reflect.set(arena, "runtime", runtime);
  const tool: (
    id: string,
    name: string,
    args: unknown,
    isActive?: () => boolean,
  ) => Promise<import("../../src/agents/codex").GameToolResult> = Reflect.get(
    arena,
    "tool",
  ).bind(arena);
  const runtimeEvent: (
    player: AgentPlayer,
    event: Record<string, unknown>,
  ) => void = Reflect.get(arena, "runtimeEvent").bind(arena);
  for (const player of state.players)
    player.threadId = await runtime.createPlayer(
      {
        id: player.id,
        prompt: player.id === "agent001" ? mode : "healthy",
        tools: [
          {
            name: "think",
            description: "Save plan",
            inputSchema: {
              type: "object",
              properties: { note: { type: "string" } },
              required: ["note"],
              additionalProperties: false,
            },
          },
        ],
      },
      (name, args, isActive) => tool(player.id, name, args, isActive),
      (event) => runtimeEvent(player, event),
    );
  const decide: (id: string) => Promise<number | void> = Reflect.get(
    arena,
    "decide",
  ).bind(arena);
  // Eligibility retains a recovering player, matching Arena's production queue.
  const queue = new TurnQueue(
    2,
    (id) =>
      state.phase === "running" &&
      state.players.find((player) => player.id === id)!.alive,
    decide,
  );
  Reflect.set(arena, "queue", queue);
  queue.start(state.players.map((player) => player.id));
  await waitFor(
    () => !!state.players[0].error && queue.activeIds().length === 0,
  );
  return { arena, state, runtime, queue, trace };
}
try {
  for (const mode of ["transient", "context"]) {
    const test = await scenario(mode);
    try {
      const before = test.arena.snapshot();
      assert.equal(before.phase, "running");
      assert.equal(before.players[0].status, "recovering");
      assert.equal(before.players[1].decisions, 1);
      const firstThread = before.players[0].threadId;
      now += 9_900;
      test.queue.wake("agent001");
      await delay(150);
      assert.equal(test.state.players[0].decisions, 0);
      now += 100;
      await waitFor(
        () =>
          test.state.players[0].decisions === 1 &&
          test.queue.activeIds().length === 0,
      );
      const after = test.arena.snapshot();
      assert.equal(after.phase, "running");
      assert.equal(after.gameId, before.gameId);
      assert.equal(after.players[0].id, before.players[0].id);
      assert.equal(after.players[0].clientId, before.players[0].clientId);
      assert.equal(after.players[0].tokens, 200);
      assert.equal(after.players[0].error, undefined);
      assert.equal(
        after.players[0].threadId === firstThread,
        mode === "transient",
      );
      assert.ok(after.players[1].decisions >= 2);
      assert.equal(
        test.arena
          .inspect("agent001", true)
          .events.some((event) => event.text.includes("STALE")),
        false,
      );
      const trace = await readFile(test.trace, "utf8");
      if (mode === "context") {
        assert.ok(trace.includes("stale-tool"));
        assert.ok(trace.includes('"success":false'));
      }
      evidence.push({ mode, before, after, trace: test.trace });
    } finally {
      await test.arena.stop();
    }
  }
  for (const mode of [
    "unsafe",
    "unknown",
    "quota",
    "codedquota",
    "codedauth",
    "http400",
    "http401",
    "http429",
    "misalignment",
    "structuredpolicy",
    "exit",
    "repeated",
  ]) {
    const test = await scenario(mode);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        now += 10_000;
        test.queue.wake("agent001");
        await delay(150);
        await test.queue.drain();
      }
      const snapshot = test.arena.snapshot();
      const shared = [
        "quota",
        "codedquota",
        "codedauth",
        "http401",
        "http429",
        "exit",
      ].includes(mode);
      assert.equal(snapshot.phase, shared ? "paused" : "running");
      assert.equal(snapshot.players[0].status, "error");
      const requests = (await readFile(test.trace, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: { threadId?: string };
            },
        );
      assert.equal(
        requests.filter((request) => request.method === "thread/start").length,
        2,
      );
      assert.equal(
        requests.filter(
          (request) =>
            request.method === "turn/start" &&
            request.params?.threadId === "fixture-thread-1",
        ).length,
        mode === "repeated" ? 4 : 1,
      );
      if (!shared) assert.ok(snapshot.players[1].decisions > 1);
      if (mode === "codedquota" || mode === "codedauth") {
        test.arena.resume();
        assert.equal(test.state.players[0].error, undefined);
      }
      if (mode === "exit") {
        assert.throws(() => test.arena.resume(), /runtime/);
        assert.equal(test.state.phase, "paused");
      }
      evidence.push({ mode, snapshot, trace: test.trace });
    } finally {
      await test.arena.stop();
    }
  }
  for (const mode of ["context", "slowcontext", "slowcontextstartfailure"]) {
    const test = await scenario(mode);
    try {
      if (mode.includes("slowcontext")) {
        now += 10_000;
        await waitFor(() => test.queue.activeIds().includes("agent001"));
      }
      await test.arena.pause();
      now += 30_000;
      await delay(150);
      const pausedThread = test.state.players[0].threadId;
      test.arena.resume();
      now += 9_900;
      test.queue.wake("agent001");
      await delay(150);
      assert.equal(test.state.players[0].decisions, 0);
      now += 100;
      await waitFor(
        () =>
          test.state.players[0].decisions === 1 &&
          test.queue.activeIds().length === 0,
      );
      if (mode === "slowcontext")
        assert.equal(test.state.players[0].threadId, pausedThread);
      const requests = (await readFile(test.trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string });
      assert.equal(
        requests.filter((request) => request.method === "thread/start").length,
        mode.includes("startfailure") ? 4 : 3,
      );
      evidence.push({
        pauseResume: mode,
        snapshot: test.arena.snapshot(),
        trace: test.trace,
      });
    } finally {
      await test.arena.stop();
    }
  }
  for (const stage of ["placement", "waiting", "review"] as const) {
    const originalObserve = game.observe.bind(game);
    const originalReview = game.spawnReview.bind(game);
    const originalConfirm = game.confirmSpawn.bind(game);
    const originalRandomSpawn = game.config.randomSpawn;
    game.config.randomSpawn = false;
    game.observe = (id, query) => ({
      ...originalObserve(id, query),
      spawnPhase: true,
    });
    let reviewCalls = 0;
    game.spawnReview = () => ({
      stage: stage === "waiting" && reviewCalls++ === 0 ? "placement" : stage,
      allPlaced: stage === "review",
      relocationsRemaining: 2,
    });
    game.confirmSpawn = () => {};
    const test = await scenario("unsafe");
    try {
      assert.equal(test.arena.snapshot().phase, "paused");
      assert.ok(test.arena.snapshot().error?.includes("spawn"));
      assert.equal(test.state.players[0].status, "error");
      assert.throws(() => test.arena.resume(), /spawn/);
      assert.equal(test.arena.snapshot().phase, "paused");
      evidence.push({
        blockedSpawnStage: stage,
        snapshot: test.arena.snapshot(),
        trace: test.trace,
      });
    } finally {
      await test.arena.stop();
      game.observe = originalObserve;
      game.spawnReview = originalReview;
      game.confirmSpawn = originalConfirm;
      game.config.randomSpawn = originalRandomSpawn;
    }
  }
  for (const cancellation of ["pause", "stop", "win", "elimination"]) {
    const test = await scenario("context");
    try {
      if (cancellation === "pause") await test.arena.pause();
      if (cancellation === "stop") await test.arena.stop();
      if (cancellation === "win") {
        const gameEvent: (event: { type: string; data: object }) => void =
          Reflect.get(test.arena, "gameEvent").bind(test.arena);
        gameEvent({ type: "win", data: {} });
      }
      if (cancellation === "elimination") {
        test.state.players[0].alive = false;
        game.players = () => [
          {
            id: "agent001",
            clientId: "recover1",
            name: "Recovery One",
            alive: false,
          },
          {
            id: "agent002",
            clientId: "recover2",
            name: "Recovery Two",
            alive: true,
          },
        ];
        test.arena.snapshot();
      }
      now += 30_000;
      await delay(150);
      const requests = (await readFile(test.trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string });
      assert.equal(
        requests.filter((request) => request.method === "thread/start").length,
        2,
      );
      evidence.push({
        cancellation,
        snapshot: test.arena.snapshot(),
        trace: test.trace,
      });
    } finally {
      await test.arena.stop();
    }
  }
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/recovery-e2e.json",
    JSON.stringify(
      {
        passed: true,
        paidInferenceRequests: 0,
        retryDelayMs: 10_000,
        evidence,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      artifact: resolve(".agent-arena/recovery-e2e.json"),
    }),
  );
} finally {
  Date.now = originalNow;
}
