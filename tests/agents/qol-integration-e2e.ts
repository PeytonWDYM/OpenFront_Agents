// Failure cases: own-land nuclear hints, 32 trade ships hiding owned defenses,
// wrong cancellation IDs reaching the socket, heatmaps missing data or PNGs,
// incompatible image selectors, lost bomb previews, and oversized tool schemas.
// Public neutral-target launches and empty detonations must reach bridge history
// exactly once through the native UnitUpdate lifecycle.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import {
  Arena,
  ObserveWorldQuerySchema,
  ThinkQuerySchema,
} from "../../src/agents/Arena";
import type { GameToolResult } from "../../src/agents/codex/index";
import { validateToolSchemas } from "../../src/agents/codex/toolSchema";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { LocalMapLoader } from "../../src/agents/game/LocalMapLoader";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { agentActionToolSchema } from "../../src/agents/game/schemas";
import { MapImages } from "../../src/agents/vision";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nukes,
  UnitType,
} from "../../src/core/game/Game";
import type { GameUpdateViewData } from "../../src/core/game/GameUpdates";
import { createGameRunner } from "../../src/core/GameRunner";
import type { ClientMessage } from "../../src/core/Schemas";

let mirrorUpdate: ((update: GameUpdateViewData) => void) | undefined;
const runner = await createGameRunner(
  {
    gameID: "agentQolIntegrationE2E",
    lobbyCreatedAt: 0,
    config: {
      gameMap: GameMapType.Europe,
      gameMapSize: GameMapSize.Compact,
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: Difficulty.Medium,
      bots: 0,
      nations: "disabled",
      randomSpawn: false,
      startingGold: 1_000_000_000,
      donateGold: true,
      donateTroops: true,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: true,
      spawnImmunityDuration: 0,
    },
    players: [
      { clientID: "qol001", username: "QOL One", clanTag: null },
      { clientID: "qol002", username: "QOL Two", clanTag: null },
    ],
  },
  undefined,
  new LocalMapLoader(),
  (update) => {
    if ("errMsg" in update) throw new Error(update.errMsg);
    mirrorUpdate?.(update);
  },
);
const game = runner.game;
const coasts: number[] = [];
for (let tile = 0; tile < game.width() * game.height(); tile++)
  if (game.isLand(tile) && game.isShore(tile) && !game.isImpassable(tile))
    coasts.push(tile);
const home = coasts[0];
const water = game.neighbors(home).find((tile) => game.isWater(tile))!;
const otherHome = coasts.find((tile) => game.manhattanDist(home, tile) > 400)!;
assert.ok(otherHome !== undefined);
for (let index = 0; index < 203; index++) {
  runner.addTurn({
    turnNumber: game.ticks(),
    intents:
      index === 0
        ? [
            { type: "spawn", tile: home, clientID: "qol001" },
            { type: "spawn", tile: otherHome, clientID: "qol002" },
          ]
        : [],
  });
  assert.ok(runner.executeNextTick());
}
const self = game.playerByClientID("qol001")!;
const other = game.playerByClientID("qol002")!;
const otherPort = other.buildUnit(UnitType.Port, otherHome, {});
for (let index = 0; index < 40; index++)
  self.buildUnit(UnitType.TradeShip, water, { targetUnit: otherPort });
