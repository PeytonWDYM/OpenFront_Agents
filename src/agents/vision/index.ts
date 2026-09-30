import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Game, Player, PlayerType, UnitType } from "../../core/game/Game";
import { NukePreview, samCoverage, trajectoryPoint } from "../game/nukePreview";
import { drawUnitMarkers, TradeTrafficMarker } from "./markers";
import { PlayerMarker, publicUnitMarkers } from "./metadata";
import {
  overlayKey,
  resolveOverlays,
  VisionLayers,
  VisionOverlays,
} from "./options";
import { encodePng } from "./png";
import { Color, Raster, Region } from "./raster";
export type { Region } from "./raster";

export type MapImage = {
  path: string;
  url: string;
  width: number;
  height: number;
  region: Region;
  mapPixels: Region;
  tradeTraffic?: TradeTrafficMarker[];
  detail: "high";
  overlays: VisionLayers;
  players: PlayerMarker[];
  units: ReturnType<typeof publicUnitMarkers>["units"];
  unitCount: number;
};
export type MapVision = {
  tick: number;
  overview: MapImage;
  tactical?: MapImage;
};
type Frame = {
  raster: Raster;
  region: Region;
  mapPixels: Region;
  tradeTraffic?: TradeTrafficMarker[];
  overlays: VisionLayers;
  players: PlayerMarker[];
  units: ReturnType<typeof publicUnitMarkers>["units"];
  unitCount: number;
};

const terrainColors: Color[] = Array.from({ length: 256 }, (_, terrain) => {
  const magnitude = terrain & 31;
  if (terrain & 128) {
    if (magnitude === 31) return [15, 23, 34];
    return [143 - magnitude * 2, 151 - magnitude * 2, 117 - magnitude * 2];
  }
  return terrain & 32 ? [35, 68, 91] : [49, 91, 116];
});

/** Stable colors identify the same public owner in every frame. */
function ownerColor(id: number): Color {
  const hue = ((id * 0.61803398875) % 1) * 6;
  const x = Math.round(150 * (1 - Math.abs((hue % 2) - 1)));
  const rgb: Color =
    hue < 1
      ? [150, x, 0]
      : hue < 2
        ? [x, 150, 0]
        : hue < 3
          ? [0, 150, x]
          : hue < 4
            ? [0, x, 150]
            : hue < 5
              ? [x, 0, 150]
              : [150, 0, x];
  return [rgb[0] + 72, rgb[1] + 72, rgb[2] + 72];
}

