import { Game, Player, Structures, UnitType } from "../../core/game/Game";
import { missileReadiness } from "./nukePreview";

/** Keep owned defenses and controllable ships ahead of automatic traffic. */
export function ownedUnitView(
  game: Game,
  player: Player,
  withinRegion?: (tile: number) => boolean,
) {
  const priority = (type: UnitType) => {
    if (type === UnitType.SAMLauncher || type === UnitType.MissileSilo)
      return 0;
    if (type === UnitType.Warship) return 1;
    if (Structures.has(type)) return 2;
    if (type === UnitType.TradeShip || type === UnitType.Train) return 4;
    return 3;
  };
  const candidates = player
    .units()
    .filter((unit) => !withinRegion || withinRegion(unit.tile()))
    .sort((a, b) => priority(a.type()) - priority(b.type()) || a.id() - b.id());
  const counts = (units: typeof candidates) =>
    Object.fromEntries(
      Object.values(UnitType).map((type) => [
        type,
        units.filter((unit) => unit.type() === type).length,
      ]),
    );
  const selected = candidates.slice(0, 32);
  return {
    units: selected.map((unit) => {
      const type = unit.type();
      const cooldown =
        type === UnitType.SAMLauncher
          ? game.config().SAMCooldown()
          : game.config().SiloCooldown();
      const missileSlots =
        type === UnitType.SAMLauncher || type === UnitType.MissileSilo;
      const patrolTile =
        type === UnitType.Warship ? unit.warshipState().patrolTile : undefined;
      const point = (tile: number) => ({
        tile,
        x: game.x(tile),
        y: game.y(tile),
      });
      return {
        id: unit.id(),
        type,
        ...point(unit.tile()),
        level: unit.level(),
        canUpgrade: player.canUpgradeUnit(unit),
        underConstruction: unit.isUnderConstruction(),
        ...(unit.hasHealth()
          ? { health: unit.health(), maxHealth: unit.maxHealth() }
          : {}),
        ...(type === UnitType.Warship
          ? {
              state: unit.warshipState().state,
              ...(patrolTile === undefined
                ? {}
                : { patrol: point(patrolTile) }),
            }
          : {}),
        ...(missileSlots
          ? {
              inCooldown: unit.isInCooldown(),
              ...missileReadiness(game, unit, cooldown),
            }
          : {}),
      };
    }),
    unitSummary: {
      scope: withinRegion ? ("owned in region" as const) : ("owned" as const),
      total: candidates.length,
      included: selected.length,
      omitted: candidates.length - selected.length,
      counts: counts(candidates),
      omittedCounts: counts(candidates.slice(32)),
    },
  };
}
