// Failure cases: wrong sender, duplicate turns, private chat leaks, illegal management
// actions, lost spawn intents, expansion no-ops, missing native build execution,
// absent tribes/nations, crowded agent spawns, invalid native recipient IDs,
// lost diplomatic replies, redundant map samples, leaked rival resources,
// ignored nation counts, disabled nations that still spawn, and extra nations that never spawn.
// Controls failures: invalid ratios, lost ratio state, wrong percentage forces,
// changed explicit troop amounts, rounded boat forces, missing actions, and oversized tool schemas.
// Timing failures: valid short delays rejected, invalid delays accepted, or metadata sent as a native intent.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { projectDecisionObservation } from "../../src/agents/game/decision";
import { playerEvents } from "../../src/agents/game/events";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import {
  AgentActionSchema,
  AgentEvent,
  AgentToolInputSchema,
  agentActionToolSchema,
  quickChatKeys,
} from "../../src/agents/game/schemas";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
} from "../../src/core/game/Game";
import { createGameRunner } from "../../src/core/GameRunner";
import { GameStartInfo } from "../../src/core/Schemas";
import { flattenedEmojiTable } from "../../src/core/Util";

async function nativePopulationCheck() {
  assert.equal(
    AgentToolInputSchema.parse({ nextDecisionSeconds: 1 }).nextDecisionSeconds,
    1,
  );
  assert.throws(() => AgentToolInputSchema.parse({}));
  assert.throws(() =>
    AgentToolInputSchema.parse({ attackRatio: 0.5, nextDecisionSeconds: 1 }),
  );
  for (const nextDecisionSeconds of [1, 10])
    assert.equal(
      AgentToolInputSchema.parse({
        intent: { type: "attack", targetID: null, troops: null },
        nextDecisionSeconds,
      }).nextDecisionSeconds,
      nextDecisionSeconds,
    );
  for (const nextDecisionSeconds of [0, 11, 1.5])
    assert.throws(() =>
      AgentToolInputSchema.parse({
        intent: { type: "attack", targetID: null, troops: null },
        nextDecisionSeconds,
      }),
    );
  assert.equal(AgentActionSchema.options.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(agentActionToolSchema)) <= 5_000);
  for (const attackRatio of [-0.1, 1.1, Number.NaN])
    assert.throws(() =>
      AgentToolInputSchema.parse({
        intent: { type: "attack", targetID: null, troops: null },
        attackRatio,
      }),
    );
  assert.throws(() =>
    AgentToolInputSchema.parse({
      intent: {
        type: "attack",
        targetID: null,
        troops: null,
        clientID: "forged00",
      },
      attackRatio: 0.5,
    }),
  );
  const { AgentGame } = await import("../../src/agents/game");
  for (const nationCount of [-1, 401, 1.5])
    assert.throws(() => new AgentGame({ agentCount: 1, nationCount }));
  const start: GameStartInfo = {
    gameID: "agentNativeE2E",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Europe,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      bots: 100,
      nations: 52,
      randomSpawn: true,
      donateGold: true,
      donateTroops: true,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
    },
    players: Array.from({ length: 8 }, (_, index) => ({
      clientID: `native${index}`,
      username: `Native ${index}`,
      clanTag: null,
    })),
  };
  const events: AgentEvent[] = [];
  const runner = await createGameRunner(
    start,
    undefined,
    new LocalMapLoader(),
    (update) => {
      if ("errMsg" in update) throw new Error(update.errMsg);
      const self = runner.game.playerByClientID("native0");
      if (self) events.push(...playerEvents(runner.game, self, update.updates));
    },
  );
  const step = (
    intents: Parameters<typeof runner.addTurn>[0]["intents"] = [],
  ) => {
    runner.addTurn({ turnNumber: runner.game.ticks(), intents });
    assert.ok(runner.executeNextTick());
  };
  for (let index = 0; index < 200; index++) step();
  const native = runner.game;
  const humans = native
    .allPlayers()
    .filter((player) => player.type() === PlayerType.Human);
  const tribes = native
    .allPlayers()
    .filter((player) => player.type() === PlayerType.Bot);
  const nations = native
    .allPlayers()
    .filter((player) => player.type() === PlayerType.Nation);
  assert.equal(humans.length, 8);
  assert.equal(tribes.length, 100);
  assert.equal(nations.length, 52);
  for (const [index, player] of humans.entries()) {
    assert.ok(player.hasSpawned());
    for (const other of humans.slice(index + 1)) {
      assert.ok(
        native.manhattanDist(player.spawnTile()!, other.spawnTile()!) >=
          native.config().minDistanceBetweenPlayers(),
      );
    }
  }
  const builder = new ObservationBuilder(native);
  const self = humans[0];
  const tribe = tribes[0];
  step([
    { type: "allianceRequest", recipient: tribe.id(), clientID: "native0" },
  ]);
  for (let index = 0; index < 170; index++) step();
  assert.ok(self.isAlliedWith(tribe), "Native tribes accept alliance requests");
  const view = builder.observe("agent001", self, 0, {}, events);
  assert.equal(view.self.playerType, PlayerType.Human);
  assert.equal(
    view.self.smallId,
    self.smallID(),
    "Image labels match native player IDs",
  );
  assert.ok(
    view.rivals.some((rival) => rival.playerId === tribe.id()),
    "Relevant tribe ally stays visible",
  );
  assert.ok(
    view.rivals.every((rival) => !("gold" in rival) && !("troops" in rival)),
  );
  assert.equal(view.map.cells.length, 0);
  const compact = projectDecisionObservation(view);
  assert.ok(
    Buffer.byteLength(JSON.stringify(compact)) <
      Buffer.byteLength(JSON.stringify(view)),
  );
  const chatBefore = events.length;
  step([
    {
      type: "quick_chat",
      recipient: tribe.id(),
      quickChatKey: "help.alliance",
      clientID: "native0",
    },
  ]);
  for (let index = 0; index < 4; index++) step();
  assert.ok(
    events
      .slice(chatBefore)
      .some(
        (event) =>
          event.type === "chat" && event.data.otherPlayerId === tribe.id(),
      ),
  );
  const nation = nations.find((player) => player.isAlive())!;
  step([
    {
      type: "emoji",
      recipient: nation.id(),
      emoji: flattenedEmojiTable.indexOf("🕊️"),
      clientID: "native0",
    },
  ]);
  for (let index = 0; index < 4; index++) step();
  assert.ok(
    events.some(
      (event) =>
        event.type === "emoji" &&
        event.data.sender === nation.id() &&
        event.data.recipient === self.id(),
    ),
  );
  const same = await createGameRunner(
    start,
    undefined,
    new LocalMapLoader(),
    (update) => {
      if ("errMsg" in update) throw new Error(update.errMsg);
    },
  );
  for (let index = 0; index < 200; index++) {
    same.addTurn({ turnNumber: same.game.ticks(), intents: [] });
    assert.ok(same.executeNextTick());
  }
  assert.deepEqual(
    humans.map((player) => player.spawnTile()),
    same.game
      .allPlayers()
      .filter((player) => player.type() === PlayerType.Human)
      .map((player) => player.spawnTile()),
  );
  const populationCases: {
    requestedTribes: number;
    requestedNations: number;
    tribes: number;
    nations: number;
    spawnedNations: number;
  }[] = [];
  for (const { tribeCount, nationCount } of [
    { tribeCount: 11, nationCount: 7 },
    { tribeCount: 11, nationCount: 0 },
    { tribeCount: 11, nationCount: 64 },
  ]) {
    const configured = await createGameRunner(
      {
        ...start,
        gameID: `population${nationCount}`,
        config: {
          ...start.config,
          bots: tribeCount,
          nations: nationCount === 0 ? "disabled" : nationCount,
        },
      },
      undefined,
      new LocalMapLoader(),
      (update) => {
        if ("errMsg" in update) throw new Error(update.errMsg);
      },
    );
    for (let index = 0; index < 200; index++) {
      configured.addTurn({ turnNumber: configured.game.ticks(), intents: [] });
      assert.ok(configured.executeNextTick());
    }
    const players = configured.game.allPlayers();
    const actualTribes = players.filter(
      (player) => player.type() === PlayerType.Bot,
    );
    const actualNations = players.filter(
      (player) => player.type() === PlayerType.Nation,
    );
    assert.equal(actualTribes.length, tribeCount);
    assert.equal(actualNations.length, nationCount);
    assert.equal(
      actualNations.filter((player) => player.hasSpawned()).length,
      nationCount,
    );
    populationCases.push({
      requestedTribes: tribeCount,
      requestedNations: nationCount,
      tribes: actualTribes.length,
      nations: actualNations.length,
      spawnedNations: actualNations.filter((player) => player.hasSpawned())
        .length,
    });
  }
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/native-population-e2e.json",
    JSON.stringify(
      {
        result: "passed",
        toolSchemaBytes: Buffer.byteLength(
          JSON.stringify(agentActionToolSchema),
        ),
        nativeActionTypes: AgentActionSchema.options.map(
          (option) => option.shape.type.value,
        ),
        seed: start.gameID,
        config: start.config,
        population: {
          humans: humans.length,
          tribes: tribes.length,
          nations: nations.length,
        },
        populationCases,
        spawns: humans.map((player) => ({
          id: player.id(),
          tile: player.spawnTile(),
        })),
        compactBytes: Buffer.byteLength(JSON.stringify(compact)),
        observationBytes: Buffer.byteLength(JSON.stringify(view)),
        events,
      },
      null,
      2,
    ),
  );
}

