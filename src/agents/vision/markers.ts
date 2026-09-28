import { Game, Player, Structures, UnitType } from "../../core/game/Game";
import { navalAffiliation, publicTradeTraffic } from "../game/naval";
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
const affiliationSymbols: Record<Affiliation, string> = {
  self: "Y",
  team: "T",
  ally: "A",
  other: "O",
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
  const symbols: Partial<Record<UnitType, string>> = {
    [UnitType.City]: "C",
    [UnitType.Port]: "P",
    [UnitType.Factory]: "F",
    [UnitType.DefensePost]: "D",
    [UnitType.SAMLauncher]: "A",
    [UnitType.MissileSilo]: "M",
  };
  const ships = game
    .units(UnitType.Warship, UnitType.TransportShip, UnitType.TradeShip)
    .filter((unit) => unit.isActive() && inside(unit.tile()));
  const traffic: TradeTrafficMarker[] = self
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
  for (const unit of game.units(Structures.types)) {
    if (!unit.isActive() || !inside(unit.tile())) continue;
    const point = position(unit.tile());
    const label = `${symbols[unit.type()]}${unit.level()}`;
    const width = label.length * 6 + 4;
    const candidates = [
      { x: point.x - width / 2, y: point.y - 15 },
      { x: point.x - width / 2, y: point.y + 5 },
      { x: point.x + 7, y: point.y - 4 },
      { x: point.x - width - 7, y: point.y - 4 },
      { x: point.x - width / 2, y: point.y - 27 },
      { x: point.x - width / 2, y: point.y + 17 },
      { x: point.x - width / 2, y: point.y - 39 },
      { x: point.x - width / 2, y: point.y + 29 },
    ].map((candidate) => ({
      x: Math.max(
        mapPixels.x,
        Math.min(
          mapPixels.x + mapPixels.width - width,
          Math.floor(candidate.x),
        ),
      ),
      y: Math.max(
        mapPixels.y,
        Math.min(mapPixels.y + mapPixels.height - 11, Math.floor(candidate.y)),
      ),
      width,
      height: 11,
    }));
    const box =
      candidates.find(
        (candidate) => !occupied.some((other) => overlaps(candidate, other)),
      ) ?? candidates[0];
    const color: Color =
      !self || unit.owner() === self
        ? [255, 241, 116]
        : self.isFriendly(unit.owner())
          ? [100, 223, 246]
          : [242, 247, 252];
    raster.fill(box.x, box.y, box.width, box.height, [12, 18, 26]);
    raster.text(label, box.x + 2, box.y + 2, color);
    occupied.push(box);
  }
  for (const unit of ships) {
    if (!self && unit.type() !== UnitType.TradeShip) continue;
    const point = position(unit.tile());
    for (let y = point.y - 4; y <= point.y + 6; y++)
      for (let x = point.x - 4; x <= point.x + 4; x++)
        if (
          x >= mapPixels.x &&
          x < mapPixels.x + mapPixels.width &&
          y >= mapPixels.y &&
          y < mapPixels.y + mapPixels.height
        )
          raster.pixel(x, y, [12, 18, 26]);
    const color = self
      ? navalColors[navalAffiliation(self, unit.owner())]
      : ([242, 247, 252] as const);
    // Clip edge markers with a small local raster so text cannot enter the axes.
    const marker = new Raster(5, 7);
    marker.text(
      unit.type() === UnitType.Warship
        ? "W"
        : unit.type() === UnitType.TransportShip
          ? "B"
          : "S",
      0,
      0,
      color,
    );
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++) {
        const px = point.x - 2 + x,
          py = point.y - 2 + y;
        if (
          px < mapPixels.x ||
          px >= mapPixels.x + mapPixels.width ||
          py < mapPixels.y ||
          py >= mapPixels.y + mapPixels.height
        )
          continue;
        const at = (y * 5 + x) * 3;
        if (marker.rgb[at] === color[0] && marker.rgb[at + 1] === color[1])
          raster.pixel(px, py, color);
      }
    occupied.push({ x: point.x - 4, y: point.y - 4, width: 9, height: 11 });
  }
  for (const ship of traffic) {
    const label = `S${ship.id}/${ship.ownerSmallId}${affiliationSymbols[ship.affiliation]}`;
    const width = label.length * 6 + 4;
    if (width > mapPixels.width || mapPixels.height < 11) continue;
    const point = position(game.ref(ship.x, ship.y));
    const candidates = [-15, 9, -27, 21].map((offset) => ({
      x: Math.max(
        mapPixels.x,
        Math.min(
          mapPixels.x + mapPixels.width - width,
          point.x - Math.floor(width / 2),
        ),
      ),
      y: Math.max(
        mapPixels.y,
        Math.min(mapPixels.y + mapPixels.height - 11, point.y + offset),
      ),
      width,
      height: 11,
    }));
    const box = candidates.find(
      (candidate) => !occupied.some((other) => overlaps(candidate, other)),
    );
    if (!box) continue;
    raster.fill(box.x, box.y, box.width, box.height, [12, 18, 26]);
    raster.text(label, box.x + 2, box.y + 2, navalColors[ship.affiliation]);
    occupied.push(box);
    ship.label = label;
  }
  return traffic;
}
