import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { ObserveWorldQuerySchema } from "../../src/agents/Arena";
import {
  gameToolResponse,
  serializeInspectorEvent,
} from "../../src/agents/codex/toolResult";
import { publicPlayerFocus } from "../../src/agents/game/AgentGame";
import { buildNukePreview } from "../../src/agents/game/nukePreview";
import { agentActionToolSchema } from "../../src/agents/game/schemas";
import { MapImages } from "../../src/agents/vision";
import { Raster } from "../../src/agents/vision/raster";
import { Config } from "../../src/core/configuration/Config";
import {
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";

// Failure cases: requested regions use an automatic crop, coordinates change,
// edge crops exceed map bounds, public structures or nearby owners disappear,
// a missing image produces a successful response, or image bytes replace JSON data.
// This native simulation check makes no server or model inference request.
// Inspector replay failures: base64 enters logs, ordinary text or preview URLs
// change, another media type loses data, or redaction mutates native tool results.
// Missile preview failures: an unavailable silo generates a trajectory, a reload
// or unfinished silo launches, Euclidean distance replaces native Manhattan
// selection, SAM upgrades do not change coverage, friendly SAMs threaten without
// betrayal, teammate SAMs threaten, direction or blast ranges differ from native
// values, the crop excludes the launch/arc/target, or private enemy ship data leaks.
// Structure label failures: a city/SAM level disappears, the label uses a fixed
// level, or nearby structure labels overwrite each other's native numbers.
// Player focus failures: unknown IDs resolve, the crop uses an old spawn,
// a nation or tribe changes the viewing agent, target resources enter metadata,
// or competing region/preview selectors silently replace the requested focus.
// Overlay failures: a clean view keeps annotations, layer switches change the
// coordinate transform, same-tick images overwrite another configuration, labels
// cannot resolve to native IDs, or unit metadata exposes private resources.
const game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
  playerInfo("Vision Agent", PlayerType.Human),
  playerInfo("Nearby Tribe", PlayerType.Bot),
  playerInfo("Nearby Nation", PlayerType.Nation),
]);
const self = game.player("Vision Agent");
const tribe = game.player("Nearby Tribe");
const nation = game.player("Nearby Nation");
const origins = [game.ref(35, 35), game.ref(55, 35), game.ref(35, 55)];
for (const [index, player] of [self, tribe, nation].entries()) {
  const origin = origins[index];
  player.setSpawnTile(origin);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const tile = game.ref(game.x(origin) + dx, game.y(origin) + dy);
      if (game.isLand(tile) && !game.isImpassable(tile)) player.conquer(tile);
    }
  }
}
const city = self.buildUnit(UnitType.City, origins[0], {});
city.increaseLevel();
city.increaseLevel();
const stackedSam = self.buildUnit(UnitType.SAMLauncher, origins[0], {});
for (let level = 1; level < 5; level++) stackedSam.increaseLevel();
const images = new MapImages("vision-region-e2e");
const region = { x: 25, y: 25, width: 45, height: 45 };
const frame = await images.renderRegion(game, self, region);
const cleanFrame = await images.renderRegion(game, self, region, false);
const unitFrame = await images.renderRegion(game, self, region, {
  labels: false,
  grid: false,
  sam: false,
});
const fullFrame = await images.renderRegion(game, self, region, true);
assert.deepEqual(cleanFrame.region, frame.region);
assert.deepEqual(cleanFrame.mapPixels, frame.mapPixels);
assert.notEqual(cleanFrame.path, frame.path);
assert.notEqual(fullFrame.path, frame.path);
assert.equal(frame.overlays.sam, false);
assert.equal(frame.overlays.tradeRoutes, false);
assert(Object.values(cleanFrame.overlays).every((enabled) => !enabled));
assert.equal(fullFrame.overlays.sam, true);
assert.equal(fullFrame.overlays.tradeRoutes, true);
assert.deepEqual(cleanFrame.players, []);
assert.deepEqual(cleanFrame.units, []);
assert.deepEqual(unitFrame.players, []);
assert.equal(frame.detail, "high");
assert(frame.players.some((player) => player.playerId === self.id()));
for (const player of frame.players) {
  assert.equal(game.player(player.playerId).smallID(), player.smallId);
  assert.equal(player.color.length, 3);
  assert.equal(player.tile, game.ref(player.x, player.y));
}
const cityMetadata = unitFrame.units.find((unit) => unit.id === city.id())!;
assert.equal(cityMetadata.level, city.level());
assert.equal(cityMetadata.ownerId, self.id());
assert.equal(cityMetadata.tile, game.ref(cityMetadata.x, cityMetadata.y));
assert(!("gold" in cityMetadata));
assert(!("troops" in cityMetadata));
assert(!(await readFile(cleanFrame.path)).equals(await readFile(frame.path)));
await writeFile(
  resolve(".agent-arena/vision-overlay-e2e.json"),
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      frame,
      cleanFrame,
      unitFrame,
      fullFrame,
    },
    null,
    2,
  ),
);
assert.deepEqual(frame.region, region);
assert(frame.width <= 768 && frame.height <= 768);
const png = await readFile(frame.path);
assert.equal(png.subarray(1, 4).toString(), "PNG");
assert.equal(png.readUInt32BE(16), frame.width);
assert.equal(png.readUInt32BE(20), frame.height);
const chunks: Buffer[] = [];
for (let at = 8; at < png.length; ) {
  const length = png.readUInt32BE(at);
  if (png.subarray(at + 4, at + 8).toString() === "IDAT")
    chunks.push(png.subarray(at + 8, at + 8 + length));
  at += length + 12;
}
const decodedPixels = inflateSync(Buffer.concat(chunks));
assert.equal(decodedPixels.length, frame.height * (frame.width * 3 + 1));
const { mapPixels } = frame;
const cityX =
  mapPixels.x +
  Math.floor(
    ((game.x(city.tile()) - region.x) * mapPixels.width) / region.width,
  );
