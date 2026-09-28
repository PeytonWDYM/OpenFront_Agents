import { getSpawnTiles } from "../../core/execution/Util";
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
import { MatchStats } from "./matchStats";
import { publicTradeTraffic, warshipBuildSite } from "./naval";
import { AgentEvent, AgentObservation, ObserveQuery } from "./schemas";

const buildableTypes = PlayerBuildable.types.filter(
  (type) => type !== UnitType.TransportShip,
);

/** Static samples are shared by all seats. Ownership checks use the live mirror. */
export class ObservationBuilder {
  private candidates: number[] = [];
  private coastalCandidates: number[] = [];
  private readonly stats: MatchStats;

  constructor(private game: Game) {
    this.stats = new MatchStats(game);
    for (let y = 8; y < game.height(); y += 24) {
      for (let x = 8; x < game.width(); x += 24) {
        const tile = game.ref(x, y);
        if (game.isLand(tile) && !game.isImpassable(tile))
          this.candidates.push(tile);
      }
    }
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

  observe(
    id: string,
    player: Player,
    index: number,
    query: ObserveQuery,
    events: AgentEvent[],
    attackRatio = 0.2,
  ): AgentObservation {
    const game = this.game;
    const point = (tile: number) => ({
      tile,
      x: game.x(tile),
      y: game.y(tile),
    });
    const ownerId = (tile: number) =>
      game.hasOwner(tile) ? game.owner(tile).id() : null;
    const spawn = player.spawnTile();
    const reference =
      query.x !== undefined && query.y !== undefined
        ? game.ref(
            Math.min(query.x, game.width() - 1),
            Math.min(query.y, game.height() - 1),
          )
        : (spawn ??
          this.candidates[
            Math.floor(
              (this.candidates.length * index) /
                Math.max(1, game.allPlayers().length),
            )
          ] ??
          0);
    const relevant = new Set([
      ...player.incomingAttacks().map((attack) => attack.attacker().id()),
      ...player.outgoingAttacks().map((attack) => attack.target().id()),
      ...player
        .incomingAllianceRequests()
        .map((request) => request.requestor().id()),
      ...player.allies().map((ally) => ally.id()),
    ]);
    for (const event of events.slice(-12)) {
      const other =
        event.data.otherPlayerId ??
        event.data.requestor ??
        event.data.attackerId ??
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
    const borders = [...boundary].slice(0, 12).map((tile) => ({
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
    const warship = warshipBuildSite(game, player, reference);
    if (warship) buildSites.push(warship);
    for (const tile of buildSamples) {
      for (const buildable of player.buildableUnits(tile, buildableTypes)) {
        if (buildable.canBuild === false && buildable.canUpgrade === false)
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
          type: buildable.type,
          tile:
            Nukes.has(buildable.type) ||
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
    const spawnCandidates: AgentObservation["map"]["spawnCandidates"] = [];
    if (game.inSpawnPhase() && !game.config().isRandomSpawn()) {
      const start = Math.floor(
        (this.candidates.length * index) /
          Math.max(1, game.allPlayers().length),
      );
      for (
        let offset = 0;
        offset < this.candidates.length && spawnCandidates.length < 4;
        offset++
      ) {
        const tile = this.candidates[(start + offset) % this.candidates.length];
        if (!game.hasOwner(tile) && getSpawnTiles(game, tile, true))
          spawnCandidates.push(point(tile));
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
        units: player
          .units()
          .filter((unit) => !regionalUnits || withinRegion(unit.tile()))
          .slice(0, 32)
          .map((unit) => ({
            id: unit.id(),
            type: unit.type(),
            tile: unit.tile(),
            level: unit.level(),
            canUpgrade: player.canUpgradeUnit(unit),
            underConstruction: unit.isUnderConstruction(),
          })),
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
        buildSites: buildSites.slice(0, 8),
        buildCosts: buildableTypes.map((type) => ({
          type,
          cost: Number(game.config().unitInfo(type).cost(game, player)),
        })),
      },
      events: events
        .filter((event) => event.at >= Date.now() - 60_000)
        .slice(-12),
    };
  }
}
