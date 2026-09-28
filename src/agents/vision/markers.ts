import { Game, Player, Structures, UnitType } from "../../core/game/Game";
import { Color, Raster, Region } from "./raster";

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
        (candidate) =>
          !occupied.some(
            (other) =>
              candidate.x < other.x + other.width &&
              candidate.x + candidate.width > other.x &&
              candidate.y < other.y + other.height &&
              candidate.y + candidate.height > other.y,
          ),
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
  if (self) {
    for (const unit of game.units(
      UnitType.Warship,
      UnitType.TransportShip,
      UnitType.TradeShip,
    )) {
      if (!unit.isActive() || !inside(unit.tile())) continue;
      const point = position(unit.tile());
      raster.fill(point.x - 4, point.y - 4, 9, 11, [12, 18, 26]);
      raster.text(
        unit.type() === UnitType.Warship
          ? "W"
          : unit.type() === UnitType.TransportShip
            ? "B"
            : "S",
        point.x - 2,
        point.y - 2,
        unit.owner() === self
          ? [255, 241, 116]
          : self.isFriendly(unit.owner())
            ? [100, 223, 246]
            : [239, 104, 99],
      );
    }
  }
}