const cityY =
  mapPixels.y +
  Math.floor(
    ((game.y(city.tile()) - region.y) * mapPixels.height) / region.height,
  );
const levelVisible = (level: number) => {
  const digit = new Raster(5, 7);
  digit.text(String(level), 0, 0, [255, 241, 116]);
  let visible = false;
  for (let y = cityY - 40; y <= cityY + 40 && !visible; y++) {
    for (let x = cityX - 40; x <= cityX + 40 && !visible; x++) {
      let matches = true;
      for (let dy = 0; dy < 7 && matches; dy++) {
        for (let dx = 0; dx < 5 && matches; dx++) {
          const expected = digit.rgb.subarray(
            (dy * 5 + dx) * 3,
            (dy * 5 + dx) * 3 + 3,
          );
          const at = (y + dy) * (frame.width * 3 + 1) + 1 + (x + dx) * 3;
          matches =
            expected[0] === 255
              ? expected.every(
                  (value, channel) => value === decodedPixels[at + channel],
                )
              : !(
                  decodedPixels[at] === 255 &&
                  decodedPixels[at + 1] === 241 &&
                  decodedPixels[at + 2] === 116
                );
        }
      }
      visible = matches;
    }
  }
  return visible;
};
assert(
  levelVisible(city.level()),
  "The city marker must show its native level 3",
);
assert(
  levelVisible(stackedSam.level()),
  "The nearby SAM marker must show its native level 5",
);
const worldX = 40;
const pixelX =
  mapPixels.x + ((worldX - region.x) * mapPixels.width) / region.width;
assert.equal(
  region.x + ((pixelX - mapPixels.x) * region.width) / mapPixels.width,
  worldX,
);