export function playerTerritoryRegion(
  game: Game,
  player: Player,
): Region | undefined {
  if (player.numTilesOwned() === 0) return;
  let minX = game.width(),
    minY = game.height(),
    maxX = 0,
    maxY = 0;
  for (const tile of player.tiles()) {
    const x = game.x(tile),
      y = game.y(tile);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = Math.min(game.width(), Math.max(160, maxX - minX + 65));
  const height = Math.min(game.height(), Math.max(160, maxY - minY + 65));
  return {
    x: Math.max(
      0,
      Math.min(game.width() - width, Math.floor((minX + maxX - width) / 2)),
    ),
    y: Math.max(
      0,
      Math.min(game.height() - height, Math.floor((minY + maxY - height) / 2)),
    ),
    width,
    height,
  };
}

function draw(
  game: Game,
  region: Region,
  limit: number,
  title: string,
  self?: Player,
  preview?: NukePreview,
  overlays = resolveOverlays(),
): Frame {
  const footer = preview ? 88 : 66;
  const scale = Math.min(
    (limit - 44) / region.width,
    (limit - footer) / region.height,
  );
  const mapPixels = {
    x: 36,
    y: 24,
    width: Math.max(1, Math.floor(region.width * scale)),
    height: Math.max(1, Math.floor(region.height * scale)),
  };
  const raster = new Raster(
    Math.max(300, mapPixels.width + 44),
    mapPixels.height + footer,
  );
  raster.text(title, 8, 7);
  const colors = new Map(
    game
      .allPlayers()
      .map((player) => [player.smallID(), ownerColor(player.smallID())]),
  );
  const centers = new Map<number, { x: number; y: number; count: number }>();
  const friends = new Set(
    self
      ? game
          .allPlayers()
          .filter((player) => self.isFriendly(player))
          .map((player) => player.smallID())
      : [],
  );
  for (let py = 0; py < mapPixels.height; py++) {
    const y =
      region.y + Math.floor(((py + 0.5) * region.height) / mapPixels.height);
    for (let px = 0; px < mapPixels.width; px++) {
      const x =
        region.x + Math.floor(((px + 0.5) * region.width) / mapPixels.width);
      const tile = game.ref(x, y);
      const terrain = game.terrainByte(tile);
      const owner = game.ownerID(tile);
      let color = terrainColors[terrain];
      if (owner !== 0) {
        const base = colors.get(owner)!;
        const shade = 1 - (terrain & 31) / 100;
        color = [base[0] * shade, base[1] * shade, base[2] * shade];
        const center = centers.get(owner) ?? { x: 0, y: 0, count: 0 };
        center.x += px;
        center.y += py;
        center.count++;
        centers.set(owner, center);
      }
      if (game.hasFallout(tile)) color = [130, 110, 57];
      raster.pixel(mapPixels.x + px, mapPixels.y + py, color);
      if (
        overlays.labels &&
        self &&
        owner !== 0 &&
        (owner === self.smallID() || friends.has(owner)) &&
        (game.isBorder(tile) || (px % 14 === 0 && py % 14 === 0))
      )
        raster.pixel(
          mapPixels.x + px,
          mapPixels.y + py,
          owner === self.smallID() ? [255, 241, 116] : [100, 223, 246],
        );
    }
  }
  // Axes use world coordinates. Grid lines do not change the world-to-pixel transform.
  for (let line = 0; line <= 4; line++) {
    const px = Math.min(
      mapPixels.width - 1,
      Math.floor((line * mapPixels.width) / 4),
    );
    const py = Math.min(
      mapPixels.height - 1,
      Math.floor((line * mapPixels.height) / 4),
    );
    for (let y = 0; overlays.grid && y < mapPixels.height; y += 3)
      raster.pixel(mapPixels.x + px, mapPixels.y + y, [160, 175, 183]);
    for (let x = 0; overlays.grid && x < mapPixels.width; x += 3)
      raster.pixel(mapPixels.x + x, mapPixels.y + py, [160, 175, 183]);
    raster.text(
      String(
        region.x +
          Math.min(region.width - 1, Math.floor((line * region.width) / 4)),
      ),
      Math.min(raster.width - 30, mapPixels.x + px),
      mapPixels.y + mapPixels.height + 5,
    );
    raster.text(
      String(
        region.y +
          Math.min(region.height - 1, Math.floor((line * region.height) / 4)),
      ),
      1,
      mapPixels.y + py,
    );
  }
  const position = (tile: number) => ({
    x:
      mapPixels.x +
      Math.floor(((game.x(tile) - region.x) * mapPixels.width) / region.width),
    y:
      mapPixels.y +
      Math.floor(
        ((game.y(tile) - region.y) * mapPixels.height) / region.height,
      ),
  });
  const inside = (tile: number) =>
    game.x(tile) >= region.x &&
    game.x(tile) < region.x + region.width &&
    game.y(tile) >= region.y &&
    game.y(tile) < region.y + region.height;
  const worldPoint = (x: number, y: number) => ({
    x: mapPixels.x + ((x - region.x) * mapPixels.width) / region.width,
    y: mapPixels.y + ((y - region.y) * mapPixels.height) / region.height,
  });
  const circle = (x: number, y: number, radius: number, color: Color) => {
    const point = worldPoint(x, y);
    raster.ellipse(
      point.x,
      point.y,
      (radius * mapPixels.width) / region.width,
      (radius * mapPixels.height) / region.height,
      color,
      mapPixels,
    );
  };
  if (self && (overlays.sam || preview))
    for (const sam of preview?.sams ?? samCoverage(game, self))
      circle(
        sam.x,
        sam.y,
        sam.radius,
        sam.own
          ? [91, 221, 139]
          : sam.threatens
            ? [239, 104, 99]
            : [100, 223, 246],
      );
  const occupied: Region[] = [];
  const distance = (player: Player) => {
    const center = centers.get(player.smallID());
    const spawn = player.spawnTile();
    const point = center
      ? {
          x: mapPixels.x + center.x / center.count,
          y: mapPixels.y + center.y / center.count,
        }
      : spawn !== undefined && inside(spawn)
        ? position(spawn)
        : undefined;
    return point
      ? (point.x - mapPixels.x - mapPixels.width / 2) ** 2 +
          (point.y - mapPixels.y - mapPixels.height / 2) ** 2
      : Infinity;
  };
  const priority = (player: Player) =>
    self
      ? player === self
        ? -1
        : distance(player)
      : player.type() === PlayerType.Human
        ? 1
        : player.type() === PlayerType.Nation
          ? 2
          : 3;
  const players = [...game.allPlayers()].sort(
    (a, b) => priority(a) - priority(b) || a.smallID() - b.smallID(),
  );
  const playerMarkers: PlayerMarker[] = [];
  for (const player of players) {
    if (!overlays.labels) break;
    if (occupied.length >= 24) break;
    const center = centers.get(player.smallID());
    const spawn = player.spawnTile();
    if (!center && (spawn === undefined || !inside(spawn) || !player.isAlive()))
      continue;
    const point = center
      ? {
          x: mapPixels.x + center.x / center.count,
          y: mapPixels.y + center.y / center.count,
        }
      : position(spawn!);
    const type =
      player.type() === PlayerType.Human
        ? "H"
        : player.type() === PlayerType.Nation
          ? "N"
          : "T";
    const label = `${player === self ? "YOU " : self?.isOnSameTeam(player) ? "TEAM " : self?.isAlliedWith(player) ? "ALLY " : ""}${type}${player.smallID()}`;
    const box = {
      x: Math.max(
        mapPixels.x,
        Math.min(
          mapPixels.x + mapPixels.width - label.length * 6 - 4,
          Math.floor(point.x - label.length * 3),
        ),
      ),
      y: Math.max(
        mapPixels.y,
        Math.min(mapPixels.y + mapPixels.height - 11, Math.floor(point.y)),
      ),
      width: label.length * 6 + 4,
      height: 11,
    };
    if (
      occupied.some(
        (other) =>
          box.x < other.x + other.width &&
          box.x + box.width > other.x &&
          box.y < other.y + other.height &&
          box.y + box.height > other.y,
      )
    )
      continue;
    if (box.width > mapPixels.width || box.height > mapPixels.height) continue;
    raster.fill(box.x, box.y, box.width, box.height, [18, 26, 35]);
    raster.text(
      label,
      box.x + 2,
      box.y + 2,
      player === self ? [255, 241, 116] : [242, 247, 252],
    );
    occupied.push(box);
    // Include a public owned tile because a centroid can lie outside territory.
    let tile: number | undefined;
    for (const owned of player.tiles()) {
      if (inside(owned)) {
        tile = owned;
        break;
      }
    }
    if (tile !== undefined)
      playerMarkers.push({
        label,
        playerId: player.id(),
        smallId: player.smallID(),
        color: colors.get(player.smallID())!,
        tile,
        x: game.x(tile),
        y: game.y(tile),
      });
  }
  const tradeTraffic =
    overlays.units || overlays.tradeRoutes
      ? drawUnitMarkers(
          game,
          raster,
          region,
          mapPixels,
          occupied,
          self,
          overlays.tradeRoutes,
          overlays.units,
        )
      : [];
  if (self && overlays.labels)
    raster.text(
      "YOU YELLOW ALLY CYAN H HUMAN N NATION T TRIBE",
      8,
      raster.height - 34,
    );
  if (preview) {
    circle(
      preview.target.x,
      preview.target.y,
      preview.blast.outer,
      preview.targetingAlly ? [255, 88, 88] : [255, 163, 75],
    );
    circle(
      preview.target.x,
      preview.target.y,
      preview.blast.inner,
      [255, 163, 75],
    );
    const curve = preview.trajectory;
    if (curve)
      for (let step = 1; step <= 96; step++) {
        const t = step / 96;
        const a = trajectoryPoint(curve, (step - 1) / 96),
          b = trajectoryPoint(curve, t);
        const p = worldPoint(a.x, a.y),
          q = worldPoint(b.x, b.y);
        const color: Color =
          t >= curve.tSamIntercept && preview.interception.coverageRisk
            ? [255, 88, 88]
            : t > curve.tUntargetableStart &&
                curve.tUntargetableStart >= 0 &&
                t < curve.tUntargetableEnd
              ? [145, 162, 177]
              : [255, 241, 116];
        raster.line(p.x, p.y, q.x, q.y, color, mapPixels);
      }
    const intercept = preview.interception.point;
    if (intercept) {
      const point = worldPoint(intercept.x, intercept.y);
      raster.line(
        point.x - 5,
        point.y - 5,
        point.x + 5,
        point.y + 5,
        [255, 88, 88],
        mapPixels,
      );
      raster.line(
        point.x - 5,
        point.y + 5,
        point.x + 5,
        point.y - 5,
        [255, 88, 88],
        mapPixels,
      );
    }
    raster.text(
      "ORANGE BLAST RED SAM COVERAGE ESTIMATE",
      36,
      raster.height - 34,
    );
  }
  if (overlays.units) {
    raster.text(
      "C CITY P PORT F FACTORY D DEF A SAM M SILO",
      8,
      raster.height - 23,
    );
    raster.text(
      "W WARSHIP B BOAT S TRADE - NUMBER IS LEVEL",
      8,
      raster.height - 12,
    );
  }
  const units = overlays.units
    ? publicUnitMarkers(game, region, self)
    : { units: [], unitCount: 0 };
  return {
    raster,
    region,
    mapPixels,
    overlays,
    players: playerMarkers,
    ...units,
    ...(self && (overlays.units || overlays.tradeRoutes)
      ? { tradeTraffic }
      : {}),
  };
}

/** One overview per tick serves every seat. Crops include only public map data. */
export class MapImages {
  private directory: string;
  private ready: Promise<void>;
  private overview?: {
    game: Game;
    tick: number;
    key: string;
    image: Promise<MapImage>;
  };

  constructor(private gameId: string) {
    this.directory = resolve(".agent-arena/frames", gameId);
    this.ready = mkdir(this.directory, { recursive: true }).then(
      () => undefined,
    );
  }

  async render(
    game: Game,
    player: Player,
    options?: VisionOverlays,
  ): Promise<MapVision> {
    const tick = game.ticks();
    const overlays = resolveOverlays(options);
    const key = overlayKey(overlays);
    if (
      this.overview?.game !== game ||
      this.overview.tick !== tick ||
      this.overview.key !== key
    ) {
      this.overview = {
        game,
        tick,
        key,
        image: this.save(
          draw(
            game,
            { x: 0, y: 0, width: game.width(), height: game.height() },
            768,
            `WORLD TICK ${tick}`,
            undefined,
            undefined,
            overlays,
          ),
          `overview-${tick}-${key}.png`,
        ),
      };
    }
    const overview = this.overview.image;
    const region = playerTerritoryRegion(game, player);
    const tactical = region
      ? this.save(
          draw(
            game,
            region,
            512,
            `TACTICAL TICK ${tick}`,
            player,
            undefined,
            overlays,
          ),
          `player-${player.smallID()}-${tick}-${key}.png`,
        )
      : undefined;
    return {
      tick,
      overview: await overview,
      ...(tactical ? { tactical: await tactical } : {}),
    };
  }

  /** The observation builder supplies an on-map region with positive dimensions. */
  async renderRegion(
    game: Game,
    player: Player,
    region: Region,
    options?: VisionOverlays,
  ): Promise<MapImage> {
    const tick = game.ticks();
    const overlays = resolveOverlays(options);
    return this.save(
      draw(
        game,
        region,
        512,
        `REGION TICK ${tick}`,
        player,
        undefined,
        overlays,
      ),
      `region-${player.smallID()}-${tick}-${region.x}-${region.y}-${region.width}-${region.height}-${overlayKey(overlays)}.png`,
    );
  }

  async renderNukePreview(
    game: Game,
    player: Player,
    preview: NukePreview,
  ): Promise<MapImage> {
    const curve = preview.trajectory;
    const xs = [
      preview.target.x - preview.blast.outer,
      preview.target.x + preview.blast.outer,
      ...(curve ? [curve.p0x, curve.p1x, curve.p2x, curve.p3x] : []),
    ];
    const ys = [
      preview.target.y - preview.blast.outer,
      preview.target.y + preview.blast.outer,
      ...(curve ? [curve.p0y, curve.p1y, curve.p2y, curve.p3y] : []),
    ];
    const x = Math.max(0, Math.floor(Math.min(...xs) - 16));
    const y = Math.max(0, Math.floor(Math.min(...ys) - 16));
    const region = {
      x,
      y,
      width: Math.min(game.width(), Math.ceil(Math.max(...xs) + 17)) - x,
      height: Math.min(game.height(), Math.ceil(Math.max(...ys) + 17)) - y,
    };
    return this.save(
      draw(
        game,
        region,
        512,
        `NUKE PREVIEW TICK ${game.ticks()}`,
        player,
        preview,
      ),
      `nuke-${player.smallID()}-${game.ticks()}-${preview.type === UnitType.AtomBomb ? "atom" : "hydro"}-${preview.target.tile}-${preview.rocketDirectionUp ? "up" : "down"}.png`,
    );
  }

  private async save(frame: Frame, name: string): Promise<MapImage> {
    const {
      raster,
      region,
      mapPixels,
      tradeTraffic,
      overlays,
      players,
      units,
      unitCount,
    } = frame;
    const png = await encodePng(raster.width, raster.height, raster.rgb);
    await this.ready;
    const path = resolve(this.directory, name);
    await writeFile(path, png);
    return {
      path,
      url: `/api/agents/frames/${this.gameId}/${name}`,
      width: raster.width,
      height: raster.height,
      region,
      mapPixels,
      detail: "high",
      overlays,
      players,
      units,
      unitCount,
      ...(tradeTraffic ? { tradeTraffic } : {}),
    };
  }
}
