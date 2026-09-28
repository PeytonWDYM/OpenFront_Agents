import { Game, Player, UnitType } from "../../core/game/Game";
import type { AgentObservation } from "./schemas";

export type NavalAffiliation = "self" | "team" | "ally" | "other";

export function navalAffiliation(
  self: Player,
  other: Player,
): NavalAffiliation {
  if (self === other) return "self";
  if (self.isOnSameTeam(other)) return "team";
  return self.isAlliedWith(other) ? "ally" : "other";
}

/** A Warship intent selects water. Native canBuild returns the launch Port. */
export function warshipBuildSite(
  game: Game,
  player: Player,
  reference: number,
) {
  if (game.inSpawnPhase()) return undefined;
  const ports = player
    .units(UnitType.Port)
    .sort(
      (a, b) =>
        game.euclideanDistSquared(reference, a.tile()) -
        game.euclideanDistSquared(reference, b.tile()),
    );
  const targets = [
    reference,
    ...ports.flatMap((port) => game.neighbors(port.tile())),
  ];
  for (const tile of targets) {
    if (
      !game.isWater(tile) ||
      player.canBuild(UnitType.Warship, tile) === false
    )
      continue;
    return {
      type: UnitType.Warship,
      tile,
      cost: Number(game.config().unitInfo(UnitType.Warship).cost(game, player)),
      upgradeId: false as const,
    };
  }
  return undefined;
}

/** Only public ship position, owner, and destination Port data enter this view. */
export function publicTradeTraffic(
  game: Game,
  self: Player,
  reference: number,
  withinRegion?: (tile: number) => boolean,
): AgentObservation["map"]["tradeTraffic"] {
  const references = withinRegion
    ? [reference]
    : [reference, ...self.units(UnitType.Port).map((port) => port.tile())];
  const distance = (tile: number) =>
    Math.min(...references.map((ref) => game.euclideanDistSquared(ref, tile)));
  const publicOwner = (owner: Player) => ({
    ownerId: owner.id(),
    ownerSmallId: owner.smallID(),
    affiliation: navalAffiliation(self, owner),
  });
  const position = (tile: number) => ({
    tile,
    x: game.x(tile),
    y: game.y(tile),
  });
  return game
    .units(UnitType.TradeShip)
    .filter((ship) => !withinRegion || withinRegion(ship.tile()))
    .sort((a, b) => distance(a.tile()) - distance(b.tile()) || a.id() - b.id())
    .slice(0, 12)
    .map((ship) => {
      const destination = ship.targetUnit();
      return {
        id: ship.id(),
        type: ship.type(),
        ...position(ship.tile()),
        ...publicOwner(ship.owner()),
        ...(destination?.type() === UnitType.Port
          ? {
              destination: {
                id: destination.id(),
                ...position(destination.tile()),
                ...publicOwner(destination.owner()),
              },
            }
          : {}),
      };
    });
}
