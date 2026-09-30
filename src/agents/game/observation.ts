import {
  AllPlayers,
  Game,
  Nukes,
  Player,
  PlayerBuildable,
  PlayerType,
  Structures,
  UnitType,
} from "../../core/game/Game";
import { requestedBuildSites } from "./buildSites";
import { selectAgentEvents } from "./events";
import { MatchStats } from "./matchStats";
import { militaryIntel } from "./militaryIntel";
import { publicTradeTraffic, warshipBuildSite } from "./naval";
import { ownedUnitView } from "./ownedUnitView";
import { AgentEvent, AgentObservation, ObserveQuery } from "./schemas";
import { SpawnSiteFinder } from "./spawnSites";
import { requestedWarshipBuildSites } from "./tradeHeatmap";

const buildableTypes = PlayerBuildable.types.filter(
  (type) => type !== UnitType.TransportShip,
);

/** Static samples are shared by all seats. Ownership checks use the live mirror. */
export class ObservationBuilder {
  private coastalCandidates: number[] = [];
  private readonly stats: MatchStats;
  private readonly spawnSites: SpawnSiteFinder;

  constructor(private game: Game) {
    this.stats = new MatchStats(game);
    this.spawnSites = new SpawnSiteFinder(game);
    const coastalBuckets = new Set<number>();
    const columns = Math.ceil(game.width() / 24);
    for (let tile = 0; tile < game.width() * game.height(); tile++) {
      if (!game.isLand(tile) || !game.isShore(tile) || game.isImpassable(tile))
        continue;
      const bucket =
        Math.floor(game.x(tile) / 24) + columns * Math.floor(game.y(tile) / 24);
      if (coastalBuckets.has(bucket)) continue;
      coastalBuckets.add(bucket);
      this.coastalCandidates.push(tile);
    }
  }

  recordIncome(): void {
    this.stats.recordIncome();
  }

