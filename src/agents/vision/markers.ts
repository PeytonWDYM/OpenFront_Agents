import { Game, Player, Structures, UnitType } from "../../core/game/Game";
import { navalAffiliation, publicTradeTraffic } from "../game/naval";
import { drawUnitIcon } from "./icons";
import { resolveOverlays, unitLayerVisible, VisionLayers } from "./options";
import { Color, Raster, Region } from "./raster";

type Affiliation = ReturnType<typeof navalAffiliation>;
type PublicTradeShip = ReturnType<typeof publicTradeTraffic>[number];
export type TradeTrafficMarker = Omit<PublicTradeShip, "destination"> & {
  label?: string;
  destination?: NonNullable<PublicTradeShip["destination"]> & {
    inRegion: boolean;
  };
};
const navalColors: Record<Affiliation, Color> = {
  self: [255, 241, 116],
  team: [91, 221, 139],
  ally: [100, 223, 246],
  other: [239, 104, 99],
};
export type UnitGroupMarker = {
  type: UnitType;
  ownerId: string;
  // At most 32 exact IDs. Count includes every ship represented by the badge.
  unitIds: number[];
  count: number;
  x: number;
  y: number;
  tile: number;
};
const overlaps = (box: Region, other: Region) =>
  box.x < other.x + other.width &&
  box.x + box.width > other.x &&
  box.y < other.y + other.height &&
  box.y + box.height > other.y;

