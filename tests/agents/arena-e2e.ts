import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { TurnQueue } from "../../src/agents/TurnQueue";
import type { ArenaSnapshot, PlayerInspector } from "../../src/agents/types";

const base = "http://127.0.0.1:9010/api/agents";
const codex = process.env.AGENT_E2E_CODEX === "1";
const count = Number(process.env.AGENT_E2E_COUNT ?? (codex ? 1 : 8));
const evidence: Record<string, unknown> = {
  mode: codex ? "codex" : "scripted",
  count,
  startedAt: new Date().toISOString(),
};

async function request<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(
    base + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value: unknown = await response.json();
  assert.equal(response.ok, true, JSON.stringify(value));
  return value as T;
}

async function until(
  check: (state: ArenaSnapshot) => boolean,
  timeout = 90_000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = await request<ArenaSnapshot>();
    assert.notEqual(state.phase, "error", state.error);
    if (check(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Arena did not reach the expected state before the timeout.");
}

// Failure cases: shared concurrency ceilings, overlapping turns, lost active-turn
// events, event storms, stalled quiet players, hidden decision limits, persistent
// short delays, and decisions after pause.
async function verifyScheduler() {
  const ids = Array.from({ length: 20 }, (_, index) => `queue${index}`);
  const decisions = new Map<string, number>();
  const release = new Map<string, () => void>();
  const queue = new TurnQueue(
    ids.length,
    () => true,
    async (id) => {
      const count = (decisions.get(id) ?? 0) + 1;
      decisions.set(id, count);
      if (count === 1)
        await new Promise<void>((resolve) => release.set(id, resolve));
      if (id === ids[19] && count === 1) return 1_000;
    },
  );
  try {
    queue.start(ids);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queue.activeIds().length, ids.length);
    for (let index = 0; index < 100; index++) queue.wake(ids[0]);
    assert.equal(decisions.get(ids[0]), 1);
    for (const resolve of release.values()) resolve();
    await queue.drain();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(decisions.get(ids[0]), 1);
    const requestedDeadline = Date.now() + 2_000;
    while ((decisions.get(ids[19]) ?? 0) < 2 && Date.now() < requestedDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(decisions.get(ids[19]), 2);
    const deadline = Date.now() + 8_000;
    while ((decisions.get(ids[0]) ?? 0) < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(decisions.get(ids[0]), 2);
    assert.equal(decisions.get(ids[1]), 1);
    assert.equal(
      decisions.get(ids[19]),
      2,
      "A short delay must reset after its next decision.",
    );
    const quietDeadline = Date.now() + 13_000;
    while ((decisions.get(ids[0]) ?? 0) < 3 && Date.now() < quietDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((decisions.get(ids[0]) ?? 0) >= 3);
    assert.ok(ids.every((id) => (decisions.get(id) ?? 0) >= 2));
    queue.pause();
    const pausedDecisions = decisions.get(ids[1]);
    queue.wake(ids[1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(decisions.get(ids[1]), pausedDecisions);
    return {
      concurrentPlayers: ids.length,
      coalescedEvents: 100,
      requestedDelayMs: 1_000,
      decisions: [...decisions],
    };
  } finally {
    queue.pause();
    for (const resolve of release.values()) resolve();
    await queue.drain();
  }
}

try {
  evidence.scheduler = await verifyScheduler();
  const remoteOrigin = await fetch(base, {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(remoteOrigin.status, 403);
  const remoteHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      get(base, { headers: { Host: "example.com" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    },
  );
  assert.equal(remoteHostStatus, 403);
  const invalidSettings = await fetch(`${base}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentCount: 201 }),
  });
  assert.equal(invalidSettings.status, 400);
  for (const tribeCount of [-1, 401]) {
    const invalidTribes = await fetch(`${base}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tribeCount }),
    });
    assert.equal(invalidTribes.status, 400);
  }
  for (const nationCount of [-1, 401]) {
    const invalidNations = await fetch(`${base}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nationCount }),
    });
    assert.equal(invalidNations.status, 400);
  }
  const removedSettings = await fetch(`${base}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "scripted", maxTokens: 100_000 }),
  });
  assert.equal(removedSettings.status, 400);
  const removedDecisionLimit = await fetch(`${base}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "scripted", maxDecisionsPerPlayer: 1 }),
  });
  assert.equal(removedDecisionLimit.status, 400);
  evidence.boundaries = {
    remoteOrigin: remoteOrigin.status,
    remoteHost: remoteHostStatus,
    invalidSettings: invalidSettings.status,
    removedSettings: removedSettings.status,
    removedDecisionLimit: removedDecisionLimit.status,
  };
  await request("/stop", {});
  const lobby = await request<ArenaSnapshot>("/create", {
    agentCount: count,
    mode: codex ? "codex" : "scripted",
    tribeCount: 0,
    nationCount: 0,
  });
  assert.equal(lobby.phase, "lobby");
  assert.equal(lobby.players.length, count);
  evidence.lobby = lobby;
  const unjoinedStart = await fetch(`${base}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "unjoined-human", spectator: false }),
  });
  assert.equal(unjoinedStart.status, 409);
  assert.equal((await request<ArenaSnapshot>()).phase, "lobby");
  evidence.unjoinedStart = unjoinedStart.status;
  await request("/start", {});
  const progressed = await until((state) =>
    state.players.every(
      (player) =>
        (player.decisions ?? 0) >= (codex ? 1 : 2) && !!player.lastAction,
    ),
  );
  const paused = await request<ArenaSnapshot>("/pause", {});
  assert.equal(paused.phase, "paused");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stillPaused = await request<ArenaSnapshot>();
  assert.deepEqual(
    stillPaused.players.map((player) => player.decisions),
    paused.players.map((player) => player.decisions),
  );
  const inspectors = await Promise.all(
    paused.players.map((player) =>
      request<PlayerInspector>(`/players/${player.id}`),
    ),
  );
  const fullThread = await request<PlayerInspector>(
    `/players/${paused.players[0].id}?full=1`,
  );
  assert.ok(fullThread.events.length >= inspectors[0].events.length);
  evidence.fullThreadEvents = fullThread.events.length;
  evidence.progressed = progressed;
  evidence.paused = paused;
  evidence.inspectors = inspectors;
  assert.equal(
    inspectors.every((item) =>
      item.events.some((event) => event.type === "action"),
    ),
    true,
  );
  if (codex) {
    assert.equal(
      paused.players.every((player) => !!player.threadId),
      true,
    );
    const vision = fullThread.events.find((event) => event.type === "vision");
    assert.ok(
      vision?.image,
      "The full transcript must retain the decision frame.",
    );
    const frame = await fetch(`http://127.0.0.1:9010${vision.image}`);
    assert.equal(frame.ok, true);
    assert.equal(frame.headers.get("Content-Type"), "image/png");
    evidence.visionFrame = vision.image;
    await request(`/players/${paused.players[0].id}/compact`, {});
  } else {
    const observation = await request<{
      observation: { tick: number; self: { troops: number; tiles: number } };
    }>(`/players/${paused.players[0].id}/observation`);
    assert.ok(observation.observation.tick > 0);
    assert.ok(observation.observation.self.tiles > 0);
    evidence.observation = observation;
    await request("/resume", {});
    await until((state) =>
      state.players.some(
        (player, index) =>
          (player.decisions ?? 0) > (progressed.players[index].decisions ?? 0),
      ),
    );
  }
  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    evidence.stopped = await request<ArenaSnapshot>("/stop", {});
  } catch (error) {
    evidence.stopError = error instanceof Error ? error.message : String(error);
    evidence.result = "failed";
    process.exitCode = 1;
  }
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/e2e-report.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      result: evidence.result,
      artifact: ".agent-arena/e2e-report.json",
      error: evidence.error,
    }),
  );
}
