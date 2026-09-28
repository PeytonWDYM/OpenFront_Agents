// Failure cases: wrong sender, duplicate turns, private chat leaks, illegal management
// actions, lost spawn intents, expansion no-ops, missing native build execution,
// absent tribes/nations, crowded agent spawns, invalid native recipient IDs,
// lost diplomatic replies, redundant map samples, leaked rival resources,
// ignored nation counts, disabled nations that still spawn, and extra nations that never spawn.
// Controls failures: invalid ratios, lost ratio state, wrong percentage forces,
// changed explicit troop amounts, rounded boat forces, missing actions, and oversized tool schemas.
// Timing failures: valid short delays rejected, invalid delays accepted, or metadata sent as a native intent.
// Observation failures: distant humans hide nearby tribes, border opponents disappear,
// false upgrade IDs become actions, and coastal players cannot find or execute neutral transports.
// Nuclear failure: a legal launch-silo coordinate replaces the requested enemy target.
// Land attack failure: permissions expose an attack against a player with no shared land border.
// Regional units failures: later owned IDs disappear, public structures are missing,
// or enemy ships and private resources leak into a regional inspection.
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
  UnitType,
} from "../../src/core/game/Game";
import { createGameRunner } from "../../src/core/GameRunner";
import { GameStartInfo, Turn } from "../../src/core/Schemas";
import { flattenedEmojiTable } from "../../src/core/Util";

