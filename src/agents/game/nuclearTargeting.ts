import { Game, Player, UnitType } from "../../core/game/Game";
import { TileRef } from "../../core/game/GameMap";

/** Nuclear build tiles are destinations. The native game chooses the launch silo. */
export function assertAgentNuclearTarget(
  game: Game,
  player: Player,
  type: UnitType,
  tile: TileRef,
): void {
  if (
    (type === UnitType.AtomBomb ||
      type === UnitType.HydrogenBomb ||
      type === UnitType.MIRV) &&
    game.isValidRef(tile) &&
    game.owner(tile) === player
  )
    throw new Error(
      "Self-nuke rejected. Use an enemy TARGET tile, never your own silo or city tile. The game selects the launch silo automatically. Inspect the blast preview for your cities before launching.",
    );
}
