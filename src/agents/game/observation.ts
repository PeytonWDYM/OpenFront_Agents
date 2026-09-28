import { getSpawnTiles } from "../../core/execution/Util";
import {
  AllPlayers,
  Game,
  Player,
  PlayerBuildable,
} from "../../core/game/Game";
import { AgentEvent, AgentObservation, ObserveQuery } from "./schemas";

/** Static samples are shared by all seats. Ownership checks use the live mirror. */
export class ObservationBuilder {
  private candidates: number[] = [];

  constructor(private game: Game) {
    for (let y = 8; y < game.height(); y += 24) {
      for (let x = 8; x < game.width(); x += 24) {
        const tile = game.ref(x, y);
        if (game.isLand(tile) && !game.isImpassable(tile))
          this.candidates.push(tile);
      }
    }
  }

  observe(
    id: string,
    player: Player,
    index: number,
    query: ObserveQuery,
    events: AgentEvent[],
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
    const rivals = game
      .allPlayers()
      .filter((rival) => rival.id() !== player.id());
    rivals.sort(
      (a, b) =>
        game.euclideanDistSquared(reference, a.spawnTile() ?? 0) -
        game.euclideanDistSquared(reference, b.spawnTile() ?? 0),
    );
    const visibleRivals = rivals.slice(0, 12);
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
    for (const tile of buildSamples) {
      for (const buildable of player.buildableUnits(tile)) {
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
          tile: buildable.canBuild === false ? tile : buildable.canBuild,
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
    const stride = Math.max(1, Math.ceil(Math.max(width, height) / 8));
    const cells: AgentObservation["map"]["cells"] = [];
    if (Object.keys(query).length > 0) {
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
    if (!game.inSpawnPhase() && player.hasSpawned()) {
      const targets = [
        ...cells.map((cell) => cell.tile),
        ...visibleRivals
          .map((rival) => rival.spawnTile())
          .filter((tile): tile is number => tile !== undefined),
      ];
      for (const tile of targets.slice(0, 16)) {
        if (
          ownerId(tile) === player.id() ||
          !game.isLand(tile) ||
          game.isImpassable(tile)
        )
          continue;
        const launchTile = player.bestTransportShipSpawn(tile);
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
      gameId: "",
      tick: game.ticks(),
      spawnPhase: game.inSpawnPhase(),
      self: {
        id,
        playerId: player.id(),
        alive: game.inSpawnPhase() || player.isAlive(),
        spawned: player.hasSpawned(),
        troops: Math.floor(player.troops()),
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
        name: rival.name(),
        alive: rival.isAlive(),
        tiles: rival.numTilesOwned(),
        allied: player.isAlliedWith(rival),
        sharesBorder: player.sharesBorderWith(rival),
        canAttack: player.canAttackPlayer(rival),
        canRequestAlliance: player.canSendAllianceRequest(rival),
        canSendQuickChat: player.canSendQuickChat(rival),
        canSendEmoji: player.canSendEmoji(rival),
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
        buildSites: buildSites.slice(0, 8),
        buildCosts: PlayerBuildable.types.map((type) => ({
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
