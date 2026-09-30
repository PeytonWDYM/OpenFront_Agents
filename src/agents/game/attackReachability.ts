import { Game, Player, TerraNullius, UnitType } from "../../core/game/Game";
import { targetTransportTile } from "../../core/game/TransportShipUtils";

/** Match the frontier seeded by native AttackExecution, across all owned borders. */
export function landAttackBorders(game: Game, player: Player) {
  const targets = new Map<number, Set<number>>();
  for (const tile of player.borderTiles()) {
    for (const neighbor of game.neighbors(tile)) {
      const owner = game.ownerID(neighbor);
      if (
        owner === player.smallID() ||
        !game.isLand(neighbor) ||
        game.isImpassable(neighbor)
      )
        continue;
      let tiles = targets.get(owner);
      if (!tiles) targets.set(owner, (tiles = new Set()));
      tiles.add(neighbor);
    }
  }
  return targets;
}

/** Native attacks offset the target's incoming commitments before conquest. */
export function canCounterAttack(
  player: Player,
  target: Player | TerraNullius,
) {
  return player
    .incomingAttacks()
    .some(
      (attack) =>
        attack.attacker() === target &&
        attack.isActive() &&
        attack.troops() > 0,
    );
}

/** Resolve the same landing and launch used by native TransportShipExecution. */
export function transportLanding(
  game: Game,
  player: Player,
  requestedTile: number,
) {
  const tile = targetTransportTile(game, player, requestedTile);
  if (tile === null || game.isImpassable(tile)) return;
  const launchTile = player.canBuild(UnitType.TransportShip, tile);
  if (launchTile === false) return;
  return { tile, launchTile };
}

/** Sample native boat routes without letting region cells hide rival coastlines. */
export function boatAttackTargets(
  game: Game,
  player: Player,
  rivals: Player[],
  reference: number,
  coasts: number[],
  regionTiles: number[],
) {
  const targets: { tile: number; launchTile: number }[] = [];
  if (
    game.inSpawnPhase() ||
    !player.hasSpawned() ||
    game.config().isUnitDisabled(UnitType.TransportShip) ||
    player.unitCount(UnitType.TransportShip) >= game.config().boatMaxNumber()
  )
    return targets;
  const waterComponents = new Set<number>();
  for (const tile of player.borderTiles()) {
    if (!game.isShore(tile)) continue;
    const component = game.getWaterComponent(tile);
    if (component !== null) waterComponents.add(component);
  }
  if (waterComponents.size === 0) return targets;
  const distance = (a: number, b: number) =>
    game.euclideanDistSquared(reference, a) -
    game.euclideanDistSquared(reference, b);
  // One border scan per visible rival. Only the nearest three connected
  // shores reach native path validation.
  const rivalCoasts = rivals.flatMap((rival) => {
    if (!player.canAttackPlayer(rival)) return [];
    const nearest: number[] = [];
    for (const tile of rival.borderTiles()) {
      if (!game.isShore(tile) || game.isImpassable(tile)) continue;
      const component = game.getWaterComponent(tile);
      if (component === null || !waterComponents.has(component)) continue;
      nearest.push(tile);
      nearest.sort(distance);
      if (nearest.length > 3) nearest.pop();
    }
    return nearest;
  });
  const nearbyCoasts = coasts
    .filter((tile) => game.owner(tile) !== player)
    .sort(distance)
    .slice(0, 24);
  const candidates = new Set([
    ...rivalCoasts,
    ...[...nearbyCoasts, ...regionTiles].slice(0, 40),
  ]);
  const hintedRivals = new Set<number>();
  for (const requestedTile of candidates) {
    const owner = game.owner(requestedTile);
    if (
      owner === player ||
      !game.isLand(requestedTile) ||
      game.isImpassable(requestedTile) ||
      hintedRivals.has(owner.smallID())
    )
      continue;
    const landing = transportLanding(game, player, requestedTile);
    if (!landing || targets.some((target) => target.tile === landing.tile))
      continue;
    targets.push(landing);
    if (owner.isPlayer()) hintedRivals.add(owner.smallID());
    if (targets.length >= 4) break;
  }
  return targets;
}
