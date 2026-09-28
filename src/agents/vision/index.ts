import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Game,
  Player,
  PlayerType,
  Structures,
  UnitType,
} from "../../core/game/Game";
import { encodePng } from "./png";
import { Color, Raster, Region } from "./raster";

export type MapImage = {
  path: string;
  url: string;
  width: number;
  height: number;
  region: Region;
  mapPixels: Region;
};
export type MapVision = {
  tick: number;
  overview: MapImage;
  tactical?: MapImage;
};
type Frame = { raster: Raster; region: Region; mapPixels: Region };

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

function crop(game: Game, player: Player): Region | undefined {
  if (!player.hasSpawned() || player.numTilesOwned() === 0) return;
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
): Frame {
  const scale = Math.min(
    (limit - 44) / region.width,
    (limit - 66) / region.height,
  );
  const mapPixels = {
    x: 36,
    y: 24,
    width: Math.max(1, Math.floor(region.width * scale)),
    height: Math.max(1, Math.floor(region.height * scale)),
  };
  const raster = new Raster(
    Math.max(300, mapPixels.width + 44),
    mapPixels.height + 66,
  );
  raster.text(title, 8, 7);
  const colors = new Map(
    game
      .allPlayers()
      .map((player) => [player.smallID(), ownerColor(player.smallID())]),
  );
  const centers = new Map<number, { x: number; y: number; count: number }>();
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
    for (let y = 0; y < mapPixels.height; y += 3)
      raster.pixel(mapPixels.x + px, mapPixels.y + y, [160, 175, 183]);
    for (let x = 0; x < mapPixels.width; x += 3)
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
  const occupied: Region[] = [];
  const priority = (player: Player) =>
    player === self
      ? 0
      : player.type() === PlayerType.Human
        ? 1
        : player.type() === PlayerType.Nation
          ? 2
          : 3;
  const players = [...game.allPlayers()].sort(
    (a, b) => priority(a) - priority(b) || a.smallID() - b.smallID(),
  );
  for (const player of players) {
    if (occupied.length >= (self ? 24 : 48)) break;
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
    const label =
      `${player === self ? "YOU " : ""}${type}${player.smallID()} ${player.displayName()}`.slice(
        0,
        self ? 26 : 21,
      );
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
    raster.fill(box.x, box.y, box.width, box.height, [18, 26, 35]);
    raster.text(
      label,
      box.x + 2,
      box.y + 2,
      player === self ? [255, 241, 116] : [242, 247, 252],
    );
    occupied.push(box);
  }
  const symbols: Partial<Record<UnitType, string>> = {
    [UnitType.City]: "C",
    [UnitType.Port]: "P",
    [UnitType.Factory]: "F",
    [UnitType.DefensePost]: "D",
    [UnitType.SAMLauncher]: "A",
    [UnitType.MissileSilo]: "M",
  };
  for (const unit of game.units(Structures.types)) {
    if (!unit.isActive() || !inside(unit.tile())) continue;
    const point = position(unit.tile());
    raster.fill(point.x - 4, point.y - 4, 9, 11, [12, 18, 26]);
    raster.text(
      symbols[unit.type()]!,
      point.x - 2,
      point.y - 2,
      [255, 241, 116],
    );
  }
  raster.text("H HUMAN  N NATION  T TRIBE", 36, raster.height - 23);
  raster.text(
    "C CITY P PORT F FACTORY D DEF A SAM M SILO",
    36,
    raster.height - 12,
  );
  return { raster, region, mapPixels };
}

/** One overview per tick serves every seat. Crops include only public map data. */
export class MapImages {
  private directory: string;
  private ready: Promise<void>;
  private overview?: { game: Game; tick: number; image: Promise<MapImage> };

  constructor(private gameId: string) {
    this.directory = resolve(".agent-arena/frames", gameId);
    this.ready = mkdir(this.directory, { recursive: true }).then(
      () => undefined,
    );
  }

  async render(game: Game, player: Player): Promise<MapVision> {
    const tick = game.ticks();
    if (this.overview?.game !== game || this.overview.tick !== tick) {
      this.overview = {
        game,
        tick,
        image: this.save(
          draw(
            game,
            { x: 0, y: 0, width: game.width(), height: game.height() },
            768,
            `WORLD TICK ${tick}`,
          ),
          `overview-${tick}.png`,
        ),
      };
    }
    const overview = this.overview.image;
    const region = crop(game, player);
    const tactical = region
      ? this.save(
          draw(game, region, 512, `TACTICAL TICK ${tick}`, player),
          `player-${player.smallID()}-${tick}.png`,
        )
      : undefined;
    return {
      tick,
      overview: await overview,
      ...(tactical ? { tactical: await tactical } : {}),
    };
  }

  private async save(frame: Frame, name: string): Promise<MapImage> {
    const { raster, region, mapPixels } = frame;
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
    };
  }
}
