// Failure cases: wrong sender, duplicate turns, private chat leaks, illegal management
// actions, lost spawn intents, expansion no-ops, and missing native build execution.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentGame, quickChatKeys } from "../../src/agents/game";

const game = new AgentGame({ agentCount: 8, randomSpawn: false });
const artifact: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
};
const waitFor = async (test: () => boolean, timeout = 45_000) => {
  const deadline = Date.now() + timeout;
  while (!test()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for native game state");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

try {
  artifact.lobby = await game.create();
  assert.equal(game.players().length, 8);
  await game.start();
  const seats = game.players();
  for (const seat of seats) {
    const view = game.observe(seat.id);
    const spawn = view.map.spawnCandidates[0];
    assert.ok(spawn, "Each agent needs a legal native spawn candidate");
    await game.act(seat.id, { type: "spawn", tile: spawn.tile });
    await waitFor(() => game.observe(seat.id).self.spawned);
  }
  await assert.rejects(
    game.act(seats[0].id, { type: "toggle_pause", paused: true }),
  );
  await assert.rejects(
    game.act(seats[0].id, {
      type: "spawn",
      tile: 1,
      clientID: seats[1].playerId,
    }),
  );
  await waitFor(() => !game.observe(seats[0].id).spawnPhase);
  const before = game.observe(seats[0].id).self.tiles;
  await game.act(seats[0].id, { type: "attack", targetID: null, troops: 200 });
  await waitFor(() => game.observe(seats[0].id).self.tiles > before);
  const recipient = game.players()[1].playerId!;
  await game.act(seats[0].id, { type: "allianceRequest", recipient });
  await game.act(seats[0].id, {
    type: "quick_chat",
    recipient,
    quickChatKey: quickChatKeys[0],
  });
  await waitFor(() =>
    game.observe(seats[1].id).events.some((event) => event.type === "chat"),
  );
  assert.ok(
    game
      .observe(seats[1].id)
      .events.some((event) => event.type === "alliance_request"),
  );
  for (const seat of seats.slice(2)) {
    assert.ok(
      !game.observe(seat.id).events.some((event) => event.type === "chat"),
      "Private chat leaked",
    );
  }
  await waitFor(() => game.observe(seats[0].id).self.gold >= 125_000, 180_000);
  const build = game
    .observe(seats[0].id)
    .map.buildSites.find((site) => site.type === "City");
  assert.ok(build, "Native city build site is available");
  await game.act(seats[0].id, {
    type: "build_unit",
    unit: build.type,
    tile: build.tile,
  });
  await waitFor(() =>
    game.observe(seats[0].id).self.units.some((unit) => unit.type === "City"),
  );
  artifact.players = game.players();
  artifact.observations = seats.map((seat) => game.observe(seat.id));
  const summary = game.observe(seats[0].id);
  assert.equal(summary.map.cells.length, 0);
  const overview = game.observe(seats[0].id, {
    x: 0,
    y: 0,
    width: summary.map.width,
    height: summary.map.height,
  });
  assert.ok(overview.map.cells.length <= 64);
  assert.ok(
    summary.rivals.length <= 12 &&
      summary.map.buildSites.length <= 8 &&
      summary.events.length <= 12,
  );
  artifact.summaryBytes = Buffer.byteLength(JSON.stringify(summary));
  artifact.overviewSamples = overview.map.cells.length;
  artifact.result = "passed";
} catch (error) {
  artifact.result = "failed";
  artifact.error = String(error);
  throw error;
} finally {
  await game.close();
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/game-e2e.json",
    JSON.stringify(artifact, null, 2),
  );
}
