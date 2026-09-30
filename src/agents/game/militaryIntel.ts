import { Game, Player, Structures, Unit, UnitType } from "../../core/game/Game";
import { missileReadiness, samCoverage } from "./nukePreview";

const CONCENTRATION_LIMIT = 12;
const INBOUND_LIMIT = 32;
const UNIT_DETAIL_LIMIT = 32;
const NUCLEAR_TYPES = new Set([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
]);

/** Current public military state. Coverage does not predict interception outcomes. */
export function militaryIntel(game: Game, player: Player) {
  const config = game.config();
  const position = (unit: Unit) => ({
    unitId: unit.id(),
    type: unit.type(),
    tile: unit.tile(),
    x: game.x(unit.tile()),
    y: game.y(unit.tile()),
    level: unit.level(),
    underConstruction: unit.isUnderConstruction(),
  });
  const structures = player
    .units()
    .filter((unit) => unit.isActive() && Structures.has(unit.type()));
  const sams = samCoverage(game, player).filter((sam) => sam.own);
  const posts = structures.filter(
    (unit) => unit.type() === UnitType.DefensePost,
  );
  const completedPosts = posts.filter((unit) => !unit.isUnderConstruction());
  const silos = structures
    .filter((unit) => unit.type() === UnitType.MissileSilo)
    .map((unit) => ({
      ...position(unit),
      ...missileReadiness(game, unit, config.SiloCooldown()),
    }));
  const readinessSummary = (
    units: readonly ReturnType<typeof missileReadiness>[],
  ) => ({
    totalUnits: units.length,
    totalSlots: units.reduce((sum, unit) => sum + unit.totalSlots, 0),
    readySlots: units.reduce((sum, unit) => sum + unit.readySlots, 0),
    reloadingSlots: units.reduce(
      (sum, unit) => sum + unit.reloadSlots.length,
      0,
    ),
    underConstructionUnits: units.filter((unit) => unit.underConstruction)
      .length,
  });
  const blastConcentration = (center: Unit, type: UnitType) => {
    const radius = config.nukeMagnitudes(type).outer;
    const affected = game
      .nearbyUnits(center.tile(), radius, Structures.types, undefined, true)
      .map(({ unit }) => unit)
      .filter(
        (unit) =>
          unit.owner() === player &&
          game.euclideanDistSquared(center.tile(), unit.tile()) < radius ** 2,
      );
    const cities = affected.filter((unit) => unit.type() === UnitType.City);
    const cityLevelsAtRisk = cities.reduce(
      (levels, city) => levels + city.level(),
      0,
    );
    const completedCityLevelsAtRisk = cities
      .filter((city) => !city.isUnderConstruction())
      .reduce((levels, city) => levels + city.level(), 0);
    const unitIds = affected.map((unit) => unit.id()).sort((a, b) => a - b);
    return {
      footprintSignature: unitIds.join(","),
      radius,
      structureCount: affected.length,
      unitIds: unitIds.slice(0, UNIT_DETAIL_LIMIT),
      unitIdsTruncated: affected.length > 32,
      cityLevelsAtRisk,
      cityCapacityAtRisk:
        completedCityLevelsAtRisk * config.cityTroopIncrease(),
    };
  };
  const centers = structures
    .map((unit) => {
      const { footprintSignature: atomFootprint, ...atom } = blastConcentration(
        unit,
        UnitType.AtomBomb,
      );
      const { footprintSignature: hydrogenFootprint, ...hydrogen } =
        blastConcentration(unit, UnitType.HydrogenBomb);
      return {
        ...position(unit),
        atom,
        hydrogen,
        footprintSignature: `${atomFootprint}|${hydrogenFootprint}`,
      };
    })
    .sort(
      (a, b) =>
        b.atom.cityCapacityAtRisk - a.atom.cityCapacityAtRisk ||
        b.hydrogen.cityCapacityAtRisk - a.hydrogen.cityCapacityAtRisk ||
        b.atom.structureCount - a.atom.structureCount ||
        a.unitId - b.unitId,
    );
  const seenFootprints = new Set<string>();
  const distinctCenters = centers.flatMap(
    ({ footprintSignature, ...center }) => {
      if (seenFootprints.has(footprintSignature)) return [];
      seenFootprints.add(footprintSignature);
      return [center];
    },
  );
  const coveredCenters = distinctCenters
    .slice(0, CONCENTRATION_LIMIT)
    .map((center) => {
      const coveringPosts = completedPosts
        .filter(
          (post) =>
            game.euclideanDistSquared(center.tile, post.tile()) <=
            config.defensePostRange() ** 2,
        )
        .map((post) => post.id());
      const coveringSams = sams
        .filter(
          (sam) =>
            !sam.underConstruction &&
            game.euclideanDistSquared(center.tile, sam.tile) <= sam.radius ** 2,
        )
        .map((sam) => sam.unitId);
      return {
        ...center,
        defensePostIds: coveringPosts.slice(0, UNIT_DETAIL_LIMIT),
        defensePostCount: coveringPosts.length,
        defensePostIdsTruncated: coveringPosts.length > UNIT_DETAIL_LIMIT,
        samIds: coveringSams.slice(0, UNIT_DETAIL_LIMIT),
        samCount: coveringSams.length,
        samIdsTruncated: coveringSams.length > UNIT_DETAIL_LIMIT,
      };
    });
  const missiles = game
    .units()
    .filter(
      (unit) =>
        unit.isActive() &&
        NUCLEAR_TYPES.has(unit.type()) &&
        !player.isFriendly(unit.owner(), true),
    )
    .map((unit) => {
      const targetTile = unit.targetTile();
      const targetOwner =
        targetTile === undefined ? undefined : game.owner(targetTile);
      const targetPlayer = unit.targetPlayer();
      const ownInfrastructureAtRisk =
        targetTile !== undefined && unit.type() !== UnitType.MIRV
          ? structures
              .filter(
                (structure) =>
                  game.euclideanDistSquared(targetTile, structure.tile()) <
                  config.nukeMagnitudes(unit.type()).outer ** 2,
              )
              .map((structure) => structure.id())
          : [];
      return {
        unitId: unit.id(),
        missileType: unit.type(),
        attackerId: unit.owner().id(),
        currentTile: unit.tile(),
        x: game.x(unit.tile()),
        y: game.y(unit.tile()),
        targetTile,
        targetX: targetTile === undefined ? undefined : game.x(targetTile),
        targetY: targetTile === undefined ? undefined : game.y(targetTile),
        targetOwnerId: targetOwner?.isPlayer() ? targetOwner.id() : null,
        targetPlayerId: targetPlayer?.isPlayer() ? targetPlayer.id() : null,
        targetsSelf: targetOwner === player || targetPlayer === player,
        ownInfrastructureAtRisk: ownInfrastructureAtRisk.slice(
          0,
          UNIT_DETAIL_LIMIT,
        ),
        ownInfrastructureAtRiskCount: ownInfrastructureAtRisk.length,
        ownInfrastructureAtRiskTruncated:
          ownInfrastructureAtRisk.length > UNIT_DETAIL_LIMIT,
        targetableBySAM: unit.type() !== UnitType.MIRV && unit.isTargetable(),
      };
    })
    .filter(
      (missile) =>
        missile.targetsSelf || missile.ownInfrastructureAtRiskCount > 0,
    )
    .sort(
      (a, b) =>
        Number(b.targetsSelf) - Number(a.targetsSelf) || a.unitId - b.unitId,
    );
  return {
    samLaunchers: sams.slice(0, UNIT_DETAIL_LIMIT),
    samLaunchersTotal: sams.length,
    samLaunchersTruncated: sams.length > UNIT_DETAIL_LIMIT,
    samReadiness: readinessSummary(sams),
    missileSilos: silos.slice(0, UNIT_DETAIL_LIMIT),
    missileSilosTotal: silos.length,
    missileSilosTruncated: silos.length > UNIT_DETAIL_LIMIT,
    siloReadiness: readinessSummary(silos),
    defensePosts: {
      units: posts.slice(0, UNIT_DETAIL_LIMIT).map(position),
      totalUnits: posts.length,
      truncated: posts.length > UNIT_DETAIL_LIMIT,
      facts: {
        range: config.defensePostRange(),
        bonusesStack: false,
        requiresCompletedOwnPost: true,
        attackerTerrainLossMultiplier: config.defensePostDefenseBonus(),
        attackerTileCostMultiplier: config.defensePostSpeedBonus(),
        interceptsMissiles: false,
      },
    },
    infrastructureConcentration: {
      basis: "distinct Atom and Hydrogen structure footprints",
      centers: coveredCenters,
      totalCenters: distinctCenters.length,
      totalCandidateCenters: centers.length,
      truncated: distinctCenters.length > CONCENTRATION_LIMIT,
    },
    inboundMissiles: missiles.slice(0, INBOUND_LIMIT),
    inboundMissilesTotal: missiles.length,
    inboundMissilesTruncated: missiles.length > INBOUND_LIMIT,
    facts: {
      samCoverageIsCurrentRangeOnly: true,
      samInterceptableTypes: [
        UnitType.AtomBomb,
        UnitType.HydrogenBomb,
        UnitType.MIRVWarhead,
      ],
      mirvCarrierInterceptable: false,
      structureDestructionUsesStrictOuterRadius: true,
    },
  };
}
export type MilitaryIntel = ReturnType<typeof militaryIntel>;
