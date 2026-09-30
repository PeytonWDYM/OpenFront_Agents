import { Game, Player, Structures, UnitType } from "../../core/game/Game";

/** Native legality decides acceptance. Errors name known state without copying placement rules. */
export function assertAgentBuild(
  game: Game,
  player: Player,
  type: UnitType,
  tile: number,
): void {
  if (!game.isValidRef(tile))
    throw new Error(`Cannot build ${type}: invalid tile ${tile}.`);
  if (player.canBuild(type, tile) !== false) return;

  const cost = game.unitInfo(type).cost(game, player);
  let reason: string;
  if (game.config().isUnitDisabled(type))
    reason = "This unit type is disabled.";
  else if (!player.isAlive()) reason = "The player is not alive.";
  else if (player.gold() < cost)
    reason = `Insufficient gold. Required: ${cost}. Available: ${player.gold()}.`;
  else if (Structures.has(type)) {
    const upgrade = player.findUnitToUpgrade(type, tile);
    if (upgrade !== false)
      reason = `A nearby owned ${type} can be upgraded. Use upgrade_structure with unitId ${upgrade.id()}.`;
    else if (game.owner(tile) !== player)
      reason = `The target tile is not owned by this player.${type === UnitType.Port ? " Ports require owned coastal land beside water." : ""}`;
    else {
      const nearby = game.nearbyUnits(
        tile,
        game.config().structureMinDist(),
        Structures.types,
        undefined,
        true,
      );
      const constructing = nearby.find(({ unit }) =>
        unit.isUnderConstruction(),
      );
      reason =
        type === UnitType.Port
          ? "No native legal Port placement near this tile. Ports require owned coastal land beside water and structure spacing."
          : "No native legal structure placement near this tile. Structures require owned land and structure spacing.";
      if (constructing)
        reason += ` Nearby ${constructing.unit.type()} unitId ${constructing.unit.id()} is under construction.`;
    }
  } else reason = "Native placement or launch requirements are not met.";
  throw new Error(`Cannot build ${type} at tile ${tile}. ${reason}`);
}

/** Validate one native upgrade. Bulk requests can still complete only the affordable portion. */
export function assertAgentUpgrade(
  game: Game,
  player: Player,
  type: UnitType,
  unitId: number,
): void {
  const unit = game.unit(unitId);
  let reason: string;
  if (unit === undefined) reason = "This unit no longer exists.";
  else if (unit.owner() !== player)
    reason = "This unit is not owned by this player.";
  else if (unit.type() !== type)
    reason = `The unit type is ${unit.type()}, not ${type}.`;
  else if (player.canUpgradeUnit(unit)) return;
  else if (unit.isUnderConstruction())
    reason = "This unit is under construction.";
  else if (unit.isMarkedForDeletion())
    reason = "This unit is marked for deletion.";
  else if (game.config().isUnitDisabled(type))
    reason = "This unit type is disabled.";
  else if (!game.unitInfo(type).upgradable)
    reason = "This unit type cannot be upgraded.";
  else if (!player.isAlive()) reason = "The player is not alive.";
  else {
    const cost = game.unitInfo(type).cost(game, player);
    reason = `Insufficient gold. Required: ${cost}. Available: ${player.gold()}.`;
  }
  throw new Error(`Cannot upgrade ${type} unitId ${unitId}. ${reason}`);
}
