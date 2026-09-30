import { Game, Player, Unit, UnitType } from "../../core/game/Game";
import type { Region } from "../vision/raster";
import { navalAffiliation } from "./naval";

/** Current public ship occupancy. Eligibility is a target filter, not a capture forecast. */
export function buildTradeHeatmap(game: Game, viewer: Player, region?: Region) {
  const bounds = region ?? {
    x: 0,
    y: 0,
    width: game.width(),
    height: game.height(),
  };
  const inside = (tile: number) =>
    game.x(tile) >= bounds.x &&
    game.x(tile) < bounds.x + bounds.width &&
    game.y(tile) >= bounds.y &&
    game.y(tile) < bounds.y + bounds.height;
  const position = (tile: number) => ({
    tile,
    x: game.x(tile),
    y: game.y(tile),
  });
  const ports = viewer
    .units(UnitType.Port)
    .filter(
      (port) =>
        port.isActive() &&
        !port.isMarkedForDeletion() &&
        !port.isUnderConstruction(),
    );
  const reachablePorts = new Map<number, Unit[]>();
  const portsAt = (tile: number) => {
    const component = game.getWaterComponent(tile);
    if (component === null) return [];
    let found = reachablePorts.get(component);
    if (found === undefined) {
      found = ports.filter((port) =>
        game.hasWaterComponent(port.tile(), component),
      );
      reachablePorts.set(component, found);
    }
    return found;
  };
  // WarshipExecution uses treatAFKFriendly=true for the owner. The destination
  // calls destination.owner().isFriendly(viewer) with the native default.
  const ownerEligible = (ship: Unit) =>
    ship.owner() !== viewer &&
    viewer.canAttackPlayer(ship.owner(), true) &&
    !ship.isSafeFromPirates() &&
    ship.targetUnit()?.owner() !== viewer &&
    !ship.targetUnit()?.owner().isFriendly(viewer);
  const publicShips = game
    .units(UnitType.TradeShip)
    .filter((ship) => ship.isActive());
  const ships = publicShips.filter((ship) => inside(ship.tile()));
  const eligible = new Set(
    ships
      .filter((ship) => ownerEligible(ship) && portsAt(ship.tile()).length > 0)
      .map((ship) => ship.id()),
  );
  const columns = Math.min(32, bounds.width),
    rows = Math.min(32, bounds.height);
  const grid = {
    columns,
    rows,
    cellWidth: bounds.width / columns,
    cellHeight: bounds.height / rows,
  };
  type Bin = Region & {
    column: number;
    row: number;
    total: number;
    eligible: number;
  };
  const binsByKey = new Map<number, Bin>();
  const waterSamples = new Map<
    number,
    Map<number, { total: number; eligible: number }>
  >();
  for (const ship of ships) {
    const column = Math.min(
      columns - 1,
      Math.floor(((game.x(ship.tile()) - bounds.x) * columns) / bounds.width),
    );
    const row = Math.min(
      rows - 1,
      Math.floor(((game.y(ship.tile()) - bounds.y) * rows) / bounds.height),
    );
    const key = row * columns + column;
    let bin = binsByKey.get(key);
    if (bin === undefined) {
      const x = bounds.x + Math.ceil(column * grid.cellWidth),
        y = bounds.y + Math.ceil(row * grid.cellHeight);
      bin = {
        column,
        row,
        x,
        y,
        width: bounds.x + Math.ceil((column + 1) * grid.cellWidth) - x,
        height: bounds.y + Math.ceil((row + 1) * grid.cellHeight) - y,
        total: 0,
        eligible: 0,
      };
      binsByKey.set(key, bin);
    }
    bin.total++;
    if (eligible.has(ship.id())) bin.eligible++;
    if (!game.isWater(ship.tile())) continue;
    const samples =
      waterSamples.get(key) ??
      new Map<number, { total: number; eligible: number }>();
    const point = samples.get(ship.tile()) ?? { total: 0, eligible: 0 };
    point.total++;
    if (eligible.has(ship.id())) point.eligible++;
    samples.set(ship.tile(), point);
    waterSamples.set(key, samples);
  }
  const bins = [...binsByKey.values()].sort(
    (a, b) => a.row - b.row || a.column - b.column,
  );
  const candidates = [...waterSamples]
    .map(([key, samples]) => {
      const [tile, count] = [...samples].sort(
        (a, b) =>
          b[1].eligible - a[1].eligible ||
          b[1].total - a[1].total ||
          a[0] - b[0],
      )[0];
      const bin = binsByKey.get(key)!;
      const launchTile =
        !game.inSpawnPhase() && portsAt(tile).length > 0
          ? viewer.canBuild(UnitType.Warship, tile)
          : false;
      const launchPort =
        launchTile === false
          ? undefined
          : portsAt(tile).find((port) => port.tile() === launchTile);
      return {
        ...position(tile),
        total: bin.total,
        eligible: bin.eligible,
        exactTileTraffic: count,
        bin: { column: bin.column, row: bin.row },
        ...(launchPort
          ? {
              launch: {
                portId: launchPort.id(),
                portTile: launchPort.tile(),
                cost: Number(
                  game.config().unitInfo(UnitType.Warship).cost(game, viewer),
                ),
              },
            }
          : {}),
      };
    })
    .sort(
      (a, b) => b.eligible - a.eligible || b.total - a.total || a.tile - b.tile,
    )
    .slice(0, 12);
  const detectionRadius = game.config().warshipTargettingRange();
  const patrolRadius = game.config().warshipPatrolRange();
  const allWarships = game
    .units(UnitType.Warship)
    .filter((ship) => ship.isActive());
  const near = (tile: number) =>
    candidates.some(
      (spot) =>
        game.euclideanDistSquared(tile, spot.tile) <= detectionRadius ** 2,
    );
  const circleIntersectsRegion = (tile: number, radius: number) => {
    const x = game.x(tile),
      y = game.y(tile);
    const closestX = Math.max(
      bounds.x,
      Math.min(x, bounds.x + bounds.width - 1),
    );
    const closestY = Math.max(
      bounds.y,
      Math.min(y, bounds.y + bounds.height - 1),
    );
    return (x - closestX) ** 2 + (y - closestY) ** 2 <= radius ** 2;
  };
  const visibleWarships = allWarships.filter((ship) => {
    const patrol = ship.warshipState().patrolTile;
    return (
      inside(ship.tile()) ||
      near(ship.tile()) ||
      circleIntersectsRegion(ship.tile(), detectionRadius) ||
      (patrol !== undefined && circleIntersectsRegion(patrol, patrolRadius))
    );
  });
  const warships = visibleWarships
    .sort(
      (a, b) =>
        Number(b.owner() === viewer) - Number(a.owner() === viewer) ||
        a.id() - b.id(),
    )
    .slice(0, 24)
    .map((ship) => {
      const update = ship.toUpdate();
      const state = update.warshipState!;
      const patrol = state.patrolTile;
      const targetEligibleTraffic =
        ship.owner() === viewer &&
        portsAt(ship.tile()).length > 0 &&
        patrol !== undefined
          ? publicShips.filter(
              (trade) =>
                ownerEligible(trade) &&
                game.euclideanDistSquared(ship.tile(), trade.tile()) <=
                  detectionRadius ** 2 &&
                game.euclideanDistSquared(patrol, trade.tile()) <=
                  patrolRadius ** 2,
            ).length
          : undefined;
      return {
        id: ship.id(),
        ownerId: ship.owner().id(),
        ownerSmallId: update.ownerID,
        affiliation: navalAffiliation(viewer, ship.owner()),
        ...position(update.pos),
        health: update.health!,
        state: state.state,
        isInCombat: state.isInCombat,
        detectionRadius,
        ...(patrol !== undefined
          ? { patrol: { ...position(patrol), radius: patrolRadius } }
          : {}),
        ...(targetEligibleTraffic !== undefined
          ? { targetEligibleTraffic }
          : {}),
      };
    });
  return {
    tick: game.ticks(),
    sample: {
      kind: "instant" as const,
      windowTicks: 0,
      meaning:
        "Current public ship occupancy. No completed voyages or future captures.",
    },
    region: bounds,
    grid,
    traffic: { total: ships.length, eligible: eligible.size },
    bins,
    hotspots: candidates.map((spot) => ({
      ...spot,
      nearbyWarshipIds: warships
        .filter(
          (ship) =>
            game.euclideanDistSquared(spot.tile, ship.tile) <=
            detectionRadius ** 2,
        )
        .map((ship) => ship.id),
    })),
    warships,
    warshipCount: visibleWarships.length,
    rules: {
      detectionRadius,
      patrolRadius,
      captureManhattanDistance: 5,
      eligibility:
        "Attackable nonfriendly owner, nonfriendly destination, no current piracy protection, completed reachable owned Port. Existing Warship filters also require detection and patrol ranges.",
      capture:
        "One selected ship is chased. Transports, enemy Warships and repairs can interrupt piracy. Density does not guarantee captures or income.",
    },
  };
}

