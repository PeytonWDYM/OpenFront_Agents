import { Game, Player, UnitType } from "../../core/game/Game";
import type { AgentAction } from "./schemas";

/** Reject known native control no-ops using current ownership and native permissions. */
export function assertAgentAction(
  game: Game,
  player: Player,
  intent: AgentAction,
): void {
  switch (intent.type) {
    case "cancel_attack":
      if (
        !player
          .outgoingAttacks()
          .some(
            (attack) => attack.id() === intent.attackID && attack.isActive(),
          )
      )
        throw new Error(
          "cancel_attack requires your own outgoing attack ID. It cannot stop enemy troops.",
        );
      return;
    case "cancel_boat":
      if (
        !player
          .units(UnitType.TransportShip)
          .some((unit) => unit.id() === intent.unitID && unit.isActive())
      )
        throw new Error("cancel_boat requires your own active transport ID.");
      return;
    case "move_warship": {
      if (!game.isValidRef(intent.tile))
        throw new Error("move_warship requires a valid patrol tile.");
      // WaterManager resolves native shore targets as well as water tiles.
      const component = game.getWaterComponent(intent.tile);
      const ships = new Map(
        player.units(UnitType.Warship).map((unit) => [unit.id(), unit]),
      );
      for (const id of intent.unitIds) {
        const ship = ships.get(id);
        if (!ship || !ship.isActive())
          throw new Error(
            `move_warship requires your own active warship IDs. Unit ${id} is not available.`,
          );
        if (
          component === null ||
          !game.hasWaterComponent(ship.tile(), component)
        )
          throw new Error(
            `Warship ${id} needs connected water at the patrol target.`,
          );
      }
      return;
    }
    case "delete_unit": {
      const unit = game.unit(intent.unitId);
      if (!unit || unit.owner() !== player || !unit.isActive())
        throw new Error("delete_unit requires your own active unit ID.");
      if (
        !game.isLand(unit.tile()) ||
        game.ownerID(unit.tile()) !== player.smallID()
      )
        throw new Error("delete_unit requires a unit on your owned land.");
      if (game.inSpawnPhase())
        throw new Error("Units cannot be deleted during spawn.");
      if (!player.canDeleteUnit())
        throw new Error("The native delete_unit cooldown has not expired.");
      return;
    }
    case "allianceExtension": {
      if (
        !game.hasPlayer(intent.recipient) ||
        !player.allianceWith(game.player(intent.recipient))
      )
        throw new Error(
          "allianceExtension requires an active alliance with the recipient.",
        );
      if (!player.isAlive() || !game.player(intent.recipient).isAlive())
        throw new Error("allianceExtension requires two living players.");
      return;
    }
  }
}