  observe(
    id: string,
    player: Player,
    index: number,
    query: ObserveQuery,
    events: AgentEvent[],
    attackRatio = 0.2,
    buildStreak = 0,
  ): AgentObservation {
    const game = this.game;
    const visibleEvents = selectAgentEvents(
      events.filter((event) => event.at >= Date.now() - 60_000),
      query.sections?.includes("events") ? 64 : 24,
      player.id(),
    );
    const point = (tile: number) => ({
      tile,
      x: game.x(tile),
      y: game.y(tile),
    });
    const ownerId = (tile: number) =>
      game.hasOwner(tile) ? game.owner(tile).id() : null;
    const spawn = player.spawnTile();
    const spawnCandidates = this.spawnSites.find(player, index, query);
    const reference =
      query.x !== undefined && query.y !== undefined
        ? game.ref(
            Math.min(query.x, game.width() - 1),
            Math.min(query.y, game.height() - 1),
          )
        : (spawn ?? spawnCandidates[0]?.tile ?? 0);
    const relevant = new Set([
      ...player.incomingAttacks().map((attack) => attack.attacker().id()),
      ...player.outgoingAttacks().map((attack) => attack.target().id()),
      ...player
        .incomingAllianceRequests()
        .map((request) => request.requestor().id()),
      ...player.allies().map((ally) => ally.id()),
    ]);
    for (const event of visibleEvents) {
      const other =
        event.data.otherPlayerId ??
        event.data.requestor ??
        event.data.attackerId ??
        event.data.captorId ??
        event.data.sender;
      if (typeof other === "string") relevant.add(other);
    }
    if (
      query.x !== undefined &&
      query.y !== undefined &&
      game.hasOwner(reference)
    )
      relevant.add(game.owner(reference).id());
    const sharedBorders = new Set<number>();
    for (const tile of player.borderTiles()) {
      for (const neighbor of game.neighbors(tile))
        sharedBorders.add(game.ownerID(neighbor));
    }
    const priority = (rival: Player) =>
      relevant.has(rival.id()) ? 0 : sharedBorders.has(rival.smallID()) ? 1 : 2;
    const rivals = game
      .allPlayers()
      .filter((rival) => rival.id() !== player.id() && rival.isAlive());
    rivals.sort(
      (a, b) =>
        priority(a) - priority(b) ||
        game.euclideanDistSquared(reference, a.spawnTile() ?? 0) -
          game.euclideanDistSquared(reference, b.spawnTile() ?? 0),
    );
    const visibleRivals = rivals.filter(
      (rival, index) =>
        relevant.has(rival.id()) ||
        sharedBorders.has(rival.smallID()) ||
        index < 12,
    );
    const sampleBorders: number[] = [];
    for (const tile of player.borderTiles()) {
      sampleBorders.push(tile);
      if (sampleBorders.length >= 48) break;
    }
    const boundary = new Set<number>();
    for (const tile of sampleBorders) {
      for (const neighbor of game.neighbors(tile)) {
        if (game.ownerID(neighbor) !== player.smallID()) boundary.add(neighbor);
      }
    }
    // Prefer actionable land borders over water so agents and the offense
    // summary see expansion targets instead of unreachable sea tiles.
    const boundaryTiles = [...boundary].sort(
      (a, b) => Number(game.isLand(b)) - Number(game.isLand(a)),
    );
    const borders = boundaryTiles.slice(0, 12).map((tile) => ({
      ...point(tile),
      ownerId: ownerId(tile),
      canAttack: player.canAttack(tile),
    }));
    const buildSamples = [...sampleBorders.slice(0, 4)];
    if (spawn !== undefined) buildSamples.unshift(spawn);
    if (query.x !== undefined && query.y !== undefined)
      buildSamples.unshift(reference);
    for (const tile of player.tiles()) {
      if (!buildSamples.includes(tile)) buildSamples.push(tile);
      if (buildSamples.length >= 12) break;
    }
    const buildSites: AgentObservation["map"]["buildSites"] = [];
    const requestedSites =
      query.buildType === undefined
        ? undefined
        : query.buildType === UnitType.Warship
          ? requestedWarshipBuildSites(game, player, query)
          : requestedBuildSites(game, player, query);
    const warship =
      query.buildType === undefined
        ? warshipBuildSite(game, player, reference)
        : undefined;
    if (warship) buildSites.push({ ...warship, action: "build_unit" });
    for (const tile of buildSamples) {
      if (requestedSites) break;
      for (const buildable of player.buildableUnits(tile, buildableTypes)) {
        if (buildable.canBuild === false && buildable.canUpgrade === false)
          continue;
        if (
          Nukes.has(buildable.type) &&
          game.ownerID(tile) === player.smallID()
        )
          continue;
        if (
          buildSites.some(
            (site) =>
              site.type === buildable.type &&
              site.upgradeId === buildable.canUpgrade,
          )
        )
          continue;
        buildSites.push({
          action:
            buildable.canUpgrade === false ? "build_unit" : "upgrade_structure",
          type: buildable.type,
          tile:
            buildable.canUpgrade !== false
              ? game.unit(buildable.canUpgrade)!.tile()
              : Nukes.has(buildable.type) ||
                  buildable.type === UnitType.Warship ||
                  buildable.canBuild === false
                ? tile
                : buildable.canBuild,
          cost: Number(buildable.cost),
          upgradeId: buildable.canUpgrade,
        });
      }
      if (buildSites.length >= 8) break;
    }
    // A legal coastal site can be absent from the small general land sample.
    if (
      !requestedSites &&
      !buildSites.some((site) => site.type === UnitType.Port)
    ) {
      const cost = Number(game.unitInfo(UnitType.Port).cost(game, player));
      if (Number(player.gold()) >= cost)
        for (const tile of player.tiles()) {
          if (!game.isShore(tile)) continue;
          const site = player.canBuild(UnitType.Port, tile);
          if (site === false) continue;
          buildSites.unshift({
            action: "build_unit",
            type: UnitType.Port,
            tile: site,
            cost,
            upgradeId: false,
          });
          break;
        }
    }
    const x = Math.min(query.x ?? game.x(reference), game.width() - 1);
    const y = Math.min(query.y ?? game.y(reference), game.height() - 1);
    const width = Math.min(query.width ?? 64, game.width() - x);
    const height = Math.min(query.height ?? 64, game.height() - y);
    const regionalUnits =
      query.sections?.includes("units") === true &&
      query.x !== undefined &&
      query.y !== undefined;
    const withinRegion = (tile: number) =>
      game.x(tile) >= x &&
      game.x(tile) < x + width &&
      game.y(tile) >= y &&
      game.y(tile) < y + height;
    const stride = Math.max(1, Math.ceil(Math.max(width, height) / 8));
    const cells: AgentObservation["map"]["cells"] = [];
    if (
      query.x !== undefined ||
      query.y !== undefined ||
      query.width !== undefined ||
      query.height !== undefined
    ) {
      for (let cy = y; cy < y + height; cy += stride) {
        for (let cx = x; cx < x + width; cx += stride) {
          const tile = game.ref(cx, cy);
          cells.push({
            ...point(tile),
            terrain: game.isImpassable(tile)
              ? "impassable"
              : game.isLand(tile)
                ? "land"
                : "water",
            ownerId: ownerId(tile),
          });
        }
      }
    }
    const boatTargets: AgentObservation["map"]["boatTargets"] = [];
    if (
      !game.inSpawnPhase() &&
      player.hasSpawned() &&
      !game.config().isUnitDisabled(UnitType.TransportShip)
    ) {
      const coasts = this.coastalCandidates
        .filter((tile) => ownerId(tile) !== player.id())
        .sort(
          (a, b) =>
            game.euclideanDistSquared(reference, a) -
            game.euclideanDistSquared(reference, b),
        )
        .slice(0, 24);
      const targets = [
        ...cells.map((cell) => cell.tile),
        ...coasts,
        ...visibleRivals
          .map((rival) => rival.spawnTile())
          .filter((tile): tile is number => tile !== undefined),
      ];
      for (const tile of [...new Set(targets)].slice(0, 40)) {
        if (
          ownerId(tile) === player.id() ||
          !game.isLand(tile) ||
          game.isImpassable(tile)
        )
          continue;
        const launchTile = player.canBuild(UnitType.TransportShip, tile);
        if (launchTile !== false)
          boatTargets.push({
            ...point(tile),
            ownerId: ownerId(tile),
            launchTile,
          });
        if (boatTargets.length >= 4) break;
      }
    }
    return {
      ...this.stats.observe(player),
      gameId: "",
      tick: game.ticks(),
      spawnPhase: game.inSpawnPhase(),
      militaryIntel: militaryIntel(game, player),
      offense: {
        attackableBorders: borders.filter((border) => border.canAttack).length,
        rivalBorders: visibleRivals.filter((rival) =>
          sharedBorders.has(rival.smallID()),
        ).length,
        readySilos: player
          .units(UnitType.MissileSilo)
          .filter(
            (silo) =>
              silo.isActive() &&
              !silo.isInCooldown() &&
              !silo.isUnderConstruction(),
          ).length,
        affordableMissiles: (
          [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV] as const
        ).filter(
          (type) =>
            player
              .units(UnitType.MissileSilo)
              .some(
                (silo) =>
                  silo.isActive() &&
                  !silo.isInCooldown() &&
                  !silo.isUnderConstruction(),
              ) &&
            Number(game.config().unitInfo(type).cost(game, player)) <=
              Number(player.gold()),
        ),
        structureCounts: Object.fromEntries(
          Structures.types.map((type) => [type, player.units(type).length]),
        ),
        buildStreak,
      },
      self: {
        id,
        playerId: player.id(),
        playerType: player.type(),
        smallId: player.smallID(),
        ...(spawn === undefined ? {} : { position: point(spawn) }),
        alive: game.inSpawnPhase() || player.isAlive(),
        spawned: player.hasSpawned(),
        troops: Math.floor(player.troops()),
        attackRatio,
        gold: Number(player.gold()),
        traitorRemainingTicks: player.getTraitorRemainingTicks(),
        maxTroops: Math.floor(game.config().maxTroops(player)),
        tiles: player.numTilesOwned(),
        canSendEmojiAllPlayers: player.canSendEmoji(AllPlayers),
        canEmbargoAll: player.canEmbargoAll(),
        allies: player
          .allies()
          .map((ally) => ally.id())
          .slice(0, 12),
        incomingAllianceRequests: player
          .incomingAllianceRequests()
          .map((request) => request.requestor().id())
          .slice(0, 12),
        outgoingAttacks: player
          .outgoingAttacks()
          .slice(0, 12)
          .map((attack) => ({
            id: attack.id(),
            targetId: attack.target().isPlayer() ? attack.target().id() : null,
            troops: Math.floor(attack.troops()),
          })),
        incomingAttacks: player
          .incomingAttacks()
          .slice(0, 12)
          .map((attack) => ({
            id: attack.id(),
            attackerId: attack.attacker().id(),
          })),
        ...ownedUnitView(
          game,
          player,
          regionalUnits ? withinRegion : undefined,
        ),
      },
      rivals: visibleRivals.map((rival) => ({
        playerId: rival.id(),
        playerType: rival.type(),
        smallId: rival.smallID(),
        ...(rival.spawnTile() === undefined
          ? {}
          : { position: point(rival.spawnTile()!) }),
        name: rival.name(),
        alive: rival.isAlive(),
        tiles: rival.numTilesOwned(),
        troops: Math.floor(rival.troops()),
        gold: Number(rival.gold()),
        maxTroops: Math.floor(game.config().maxTroops(rival)),
        allied: player.isAlliedWith(rival),
        sharesBorder: sharedBorders.has(rival.smallID()),
        canAttack:
          sharedBorders.has(rival.smallID()) && player.canAttackPlayer(rival),
        canRequestAlliance: player.canSendAllianceRequest(rival),
        canSendQuickChat: player.canSendQuickChat(rival),
        canSendEmoji: player.canSendEmoji(rival),
        communication: {
          quickChatResponse: rival.type() === PlayerType.Human,
          emojiResponse:
            rival.type() === PlayerType.Human ||
            rival.type() === PlayerType.Nation,
          allianceResponse:
            rival.type() === PlayerType.Human
              ? "player"
              : rival.type() === PlayerType.Bot
                ? "automatic"
                : "conditional",
        },
        embargoed: player.hasEmbargoAgainst(rival),
        allianceExpiresAt: player.allianceInfo(rival)?.expiresAt,
        canExtendAlliance: player.allianceInfo(rival)?.canExtend ?? false,
        canDonateGold: player.canDonateGold(rival),
        canDonateTroops: player.canDonateTroops(rival),
      })),
      map: {
        width: game.width(),
        height: game.height(),
        region: { x, y, width, height, stride },
        cells,
        spawnCandidates,
        borders,
        boatTargets,
        tradeTraffic: publicTradeTraffic(
          game,
          player,
          reference,
          query.x !== undefined && query.y !== undefined
            ? withinRegion
            : undefined,
        ),
        ...(regionalUnits
          ? {
              publicStructures: game
                .units(Structures.types)
                .filter(
                  (unit) =>
                    unit.owner().id() !== player.id() &&
                    withinRegion(unit.tile()),
                )
                .slice(0, 32)
                .map((unit) => ({
                  id: unit.id(),
                  type: unit.type(),
                  tile: unit.tile(),
                  level: unit.level(),
                  ownerId: unit.owner().id(),
                })),
            }
          : {}),
        buildSites: (requestedSites?.sites ?? buildSites.slice(0, 8)).map(
          (site) => ({ ...site, ...point(site.tile) }),
        ),
        buildSitesAtTick: game.ticks(),
        ...(requestedSites
          ? { buildSitesTruncated: requestedSites.truncated }
          : {}),
        ...(query.buildType === UnitType.Port
          ? {
              portPlacement: {
                terrain: "owned coastal land" as const,
                requiresAdjacentWater: true as const,
                minStructureDistance: game.config().structureMinDist(),
                constructionTicks:
                  game.unitInfo(UnitType.Port).constructionDuration ?? 0,
              },
            }
          : {}),
        buildCosts: buildableTypes.map((type) => ({
          type,
          cost: Number(game.config().unitInfo(type).cost(game, player)),
        })),
      },
      events: visibleEvents,
    };
  }
}