export type TradeHeatmap = ReturnType<typeof buildTradeHeatmap>;

type WarshipBuildSite = {
  action: "build_unit";
  type: UnitType.Warship;
  tile: number;
  x: number;
  y: number;
  cost: number;
  upgradeId: false;
  context: {
    launchPortId: number;
    launchPortTile: number;
    traffic: number;
    eligibleTraffic: number;
  };
};

/** Exact water patrol choices. Native canBuild supplies the launch Port. */
export function requestedWarshipBuildSites(
  game: Game,
  player: Player,
  query: Partial<Region>,
) {
  const x = Math.min(query.x ?? 0, game.width() - 1),
    y = Math.min(query.y ?? 0, game.height() - 1);
  const region = {
    x,
    y,
    width: Math.min(query.width ?? game.width(), game.width() - x),
    height: Math.min(query.height ?? game.height(), game.height() - y),
  };
  const heatmap = buildTradeHeatmap(game, player, region);
  const ports = player
    .units(UnitType.Port)
    .filter(
      (port) =>
        port.isActive() &&
        !port.isMarkedForDeletion() &&
        !port.isUnderConstruction(),
    );
  const candidates = [
    ...heatmap.hotspots.map((spot) => spot.tile),
    ...ports.flatMap((port) => game.neighbors(port.tile())),
  ];
  const sites: WarshipBuildSite[] = [];
  const seen = new Set<number>();
  if (game.inSpawnPhase()) return { sites, truncated: false };
  for (const tile of candidates) {
    if (
      seen.has(tile) ||
      !game.isWater(tile) ||
      game.x(tile) < region.x ||
      game.x(tile) >= region.x + region.width ||
      game.y(tile) < region.y ||
      game.y(tile) >= region.y + region.height
    )
      continue;
    seen.add(tile);
    const launch = player.canBuild(UnitType.Warship, tile);
    const launchPort =
      launch === false
        ? undefined
        : ports.find((port) => port.tile() === launch);
    if (!launchPort) continue;
    const spot = heatmap.hotspots.find((spot) => spot.tile === tile);
    sites.push({
      action: "build_unit" as const,
      type: UnitType.Warship,
      ...{ tile, x: game.x(tile), y: game.y(tile) },
      cost: Number(game.config().unitInfo(UnitType.Warship).cost(game, player)),
      upgradeId: false as const,
      context: {
        launchPortId: launchPort.id(),
        launchPortTile: launchPort.tile(),
        traffic: spot?.total ?? 0,
        eligibleTraffic: spot?.eligible ?? 0,
      },
    });
    if (sites.length > 12) break;
  }
  return { sites: sites.slice(0, 12), truncated: sites.length > 12 };
}
