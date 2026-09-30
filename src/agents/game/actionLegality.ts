import { Game, Player, UnitType } from "../../core/game/Game";
import {
  canCounterAttack,
  landAttackBorders,
  transportLanding,
} from "./attackReachability";
import type { AgentAction } from "./schemas";

/** Reject known native control no-ops using current ownership and native permissions. */
export function assertAgentAction(
  game: Game,
  player: Player,
  intent: AgentAction,
): void {
  switch (intent.type) {
    case "attack": {
      if (intent.targetID !== null && !game.hasPlayer(intent.targetID))
        throw new Error(`Attack target ${intent.targetID} does not exist.`);
      const target =
        intent.targetID === null
          ? game.terraNullius()
          : game.player(intent.targetID);
      if (target === player)
        throw new Error("You cannot attack your own player.");
      if (target.isPlayer() && !target.isAlive())
        throw new Error("The attack target is no longer alive.");
      if (target.isPlayer() && !player.canAttackPlayer(target))
        throw new Error(
          "Native attack permission blocks this target: friendly, allied, or spawn immune.",
        );
      if (
        !landAttackBorders(game, player).has(target.smallID()) &&
        !canCounterAttack(player, target)
      )
        throw new Error(
          "No passable land border with this target. Water does not form a land attack border. Use a legal boat landing, establish a beachhead, or choose another target.",
        );
      return;
    }
    case "boat": {
      if (!game.isValidRef(intent.dst))
        throw new Error("A boat requires a valid destination tile.");
      const target = game.owner(intent.dst);
      if (target === player)
        throw new Error("A boat cannot attack your own land.");
      if (target.isPlayer() && !player.canAttackPlayer(target))
        throw new Error(
          "Native attack permission blocks this boat target: friendly, allied, or spawn immune.",
        );
      if (game.config().isUnitDisabled(UnitType.TransportShip))
        throw new Error("Transport ships are disabled in this match.");
      if (
        player.unitCount(UnitType.TransportShip) >=
        game.config().boatMaxNumber()
      )
        throw new Error(
          "The native transport limit is reached. Wait for a transport to arrive or retreat.",
        );
      if (!transportLanding(game, player, intent.dst))
        throw new Error(
          "No native legal boat landing and launch for this destination. A boat needs an owned coast and a reachable target coast on connected water.",
        );
      return;
    }
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