async function nativeObservationCheck(start: GameStartInfo) {
  const fixture = await createGameRunner(
    {
      ...start,
      gameID: "agentViewE2E",
      config: { ...start.config, nations: 13, startingGold: 5_000_000 },
      players: Array.from({ length: 32 }, (_, index) => ({
        clientID: `view${String(index).padStart(4, "0")}`,
        username: `View ${index}`,
        clanTag: null,
      })),
    },
    undefined,
    new LocalMapLoader(),
    (update) => {
      if ("errMsg" in update) throw new Error(update.errMsg);
    },
  );
  const advance = (
    runner: typeof fixture,
    ticks: number,
    intents: Turn["intents"] = [],
  ) => {
    for (let index = 0; index < ticks; index++) {
      runner.addTurn({
        turnNumber: runner.game.ticks(),
        intents: index === 0 ? intents : [],
      });
      assert.ok(runner.executeNextTick());
    }
  };
  advance(fixture, 200);
  const world = fixture.game;
  const self = world
    .allPlayers()
    .find(
      (player) =>
        player.type() === PlayerType.Human &&
        player.incomingAttacks().length === 0 &&
        !world
          .allPlayers()
          .some((rival) => rival !== player && player.sharesBorderWith(rival)),
    )!;
  assert.ok(self, "Fixture has a player without active borders or diplomacy");
  const nearest = world
    .allPlayers()
    .filter((rival) => rival !== self && rival.isAlive())
    .sort(
      (a, b) =>
        world.euclideanDistSquared(self.spawnTile()!, a.spawnTile()!) -
        world.euclideanDistSquared(self.spawnTile()!, b.spawnTile()!),
    )
    .slice(0, 6);
  assert.ok(
    nearest.some((rival) => rival.type() === PlayerType.Bot),
    "Fixture has nearby tribes",
  );
  const builder = new ObservationBuilder(world);
  const initial = projectDecisionObservation(
    builder.observe("visibility", self, 0, {}, []),
  );
  assert.deepEqual(
    initial.rivals!.map((rival) => rival.playerId),
    nearest.map((rival) => rival.id()),
    "Compact rivals reflect nearby public players, regardless of type",
  );
  assert.ok(
    initial.rivals!.every(
      (rival) => !rival.availableActions.includes("attack"),
    ),
    "Distant rivals never offer an unreachable land attack",
  );
  assert.ok(initial.map!.buildSites.length > 0);
  assert.ok(
    initial.map!.buildSites.every(
      (site) => !("upgradeId" in site) || typeof site.upgradeId === "number",
    ),
    "Missing upgrades never appear as false IDs",
  );
  const city = initial.map!.buildSites.find(
    (site) => site.type === UnitType.City,
  )!;
  assert.ok(city);
  advance(fixture, 30, [
    {
      type: "build_unit",
      unit: UnitType.City,
      tile: city.tile,
      clientID: self.clientID()!,
    },
  ]);
  const ownedCity = self.units(UnitType.City)[0];
  assert.ok(ownedCity && !ownedCity.isUnderConstruction());
  const upgrade = projectDecisionObservation(
    builder.observe("visibility", self, 0, {}, []),
  ).map!.buildSites.find((site) => site.type === UnitType.City);
  assert.ok(upgrade && "upgradeId" in upgrade);
  assert.equal(
    upgrade.upgradeId,
    ownedCity.id(),
    "Legal upgrades retain the actual native unit ID",
  );
  advance(fixture, 50, [
    {
      type: "attack",
      targetID: null,
      troops: 10_000,
      clientID: self.clientID()!,
    },
  ]);
  const siloSite = builder
    .observe("visibility", self, 0, {}, [])
    .map.buildSites.find((site) => site.type === UnitType.MissileSilo)!;
  assert.ok(siloSite);
  advance(fixture, 1, [
    {
      type: "build_unit",
      unit: UnitType.MissileSilo,
      tile: siloSite.tile,
      clientID: self.clientID()!,
    },
  ]);
  for (
    let index = 0;
    index < 250 &&
    !self
      .units(UnitType.MissileSilo)
      .some((unit) => !unit.isUnderConstruction());
    index++
  )
    advance(fixture, 1);
  assert.ok(
    self
      .units(UnitType.MissileSilo)
      .some((unit) => !unit.isUnderConstruction()),
  );
  const enemy = world
    .allPlayers()
    .find(
      (player) =>
        player !== self &&
        player.type() === PlayerType.Human &&
        player.isAlive(),
    )!;
  const targetTile = enemy.spawnTile()!;
  const nuclear = builder
    .observe(
      "visibility",
      self,
      0,
      { x: world.x(targetTile), y: world.y(targetTile), width: 1, height: 1 },
      [],
    )
    .map.buildSites.find((site) => site.type === UnitType.AtomBomb)!;
  assert.ok(nuclear);
  assert.equal(
    nuclear.tile,
    targetTile,
    "A nuclear hint preserves the queried enemy destination, not the launch silo",
  );
  advance(fixture, 1, [
    {
      type: "build_unit",
      unit: UnitType.AtomBomb,
      tile: nuclear.tile,
      clientID: self.clientID()!,
    },
  ]);
  let missile = self
    .units(UnitType.AtomBomb)
    .find((unit) => unit.targetTile() === targetTile);
  for (let index = 0; index < 10 && !missile; index++) {
    advance(fixture, 1);
    missile = self
      .units(UnitType.AtomBomb)
      .find((unit) => unit.targetTile() === targetTile);
  }
  assert.ok(
    missile,
    "Native execution launches an Atom Bomb toward the requested target",
  );
  advance(fixture, 1, [
    {
      type: "attack",
      targetID: null,
      troops: 10_000,
      clientID: self.clientID()!,
    },
  ]);
  for (
    let index = 0;
    index < 600 &&
    !world
      .allPlayers()
      .some((rival) => rival !== self && self.sharesBorderWith(rival));
    index++
  )
    advance(fixture, 1);
  const borderRivals = world
    .allPlayers()
    .filter(
      (rival) =>
        rival !== self && rival.isAlive() && self.sharesBorderWith(rival),
    );
  assert.ok(
    borderRivals.length > 0,
    "Native expansion reaches another player's border",
  );
  const bordered = projectDecisionObservation(
    builder.observe("visibility", self, 0, {}, []),
  );
  for (const rival of borderRivals) {
    const visible = bordered.rivals!.find(
      (visible) => visible.playerId === rival.id(),
    );
    assert.ok(visible?.sharesBorder);
    assert.equal(
      visible.availableActions.includes("attack"),
      self.canAttackPlayer(rival),
    );
  }
  assert.ok(
    bordered.rivals!.every(
      (rival) => !("gold" in rival) && !("troops" in rival),
    ),
  );

  const boats = await createGameRunner(
    {
      ...start,
      gameID: "boatCheck",
      config: {
        ...start.config,
        bots: 0,
        nations: "disabled",
        randomSpawn: false,
        startingGold: 1_000_000_000,
      },
      players: [
        { clientID: "boat0001", username: "Boat One", clanTag: null },
        { clientID: "boat0002", username: "Boat Two", clanTag: null },
      ],
    },
    undefined,
    new LocalMapLoader(),
    (update) => {
      if ("errMsg" in update) throw new Error(update.errMsg);
    },
  );
  const sea = boats.game;
  let shore = -1,
    inland = -1;
  for (let tile = 0; tile < sea.width() * sea.height(); tile++) {
    if (!sea.isLand(tile) || sea.isImpassable(tile)) continue;
    if (shore < 0 && sea.isShore(tile) && sea.x(tile) > 8 && sea.y(tile) > 8)
      shore = tile;
    if (
      shore >= 0 &&
      !sea.isShore(tile) &&
      sea.manhattanDist(shore, tile) > 400
    ) {
      inland = tile;
      break;
    }
  }
  assert.ok(shore >= 0 && inland >= 0);
  advance(boats, 203, [
    { type: "spawn", tile: shore, clientID: "boat0001" },
    { type: "spawn", tile: inland, clientID: "boat0002" },
  ]);
  const sailor = sea.playerByClientID("boat0001")!;
  const boatView = new ObservationBuilder(sea).observe(
    "boat",
    sailor,
    0,
    {},
    [],
  );
  const landing = boatView.map.boatTargets.find(
    (target) => target.ownerId === null,
  )!;
  assert.ok(
    landing,
    "Default observation exposes a reachable neutral coastal landing without rival shore targets",
  );
  assert.notEqual(sailor.canBuild(UnitType.TransportShip, landing.tile), false);
  assert.equal(
    sailor.unitCount(UnitType.Port),
    0,
    "Troop transports need no Port",
  );
  advance(boats, 1, [
    { type: "boat", dst: landing.tile, troops: 2_000, clientID: "boat0001" },
  ]);
  let launched = sailor.unitCount(UnitType.TransportShip) > 0;
  for (
    let index = 0;
    index < 800 && sea.ownerID(landing.tile) !== sailor.smallID();
    index++
  ) {
    advance(boats, 1);
    launched ||= sailor.unitCount(UnitType.TransportShip) > 0;
  }
  assert.ok(launched, "Native execution creates a troop transport");
  assert.equal(
    sea.ownerID(landing.tile),
    sailor.smallID(),
    "The transport lands and occupies the observed destination",
  );
  const water = sea.neighbors(landing.tile).find((tile) => sea.isWater(tile))!;
  const otherWater = sea.neighbors(water).find((tile) => sea.isWater(tile))!;
  assert.ok(water !== undefined && otherWater !== undefined);
  for (let index = 0; index < 33; index++)
    sailor.buildUnit(UnitType.Warship, water, { patrolTile: water });
  const laterShip = sailor.buildUnit(UnitType.Warship, otherWater, {
    patrolTile: otherWater,
  });
  const opponent = sea.playerByClientID("boat0002")!;
  const enemyCity = opponent.buildUnit(UnitType.City, inland, {});
  const enemyShip = opponent.buildUnit(UnitType.Warship, otherWater, {
    patrolTile: otherWater,
  });
  const regionalBuilder = new ObservationBuilder(sea);
  const defaultUnits = projectDecisionObservation(
    regionalBuilder.observe("boat", sailor, 0, {}, []),
  );
  assert.equal(defaultUnits.units!.length, 32);
  assert.ok(!defaultUnits.units!.some((unit) => unit.id === laterShip.id()));
  assert.equal(defaultUnits.publicStructures, undefined);
  const inspectShip = projectDecisionObservation(
    regionalBuilder.observe(
      "boat",
      sailor,
      0,
      {
        x: sea.x(otherWater),
        y: sea.y(otherWater),
        width: 1,
        height: 1,
        sections: ["units"],
      },
      [],
    ),
    ["units"],
  );
  assert.ok(
    inspectShip.units!.some((unit) => unit.id === laterShip.id()),
    "A regional query reaches an owned ship beyond the default unit limit",
  );
  assert.ok(
    !inspectShip.units!.some((unit) => unit.id === enemyShip.id()),
    "Foreign ships stay out of owned-unit observations",
  );
  const inspectCity = projectDecisionObservation(
    regionalBuilder.observe(
      "boat",
      sailor,
      0,
      {
        x: sea.x(inland),
        y: sea.y(inland),
        width: 1,
        height: 1,
        sections: ["units"],
      },
      [],
    ),
    ["units"],
  );
  assert.deepEqual(inspectCity.publicStructures, [
    {
      id: enemyCity.id(),
      type: UnitType.City,
      tile: inland,
      level: enemyCity.level(),
      ownerId: opponent.id(),
    },
  ]);
  return {
    nearest: initial.rivals,
    borderRivals: borderRivals.map((rival) => rival.id()),
    upgradeId: ownedCity.id(),
    nuclear: { id: missile.id(), targetTile },
    regionalUnits: {
      laterOwnedShipId: laterShip.id(),
      publicEnemyStructureId: enemyCity.id(),
      hiddenEnemyShipId: enemyShip.id(),
    },
    transport: { shore, landing, launched, occupied: true, tick: sea.ticks() },
  };
}

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
  const observationChecks = await nativeObservationCheck(start);
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
        observationChecks,
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