if (process.argv.includes("--native-only")) {
  await nativePopulationCheck();
  process.exit(0);
}

const { AgentGame } = await import("../../src/agents/game");
const game = new AgentGame({
  agentCount: 8,
  tribeCount: 0,
  nationCount: 0,
  randomSpawn: false,
});
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
  assert.ok(
    game.players().every((seat) => seat.clientId.length >= 8),
    "Player snapshots expose native client IDs for map focus",
  );
  await assert.rejects(
    game.validateJoin({ clientId: "notJoined", spectator: false }),
    /not joined/,
  );
  await game.start();
  const seats = game.players();
  assert.ok(
    seats.every((seat) =>
      game.gameStart!.players.some(
        (player) => player.clientID === seat.clientId,
      ),
    ),
  );
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
  const seatId = seats[0].id;
  assert.equal(game.observe(seatId).self.attackRatio, 0.2);
  for (const attackRatio of [-0.1, 1.1, Number.NaN])
    await assert.rejects(
      game.act(
        seatId,
        { type: "attack", targetID: null, troops: null },
        attackRatio,
      ),
    );
  const percentAttack = async (ratio: number, suppliedRatio?: number) => {
    const before = game.observe(seatId).self.troops;
    const result = await game.act(
      seatId,
      { type: "attack", targetID: null, troops: null },
      suppliedRatio,
    );
    assert.ok(result.intent.type === "attack" && result.intent.troops !== null);
    assert.ok(
      result.intent.troops >= before * ratio &&
        result.intent.troops < (before + 1) * ratio,
    );
    assert.equal(result.attackRatio, ratio);
    await waitFor(() => game.observe(seatId).tick > result.tick + 1);
    return result;
  };
  const ratioActions = [
    await percentAttack(0.2),
    await percentAttack(0.5, 0.5),
  ];
  assert.equal(game.observe(seatId).self.attackRatio, 0.5);
  ratioActions.push(await percentAttack(0.5));
  const explicit = await game.act(seatId, {
    type: "attack",
    targetID: null,
    troops: 123,
  });
  assert.ok(explicit.intent.type === "attack");
  assert.equal(explicit.intent.troops, 123);
  const beforeBoat = game.observe(seatId).self.troops;
  const boat = await game.act(
    seatId,
    { type: "boat", dst: 0, troops: 123 },
    0.333,
  );
  assert.ok(boat.intent.type === "boat");
  assert.ok(
    boat.intent.troops >= beforeBoat * 0.333 &&
      boat.intent.troops < (beforeBoat + 1) * 0.333,
  );
  assert.equal(game.observe(seatId).self.attackRatio, 0.333);
  artifact.ratioActions = [...ratioActions, explicit, boat];
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
  if (!process.argv.includes("--controls-only")) {
    await waitFor(
      () => game.observe(seats[0].id).self.gold >= 125_000,
      180_000,
    );
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
  }
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
