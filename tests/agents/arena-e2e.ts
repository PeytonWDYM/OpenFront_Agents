import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
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

try {
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
  evidence.boundaries = {
    remoteOrigin: remoteOrigin.status,
    remoteHost: remoteHostStatus,
    invalidSettings: invalidSettings.status,
  };
  await request("/stop", {});
  const lobby = await request<ArenaSnapshot>("/create", {
    agentCount: count,
    mode: codex ? "codex" : "scripted",
    decisionIntervalMs: codex ? 15_000 : 500,
    concurrency: codex ? 2 : 4,
    maxTokens: Number(process.env.AGENT_E2E_MAX_TOKENS ?? 25_000),
    ...(codex ? { maxDecisionsPerPlayer: 1 } : {}),
  });
  assert.equal(lobby.phase, "lobby");
  assert.equal(lobby.players.length, count);
  evidence.lobby = lobby;
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
