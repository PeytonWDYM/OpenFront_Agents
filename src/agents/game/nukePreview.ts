import { z } from "zod";
import { buildNukeTrajectory } from "../../client/render/gl/utils/NukeTrajectory";
import {
  listNukeBreakAlliance,
  wouldNukeBreakAlliance,
} from "../../core/execution/Util";
import { Game, Player, UnitType } from "../../core/game/Game";

export const NukePreviewRequestSchema = z
  .object({
    type: z.enum([UnitType.AtomBomb, UnitType.HydrogenBomb]),
    tile: z.number().int().min(0),
    rocketDirectionUp: z.boolean().optional(),
  })
  .strict();
export type NukePreviewRequest = z.infer<typeof NukePreviewRequestSchema>;
type Trajectory = ReturnType<typeof buildNukeTrajectory>;

export function trajectoryPoint(curve: Trajectory, t: number) {
  const u = 1 - t;
  return {
    x:
      u ** 3 * curve.p0x +
      3 * u * u * t * curve.p1x +
      3 * u * t * t * curve.p2x +
      t ** 3 * curve.p3x,
    y:
      u ** 3 * curve.p0y +
      3 * u * u * t * curve.p1y +
      3 * u * t * t * curve.p2y +
      t ** 3 * curve.p3y,
  };
}

/** Public SAM rings follow the native preview's level range and friendliness rules. */
export function samCoverage(
  game: Game,
  player: Player,
  betrayed: ReadonlySet<number> = new Set(),
) {
  return game
    .units(UnitType.SAMLauncher)
    .filter((unit) => unit.isActive())
    .map((unit) => {
      const owner = unit.owner();
      const own = owner === player;
      const friendly =
        own ||
        player.isOnSameTeam(owner) ||
        (player.isAlliedWith(owner) && !betrayed.has(owner.smallID()));
      return {
        unitId: unit.id(),
        x: game.x(unit.tile()),
        y: game.y(unit.tile()),
        radius: game.config().samRange(unit.level()),
        own,
        threatens: !friendly,
      };
    });
}

/** Match native atom/hydrogen previews. Coverage is an estimate, not a battle simulation. */
export function buildNukePreview(
  game: Game,
  player: Player,
  request: NukePreviewRequest,
) {
  if (!game.isValidRef(request.tile))
    throw new Error("The nuke target tile is outside the map.");
  const config = game.config();
  const rocketDirectionUp = request.rocketDirectionUp ?? true;
  const blast = config.nukeMagnitudes(request.type);
  const allies = player.allies();
  const affected = allies.length
    ? listNukeBreakAlliance({
        game,
        targetTile: request.tile,
        magnitude: blast,
        threshold: config.nukeAllianceBreakThreshold(),
      })
    : new Set<number>();
  const betrayed = new Set(
    allies
      .filter((ally) => affected.has(ally.smallID()))
      .map((ally) => ally.smallID()),
  );
  const sams = samCoverage(game, player, betrayed);
  const silos = player
    .units(UnitType.MissileSilo)
    .filter(
      (unit) =>
        unit.isActive() && !unit.isInCooldown() && !unit.isUnderConstruction(),
    );
  silos.sort(
    (a, b) =>
      game.manhattanDist(a.tile(), request.tile) -
      game.manhattanDist(b.tile(), request.tile),
  );
  const silo = silos[0];
  const source = silo
    ? {
        unitId: silo.id(),
        tile: silo.tile(),
        x: game.x(silo.tile()),
        y: game.y(silo.tile()),
      }
    : null;
  const target = {
    tile: request.tile,
    x: game.x(request.tile),
    y: game.y(request.tile),
  };
  const trajectory = source
    ? buildNukeTrajectory(
        source.x,
        source.y,
        target.x,
        target.y,
        game.height(),
        rocketDirectionUp,
        sams
          .filter((sam) => sam.threatens)
          .map((sam) => ({ x: sam.x, y: sam.y, r: sam.radius })),
      )
    : null;
  const coverageRisk = trajectory ? trajectory.tSamIntercept < 1 : null;
  return {
    type: request.type,
    rocketDirectionUp,
    target,
    source,
    blast,
    canBuild: player.canBuild(request.type, request.tile) !== false,
    betrayedAllyIds: allies
      .filter((ally) => betrayed.has(ally.smallID()))
      .map((ally) => ally.id()),
    targetingAlly: wouldNukeBreakAlliance({
      game,
      targetTile: request.tile,
      magnitude: blast,
      threshold: config.nukeAllianceBreakThreshold(),
      allySmallIds: new Set(
        allies
          .filter((ally) => !ally.isDisconnected())
          .map((ally) => ally.smallID()),
      ),
    }),
    interception: {
      coverageRisk,
      point:
        coverageRisk && trajectory
          ? trajectoryPoint(trajectory, trajectory.tSamIntercept)
          : null,
      estimate:
        "SAM coverage risk only. Cooldown and future state can change interception.",
    },
    trajectory,
    sams,
  };
}
export type NukePreview = ReturnType<typeof buildNukePreview>;