/** Draw public structure levels and naval markers from the actual viewer perspective. */
export function drawUnitMarkers(
  game: Game,
  raster: Raster,
  region: Region,
  mapPixels: Region,
  occupied: Region[],
  self?: Player,
  layers: VisionLayers = resolveOverlays(),
) {
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
  const ships = game
    .units(UnitType.Warship, UnitType.TransportShip, UnitType.TradeShip)
    .filter(
      (unit) =>
        unit.isActive() &&
        inside(unit.tile()) &&
        unitLayerVisible(unit.type(), layers),
    );
  const traffic: TradeTrafficMarker[] =
    self && (layers.tradeShips || layers.tradeRoutes)
      ? publicTradeTraffic(
          game,
          self,
          game.ref(
            region.x + Math.floor(region.width / 2),
            region.y + Math.floor(region.height / 2),
          ),
          inside,
        ).map(({ destination, ...ship }) => ({
          ...ship,
          ...(destination
            ? {
                destination: {
                  ...destination,
                  inRegion: inside(destination.tile),
                },
              }
            : {}),
        }))
      : [];
  // A dashed cue joins public positions. It does not expose a sailing path.
  for (const ship of traffic) {
    if (!layers.tradeRoutes) break;
    if (!ship.destination) continue;
    const point = position(game.ref(ship.x, ship.y));
    const target = position(game.ref(ship.destination.x, ship.destination.y));
    const dx = target.x - point.x,
      dy = target.y - point.y;
    const ratio = Math.min(
      1,
      dx > 0
        ? (mapPixels.x + mapPixels.width - 1 - point.x) / dx
        : dx < 0
          ? (mapPixels.x - point.x) / dx
          : 1,
      dy > 0
        ? (mapPixels.y + mapPixels.height - 1 - point.y) / dy
        : dy < 0
          ? (mapPixels.y - point.y) / dy
          : 1,
    );
    const endpoint = {
      x: Math.round(point.x + ratio * dx),
      y: Math.round(point.y + ratio * dy),
    };
    const color = navalColors[ship.affiliation];
    const overlayPixel = (x: number, y: number) => {
      if (
        x < mapPixels.x ||
        y < mapPixels.y ||
        x >= mapPixels.x + mapPixels.width ||
        y >= mapPixels.y + mapPixels.height
      )
        return;
      if (
        !occupied.some(
          (box) =>
            x >= box.x &&
            x < box.x + box.width &&
            y >= box.y &&
            y < box.y + box.height,
        )
      )
        raster.pixel(x, y, color);
    };
    const steps = Math.max(
      Math.abs(endpoint.x - point.x),
      Math.abs(endpoint.y - point.y),
    );
    for (let step = 0; step <= steps; step++) {
      if (step % 6 >= 3) continue;
      const fraction = steps === 0 ? 0 : step / steps;
      overlayPixel(
        Math.round(point.x + (endpoint.x - point.x) * fraction),
        Math.round(point.y + (endpoint.y - point.y) * fraction),
      );
    }
    for (let offset = -3; offset <= 3; offset++) {
      const radius = 3 - Math.abs(offset);
      overlayPixel(endpoint.x + offset, endpoint.y - radius);
      overlayPixel(endpoint.x + offset, endpoint.y + radius);
    }
  }
  const scale = Math.max(mapPixels.width, mapPixels.height) >= 600 ? 2 : 1;
  const background: Color = [12, 18, 26];
  const drawMarker = (
    unit: (typeof ships)[number],
    badge: string,
    ship = false,
  ) => {
    const point = position(unit.tile());
    const color: Color = self
      ? navalColors[navalAffiliation(self, unit.owner())]
      : [242, 247, 252];
    const width = 17 * scale + (badge ? badge.length * 6 + 3 : 0);
    const height = 17 * scale;
    if (width > mapPixels.width || height > mapPixels.height) {
      drawUnitIcon(
        raster,
        unit.type(),
        point.x - 6 * scale,
        point.y - 6 * scale,
        color,
        mapPixels,
        scale,
      );
      return;
    }
    const offsets = ship
      ? [{ x: -7 * scale, y: -7 * scale }]
      : [
          { x: -width / 2, y: -height - 4 },
          { x: -width / 2, y: 7 },
        ];
    for (const distance of [1, 2, 3])
      offsets.push(
        { x: -width * 1.5 - 4, y: -height / 2 - (distance - 1) * height },
        { x: width / 2 + 4, y: -height / 2 + (distance - 1) * height },
        { x: -width / 2, y: -height * (distance + 1) - 4 },
        { x: -width / 2, y: height * distance + 7 },
      );
    const candidates = offsets.map((offset) => ({
      x: Math.max(
        mapPixels.x,
        Math.min(
          mapPixels.x + mapPixels.width - width,
          Math.floor(point.x + offset.x),
        ),
      ),
      y: Math.max(
        mapPixels.y,
        Math.min(
          mapPixels.y + mapPixels.height - height,
          Math.floor(point.y + offset.y),
        ),
      ),
      width,
      height,
    }));
    const box = candidates.find(
      (candidate) => !occupied.some((other) => overlaps(candidate, other)),
    );
    if (!box) return;
    raster.line(
      point.x,
      point.y,
      box.x + 7 * scale,
      box.y + 7 * scale,
      color,
      mapPixels,
    );
    raster.fill(box.x, box.y, box.width, box.height, background);
    drawUnitIcon(
      raster,
      unit.type(),
      box.x + 2 * scale,
      box.y + 2 * scale,
      color,
      mapPixels,
      scale,
    );
    if (badge)
      raster.text(
        badge,
        box.x + 16 * scale,
        box.y + Math.floor((height - 7) / 2),
        color,
      );
    occupied.push(box);
    return box;
  };
  for (const unit of game.units(Structures.types)) {
    if (!layers.structures) break;
    if (!unit.isActive() || !inside(unit.tile())) continue;
    drawMarker(unit, String(unit.level()));
  }
  // Nearby ships share a marker only when their public type and owner match.
  const groups = new Map<string, typeof ships>();
  for (const ship of ships) {
    const point = position(ship.tile());
    const cell = 24 * scale;
    const key = `${ship.type()}-${ship.owner().id()}-${Math.floor((point.x - mapPixels.x) / cell)}-${Math.floor((point.y - mapPixels.y) / cell)}`;
    const group = groups.get(key);
    if (group) group.push(ship);
    else groups.set(key, [ship]);
  }
  const unitGroups: UnitGroupMarker[] = [];
  let unitGroupCount = 0;
  for (const group of groups.values()) {
    const unit = group[0];
    const badge =
      group.length > 1
        ? `X${group.length}`
        : unit.type() === UnitType.Warship
          ? String(unit.level())
          : "";
    if (!drawMarker(unit, badge, true)) continue;
    unitGroupCount++;
    if (unitGroups.length >= 32) continue;
    unitGroups.push({
      type: unit.type(),
      ownerId: unit.owner().id(),
      unitIds: group.slice(0, 32).map((ship) => ship.id()),
      count: group.length,
      tile: unit.tile(),
      x: game.x(unit.tile()),
      y: game.y(unit.tile()),
    });
  }
  return { tradeTraffic: traffic, unitGroups, unitGroupCount };
}