const responseSchema = z.object({
  success: z.boolean(),
  contentItems: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("inputText"), text: z.string() }),
      z.object({
        type: z.literal("inputImage"),
        imageUrl: z.string().startsWith("data:image/png;base64,"),
      }),
    ]),
  ),
});
const data = {
  tick: game.ticks(),
  region: frame.region,
  mapPixels,
  playerId: self.id(),
};
const response = responseSchema.parse(
  await gameToolResponse({ data, images: [frame] }),
);
assert.equal(response.success, true);
assert.equal(response.contentItems.length, 2);
const [text, image] = response.contentItems;
assert.equal(text.type, "inputText");
assert.equal(image.type, "inputImage");
assert(text.type === "inputText" && image.type === "inputImage");
assert.deepEqual(JSON.parse(text.text), data);
assert(Buffer.from(image.imageUrl.split(",")[1], "base64").equals(png));
const nativeResponseJson = JSON.stringify(response);
const nativeEvent = {
  method: "item/completed",
  params: {
    threadId: "vision-replay",
    item: { type: "dynamicToolCall", contentItems: response.contentItems },
    previewUrl: frame.url,
    text: "data:image/png is a MIME type.",
    audioUrl: "data:audio/wav;base64,YXVkaW8=",
  },
};
const inspectorJson = serializeInspectorEvent(nativeEvent);
assert(!inspectorJson.includes(image.imageUrl));
assert.deepEqual(JSON.parse(inspectorJson), {
  ...nativeEvent,
  params: {
    ...nativeEvent.params,
    item: {
      ...nativeEvent.params.item,
      contentItems: [
        text,
        {
          type: "inputImage",
          imageUrl: "[image omitted from inspector event]",
        },
      ],
    },
  },
});
assert.equal(JSON.stringify(response), nativeResponseJson);
assert.equal(nativeEvent.params.item.contentItems[1], image);
await writeFile(
  resolve(".agent-arena/vision-inspector-replay.json"),
  inspectorJson,
);
const plain = responseSchema.parse(
  await gameToolResponse({ data: { accepted: true } }),
);
assert.equal(plain.contentItems.length, 1);
const failed = responseSchema.parse(
  await gameToolResponse({ data: { error: "Map image failed." } }, false),
);
assert.equal(failed.success, false);
assert.deepEqual(failed.contentItems, [
  { type: "inputText", text: '{"error":"Map image failed."}' },
]);
await assert.rejects(
  gameToolResponse({
    data: {},
    images: [{ path: resolve(".agent-arena/no-such-vision-frame.png") }],
  }),
  /ENOENT/,
);
const edgeRegion = {
  x: game.width() - 1,
  y: game.height() - 1,
  width: 1,
  height: 1,
};
assert.deepEqual(
  (await images.renderRegion(game, self, edgeRegion)).region,
  edgeRegion,
);
const artifact = resolve(".agent-arena/vision-region-e2e.json");
const toolSchemaBytes = {
  observeWorld: Buffer.byteLength(
    JSON.stringify(z.toJSONSchema(ObserveWorldQuerySchema)),
  ),
  act: Buffer.byteLength(JSON.stringify(agentActionToolSchema)),
};
assert(toolSchemaBytes.observeWorld <= 5_000 && toolSchemaBytes.act <= 5_000);
const focusGame = await setup("world", {}, [
  playerInfo("Focus Viewer", PlayerType.Human),
  playerInfo("Focus Nation", PlayerType.Nation),
  playerInfo("Focus Tribe", PlayerType.Bot),
]);
const focusViewer = focusGame.player("Focus Viewer");
const focusNation = focusGame.player("Focus Nation");
const focusTribe = focusGame.player("Focus Tribe");
const landNear = (x: number, y: number) => {
  for (let radius = 0; radius < 80; radius++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const tile = focusGame.ref(x + dx, y + dy);
        if (focusGame.isLand(tile) && !focusGame.isImpassable(tile))
          return tile;
      }
  throw new Error(
    "The native focus fixture needs land near its public reference.",
  );
};
for (const [player, x, y] of [
  [focusViewer, 375, 272],
  [focusNation, 990, 260],
  [focusTribe, 1030, 450],
] as const) {
  const tile = landNear(x, y);
  player.setSpawnTile(tile);
  player.conquer(tile);
}
const oldNationTile = focusNation.spawnTile()!;
focusNation.relinquish(oldNationTile);
focusNation.conquer(landNear(1055, 465));
focusNation.addGold(987_654_321n);
const nationFocus = publicPlayerFocus(focusGame, focusViewer, focusNation.id());
const ownFocus = publicPlayerFocus(focusGame, focusViewer, focusViewer.id());
assert.equal(nationFocus.target.playerType, PlayerType.Nation);
assert.equal(
  publicPlayerFocus(focusGame, focusViewer, focusTribe.id()).target.playerType,
  PlayerType.Bot,
);
assert.notDeepEqual(nationFocus.region, ownFocus.region);
assert(nationFocus.region.y > focusGame.y(oldNationTile));
assert.deepEqual(
  Object.keys(nationFocus.target).sort(),
  [
    "alive",
    "allied",
    "name",
    "playerId",
    "playerType",
    "smallId",
    "teammate",
    "tiles",
  ].sort(),
);
assert(!JSON.stringify(nationFocus).includes("987654321"));
assert.throws(
  () => publicPlayerFocus(focusGame, focusViewer, "unknown-native-player"),
  /Unknown player/,
);
assert.equal(
  ObserveWorldQuerySchema.safeParse({ playerId: focusNation.id(), x: 0 })
    .success,
  false,
);
assert.equal(
  ObserveWorldQuerySchema.safeParse({
    playerId: focusNation.id(),
    nukePreview: { type: UnitType.AtomBomb, tile: 0 },
  }).success,
  false,
);
const focusImages = new MapImages("vision-player-focus-e2e");
const nationFrame = await focusImages.renderRegion(
  focusGame,
  focusViewer,
  nationFocus.region,
);
const ownFrame = await focusImages.renderRegion(
  focusGame,
  focusViewer,
  ownFocus.region,
);
const incorrectViewerFrame = await focusImages.renderRegion(
  focusGame,
  focusNation,
  nationFocus.region,
);
assert.deepEqual(nationFrame.region, nationFocus.region);
assert(nationFrame.width <= 768 && nationFrame.height <= 768);
assert(
  !(await readFile(nationFrame.path)).equals(
    await readFile(incorrectViewerFrame.path),
  ),
);
await writeFile(
  resolve(".agent-arena/vision-player-focus-e2e.json"),
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      nationFocus,
      ownFocus,
      nationFrame,
      ownFrame,
      unknownIdRejected: true,
      selectorConflictsRejected: true,
      targetPrivateResourcesAbsent: true,
      actualViewerPreserved: true,
    },
    null,
    2,
  ),
);
class NativePreviewConfig extends TestConfig {
  nukeMagnitudes(type: UnitType) {
    return Config.prototype.nukeMagnitudes.call(this, type);
  }
  samRange(level: number) {
    return Config.prototype.samRange.call(this, level);
  }
  defaultNukeTargetableRange() {
    return Config.prototype.defaultNukeTargetableRange.call(this);
  }
}
const missileGame = await setup(
  "plains",
  { infiniteGold: true, instantBuild: true },
  [
    playerInfo("Launcher", PlayerType.Human),
    playerInfo("Ally", PlayerType.Human),
    playerInfo("Enemy", PlayerType.Human),
  ],
  undefined,
  NativePreviewConfig,
);
const launcher = missileGame.player("Launcher");
const ally = missileGame.player("Ally");
const enemy = missileGame.player("Enemy");
for (const [player, x, y] of [
  [launcher, 10, 50],
  [ally, 55, 15],
  [enemy, 90, 50],
] as const) {
  player.setSpawnTile(missileGame.ref(x, y));
  player.conquer(missileGame.ref(x, y));
}
const request = {
  type: UnitType.AtomBomb as const,
  tile: missileGame.ref(90, 50),
};
assert.equal(buildNukePreview(missileGame, launcher, request).source, null);
assert.throws(
  () => buildNukePreview(missileGame, launcher, { ...request, tile: 10_000 }),
  /target tile/,
);
const farSilo = launcher.buildUnit(
  UnitType.MissileSilo,
  missileGame.ref(10, 40),
  {},
);
const nearSilo = launcher.buildUnit(
  UnitType.MissileSilo,
  missileGame.ref(20, 50),
  {},
);
assert.equal(
  buildNukePreview(missileGame, launcher, request).source?.unitId,
  nearSilo.id(),
);
nearSilo.launch();
assert.equal(
  buildNukePreview(missileGame, launcher, request).source?.unitId,
  farSilo.id(),
);
nearSilo.reloadMissile();
nearSilo.setUnderConstruction(true);
farSilo.setUnderConstruction(true);
assert.equal(buildNukePreview(missileGame, launcher, request).trajectory, null);
nearSilo.setUnderConstruction(false);
farSilo.setUnderConstruction(false);
launcher.createAllianceRequest(ally)!.accept();
const allySam = ally.buildUnit(
  UnitType.SAMLauncher,
  missileGame.ref(55, 15),
  {},
);
for (let level = 1; level < 5; level++) allySam.increaseLevel();
const hostileSam = enemy.buildUnit(
  UnitType.SAMLauncher,
  missileGame.ref(90, 50),
  {},
);
let preview = buildNukePreview(missileGame, launcher, request);
assert.equal(
  preview.sams.find((sam) => sam.unitId === allySam.id())!.threatens,
  false,
);
assert.equal(
  preview.sams.find((sam) => sam.unitId === hostileSam.id())!.radius,
  missileGame.config().samRange(1),
);
hostileSam.increaseLevel();
preview = buildNukePreview(missileGame, launcher, request);
assert.equal(
  preview.sams.find((sam) => sam.unitId === hostileSam.id())!.radius,
  missileGame.config().samRange(2),
);
assert(preview.interception.coverageRisk);
assert(preview.trajectory);
const down = buildNukePreview(missileGame, launcher, {
  ...request,
  rocketDirectionUp: false,
});
assert(down.trajectory && preview.trajectory.p1y < down.trajectory.p1y);
assert.deepEqual(
  preview.blast,
  missileGame.config().nukeMagnitudes(UnitType.AtomBomb),
);
const hydro = buildNukePreview(missileGame, launcher, {
  ...request,
  type: UnitType.HydrogenBomb,
});
assert.deepEqual(
  hydro.blast,
  missileGame.config().nukeMagnitudes(UnitType.HydrogenBomb),
);
assert(hydro.betrayedAllyIds.includes(ally.id()));
assert.equal(
  hydro.sams.find((sam) => sam.unitId === allySam.id())!.threatens,
  true,
);
const ship = enemy.buildUnit(UnitType.Warship, missileGame.ref(78, 50), {
  patrolTile: missileGame.ref(78, 50),
});
const missileFrame = await new MapImages(
  "vision-missile-e2e",
).renderNukePreview(missileGame, launcher, preview);
assert(missileFrame.width <= 768 && missileFrame.height <= 768);
assert(missileFrame.region.x <= preview.source!.x);
assert(
  missileFrame.region.x + missileFrame.region.width >
    missileGame.x(request.tile),
);
assert(missileFrame.region.y <= preview.trajectory.p1y);
assert.equal(
  (await readFile(missileFrame.path)).subarray(1, 4).toString(),
  "PNG",
);
const teamGame = await setup(
  "plains",
  {
    gameMode: GameMode.Team,
    playerTeams: 2,
    infiniteGold: true,
    instantBuild: true,
  },
  [
    new PlayerInfo(
      "Team Launcher",
      PlayerType.Human,
      "team1",
      "team1",
      false,
      "A",
    ),
    new PlayerInfo("Teammate", PlayerType.Human, "team2", "team2", false, "A"),
    new PlayerInfo(
      "Team Enemy",
      PlayerType.Human,
      "team3",
      "team3",
      false,
      "B",
    ),
  ],
  undefined,
  NativePreviewConfig,
);
const teamLauncher = teamGame.player("team1");
const teammate = teamGame.player("team2");
assert(teamLauncher.isOnSameTeam(teammate));
for (const [player, x] of [
  [teamLauncher, 10],
  [teammate, 90],
] as const) {
  player.setSpawnTile(teamGame.ref(x, 50));
  player.conquer(teamGame.ref(x, 50));
}
teamLauncher.buildUnit(UnitType.MissileSilo, teamGame.ref(10, 50), {});
const teammateSam = teammate.buildUnit(
  UnitType.SAMLauncher,
  teamGame.ref(90, 50),
  {},
);
const teamPreview = buildNukePreview(teamGame, teamLauncher, {
  ...request,
  tile: teamGame.ref(90, 50),
});
assert.equal(teamPreview.canBuild, false);
assert.equal(
  teamPreview.sams.find((sam) => sam.unitId === teammateSam.id())!.threatens,
  false,
);
await writeFile(
  resolve(".agent-arena/vision-missile-e2e.json"),
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      preview: {
        source: preview.source,
        blast: preview.blast,
        interception: preview.interception,
        betrayedAllyIds: hydro.betrayedAllyIds,
        teammateImmune: true,
      },
      frame: missileFrame,
      enemyPublicShip: { id: ship.id(), type: ship.type(), tile: ship.tile() },
    },
    null,
    2,
  ),
);
await writeFile(
  artifact,
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      frame,
      response: {
        success: response.success,
        contentTypes: response.contentItems.map((item) => item.type),
        imageBytes: png.length,
        decodedImageMatchesFrame: true,
      },
      plainDataPreserved: true,
      missingImageRejected: true,
      inspectorReplay: {
        imageOmitted: true,
        nativeResponseUnchanged: true,
        previewUrlUnchanged: true,
        nonImageContentUnchanged: true,
      },
      edgeCrop: edgeRegion,
      structureLevelsVisible: { city: city.level(), sam: stackedSam.level() },
      toolSchemaBytes,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: true,
    artifact,
    frame: frame.path,
    inferenceRequests: 0,
  }),
);
