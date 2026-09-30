import { Game, Player, UnitType } from "../../core/game/Game";
import { AgentObservation, ObserveQuery } from "./schemas";

/** Find distinct native build locations without placing or upgrading a unit. */
export function requestedBuildSites(
  game: Game,
  player: Player,
  query: ObserveQuery,
) {
  const type = query.buildType!;
  const x = Math.min(query.x ?? 0, game.width() - 1);
  const y = Math.min(query.y ?? 0, game.height() - 1);
  const width = Math.min(query.width ?? game.width(), game.width() - x);
  const height = Math.min(query.height ?? game.height(), game.height() - y);
  const inside = (tile: number) =>
    game.x(tile) >= x &&
    game.x(tile) < x + width &&
    game.y(tile) >= y &&
    game.y(tile) < y + height;
  const sites: AgentObservation["map"]["buildSites"] = [];
  const cost = Number(game.unitInfo(type).cost(game, player));
  const spacing = game.config().structureMinDist() ** 2;
  for (const tile of player.tiles()) {
    if (!inside(tile) || (type === UnitType.Port && !game.isShore(tile)))
      continue;
    if (
      sites.some((site) => game.euclideanDistSquared(tile, site.tile) < spacing)
    )
      continue;
    const target = player.canBuild(type, tile);
    if (
      target === false ||
      !inside(target) ||
      sites.some(
        (site) => game.euclideanDistSquared(target, site.tile) < spacing,
      )
    )
      continue;
    sites.push({ type, tile: target, cost, upgradeId: false });
    if (sites.length > 12) break;
  }
  if (sites.length <= 12)
    for (const unit of player.units(type)) {
      if (!inside(unit.tile()) || !player.canUpgradeUnit(unit)) continue;
      sites.push({ type, tile: unit.tile(), cost, upgradeId: unit.id() });
      if (sites.length > 12) break;
    }
  return { sites: sites.slice(0, 12), truncated: sites.length > 12 };
}
