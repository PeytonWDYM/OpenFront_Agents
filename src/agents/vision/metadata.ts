import { Game, Player, Structures, UnitType } from "../../core/game/Game";
import { navalAffiliation } from "../game/naval";
import { resolveOverlays, unitLayerVisible, VisionLayers } from "./options";
import { Color, Region } from "./raster";

export type PlayerMarker = {
  label: string;
  playerId: string;
  smallId: number;
  color: Color;
  tile: number;
  x: number;
  y: number;
};

/** Return exact public unit positions, closest to the crop center first. */
export function publicUnitMarkers(
  game: Game,
  region: Region,
  self?: Player,
  layers: VisionLayers = resolveOverlays(),
) {
  const visible = game
    .units([
      ...Structures.types,
      UnitType.Warship,
      UnitType.TransportShip,
      UnitType.TradeShip,
    ])
    .filter(
      (unit) =>
        unit.isActive() &&
        unitLayerVisible(unit.type(), layers) &&
        game.x(unit.tile()) >= region.x &&
        game.x(unit.tile()) < region.x + region.width &&
        game.y(unit.tile()) >= region.y &&
        game.y(unit.tile()) < region.y + region.height,
    );
  const center = game.ref(
    region.x + Math.floor(region.width / 2),
    region.y + Math.floor(region.height / 2),
  );
  visible.sort(
    (a, b) =>
      game.euclideanDistSquared(center, a.tile()) -
        game.euclideanDistSquared(center, b.tile()) || a.id() - b.id(),
  );
  return {
    unitCount: visible.length,
    units: visible.slice(0, 32).map((unit) => ({
      id: unit.id(),
      type: unit.type(),
      level: unit.level(),
      ownerId: unit.owner().id(),
      ...(self ? { affiliation: navalAffiliation(self, unit.owner()) } : {}),
      tile: unit.tile(),
      x: game.x(unit.tile()),
      y: game.y(unit.tile()),
    })),
  };
}