const port = self.buildUnit(UnitType.Port, home, {});
const silo = self.buildUnit(UnitType.MissileSilo, home, {});
const sam = self.buildUnit(UnitType.SAMLauncher, home, {});
const warship = self.buildUnit(UnitType.Warship, water, { patrolTile: water });
sam.launch();
const builder = new ObservationBuilder(game);
const sent: ClientMessage[] = [];
const bridge = new AgentGame({ agentCount: 1, tribeCount: 0, nationCount: 0 });
Reflect.set(bridge, "runner", runner);
Reflect.set(bridge, "observations", builder);
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(bridge, "gameId_", "agentQolIntegrationE2E");
Reflect.set(bridge, "mapImages", new MapImages("agentQolIntegrationE2E"));
Reflect.set(bridge, "histories", new Map([["agent001", []]]));
Reflect.set(
  bridge,
  "nuclearHistories",
  new Map([
    ["agent001", { launched: new Set<number>(), impacted: new Set<number>() }],
  ]),
);
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
Reflect.set(bridge, "seats", [
  {
    id: "agent001",
    clientId: "qol001",
    name: "QOL One",
    send: (message: ClientMessage) => sent.push(message),
  },
]);
const arena = new Arena();
Reflect.set(arena, "game", bridge);
Reflect.set(arena, "state", {
  ...arena.snapshot(),
  phase: "running",
  gameId: bridge.gameId,
  players: [
    {
      id: "agent001",
      clientId: "qol001",
      name: "QOL One",
      alive: true,
      threadId: null,
      tokens: 0,
      decisions: 0,
      status: "ready",
    },
  ],
});
const tool: (
  id: string,
  name: string,
  args: unknown,
) => Promise<GameToolResult> = Reflect.get(arena, "tool").bind(arena);
const artifact: Record<string, unknown> = { seed: "agentQolIntegrationE2E" };
try {
  const observation = bridge.observe("agent001");
  for (const unit of [port, silo, sam, warship])
    assert.ok(
      observation.self.units.some((row) => row.id === unit.id()),
      `Trade ships must not hide ${unit.type()}`,
    );
  assert.ok(observation.self.units.length <= 32);
  assert.ok(
    !observation.map.buildSites.some(
      (site) =>
        Nukes.has(site.type as UnitType) &&
        game.ownerID(site.tile) === self.smallID(),
    ),
  );
  const decision = z
    .object({
      militaryIntel: z.unknown(),
      unitSummary: z.object({ total: z.number(), omitted: z.number() }),
    })
    .parse(bridge.decisionObservation("agent001"));
  assert.equal(decision.unitSummary.total, self.units().length);
  assert.ok(decision.unitSummary.omitted >= 12);
  artifact.decision = decision;
  for (const intent of [
    { type: "cancel_attack", attackID: "missing" },
    { type: "cancel_boat", unitID: warship.id() },
    { type: "move_warship", unitIds: [port.id()], tile: water },
    { type: "delete_unit", unitId: 999999 },
    { type: "build_unit", unit: UnitType.TradeShip, tile: water },
    { type: "build_unit", unit: UnitType.Train, tile: home },
  ])
    await assert.rejects(bridge.act("agent001", intent));
  assert.equal(sent.length, 0);
  assert.equal(
    ObserveWorldQuerySchema.safeParse({
      tradeHeatmap: true,
      nukePreview: { type: UnitType.AtomBomb, tile: otherHome },
    }).success,
    false,
  );
  assert.equal(
    ObserveWorldQuerySchema.safeParse({
      tradeHeatmap: true,
      playerId: other.id(),
    }).success,
    true,
  );
  const heatmap = await tool("agent001", "observe_world", {
    tradeHeatmap: true,
  });
  assert.ok(
    heatmap.images?.length === 1,
    "Heatmap requests always return their image",
  );
  const heatmapData = z
    .object({
      tradeHeatmap: z.unknown(),
      image: z.object({ mapPixels: z.unknown(), region: z.unknown() }),
    })
    .parse(heatmap.data);
  const heatPng = await readFile(heatmap.images[0].path);
  assert.deepEqual(
    [...heatPng.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  artifact.heatmap = heatmapData;
  const cleanHeatmap = await tool("agent001", "observe_world", {
    tradeHeatmap: true,
    overlays: false,
    resolution: "standard",
  });
  const cleanFrame = cleanHeatmap.images![0];
  const cleanData = z
    .object({
      image: z.object({
        width: z.number(),
        mapPixels: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      }),
      tradeHeatmap: z.object({
        warships: z.array(z.unknown()),
        traffic: z.object({ total: z.number() }),
      }),
    })
    .parse(cleanHeatmap.data);
  assert.equal(
    cleanData.tradeHeatmap.warships.length,
    1,
    "Layer choices retain public data",
  );
  assert.equal(cleanData.tradeHeatmap.traffic.total, 40);
  const cleanPng = await readFile(cleanFrame.path);
  const imageChunks: Buffer[] = [];
  for (let offset = 8; offset < cleanPng.length; ) {
    const length = cleanPng.readUInt32BE(offset);
    if (cleanPng.toString("ascii", offset + 4, offset + 8) === "IDAT")
      imageChunks.push(cleanPng.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(imageChunks));
  const { width: cleanWidth, mapPixels: cleanMapPixels } = cleanData.image;
  let ownWarshipPixels = 0;
  for (
    let y = cleanMapPixels.y;
    y < cleanMapPixels.y + cleanMapPixels.height;
    y++
  )
    for (
      let x = cleanMapPixels.x;
      x < cleanMapPixels.x + cleanMapPixels.width;
      x++
    ) {
      const offset = y * (cleanWidth * 3 + 1) + 1 + x * 3;
      if (
        pixels[offset] === 114 &&
        pixels[offset + 1] === 244 &&
        pixels[offset + 2] === 154
      )
        ownWarshipPixels++;
    }
  assert.equal(
    ownWarshipPixels,
    0,
    "overlays:false hides heatmap Warship rings and icons",
  );
  artifact.cleanHeatmap = {
    data: cleanData,
    path: cleanFrame.path,
    ownWarshipPixels,
  };
  const sites = bridge.observe("agent001", { buildType: UnitType.Warship }).map
    .buildSites;
  assert.ok(sites.length > 0);
  for (const site of sites) {
    assert.ok(game.isWater(site.tile));
    assert.notEqual(self.canBuild(UnitType.Warship, site.tile), false);
  }
  artifact.warshipSites = sites;
  for (const type of [UnitType.AtomBomb, UnitType.HydrogenBomb] as const) {
    const preview = await tool("agent001", "observe_world", {
      nukePreview: { type, tile: otherHome },
    });
    assert.equal(preview.images?.length, 1);
    const metadata = z
      .object({
        nukePreview: z.object({
          type: z.string(),
          cost: z.number(),
          readySilos: z.unknown(),
          sams: z.array(z.unknown()),
        }),
      })
      .parse(preview.data);
    assert.equal(metadata.nukePreview.type, type);
    artifact[type] = metadata;
  }
  validateToolSchemas([
    {
      name: "observe_world",
      description: "Observe",
      inputSchema: z.toJSONSchema(ObserveWorldQuerySchema),
    },
    {
      name: "think",
      description: "Think",
      inputSchema: z.toJSONSchema(ThinkQuerySchema),
    },
    { name: "act", description: "Act", inputSchema: agentActionToolSchema },
  ]);
  const receipt = await bridge.act("agent001", {
    type: "move_warship",
    unitIds: [warship.id()],
    tile: water,
  });
  assert.equal(
    z
      .object({
        status: z.literal("submitted"),
        execution: z.literal("pending execution"),
      })
      .parse(receipt).status,
    "submitted",
  );
  assert.equal(sent.length, 1);
  artifact.receipt = receipt;
  const emptyTarget = Array.from(
    { length: game.width() * game.height() },
    (_, tile) => tile,
  ).find(
    (tile) =>
      game.isWater(tile) &&
      !game.isImpassable(tile) &&
      game.manhattanDist(home, tile) > 150 &&
      game.manhattanDist(home, tile) < 250,
  )!;
  assert.ok(emptyTarget !== undefined);
  const launch = new NukeExecution(UnitType.AtomBomb, self, emptyTarget, null);
  game.addExecution(launch);
  mirrorUpdate = Reflect.get(bridge, "update").bind(bridge);
  for (let index = 0; index < 200; index++) {
    runner.addTurn({ turnNumber: game.ticks(), intents: [] });
    assert.ok(runner.executeNextTick());
  }
  const missileId = launch.getNuke()!.id();
  const lifecycle = bridge
    .observe("agent001", { sections: ["events"] })
    .events.filter((event) => event.data.unitId === missileId);
  assert.equal(
    lifecycle.filter((event) => event.type === "global_nuke_launch").length,
    1,
  );
  assert.equal(
    lifecycle.filter((event) => event.type === "global_nuke_impact").length,
    1,
  );
  assert.ok(
    !lifecycle.some(
      (event) => event.type === "nuke_incoming" || event.type === "nuke_impact",
    ),
  );
  artifact.emptyTargetLifecycle = lifecycle;
  console.log(
    "PASS native QOL integration: unit priority, hints, guard, heatmap PNG, bomb previews, schemas",
  );
} finally {
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/qol-integration-e2e.json",
    JSON.stringify(artifact, null, 2),
  );
}
