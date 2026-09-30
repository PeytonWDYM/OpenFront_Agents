import { getSpawnTiles } from "../../core/execution/Util";
import type { Game, Player, PlayerType } from "../../core/game/Game";

export type SpawnSite = {
  tile: number;
  x: number;
  y: number;
  canSpawn: true;
  freeLandNearby: number;
  nearbyRadius: number;
  /** Manhattan tile distance to coastal land, including lakes. Null on waterless maps. */
  coastDistance: number | null;
  nearestPlacedPlayer: {
    playerId: string;
    name: string;
    playerType: PlayerType;
    distance: number;
  } | null;
};
type RegionQuery = { x?: number; y?: number; width?: number; height?: number };

/** Geographic suggestions, not a tactical ranking or an exhaustive legal list. */
export class SpawnSiteFinder {
  private readonly candidates: number[] = [];
  private readonly coastDistances: Int32Array;

  constructor(private readonly game: Game) {
    const width = game.width();
    const height = game.height();
    const stride = Math.max(1, Math.ceil(Math.max(width, height) / 100));
    this.coastDistances = new Int32Array(width * height).fill(width + height);
    let hasWater = false;
    game.forEachTile((tile) => {
      if (game.isWater(tile)) {
        this.coastDistances[tile] = 0;
        hasWater = true;
      }
      if (
        game.x(tile) % stride === 0 &&
        game.y(tile) % stride === 0 &&
        game.isLand(tile) &&
        !game.isImpassable(tile)
      )
        this.candidates.push(tile);
    });
    // Two Manhattan distance passes give each sample an exact distance to water.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = game.ref(x, y);
        if (x > 0)
          this.coastDistances[tile] = Math.min(
            this.coastDistances[tile],
            this.coastDistances[tile - 1] + 1,
          );
        if (y > 0)
          this.coastDistances[tile] = Math.min(
            this.coastDistances[tile],
            this.coastDistances[tile - width] + 1,
          );
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const tile = game.ref(x, y);
        if (x < width - 1)
          this.coastDistances[tile] = Math.min(
            this.coastDistances[tile],
            this.coastDistances[tile + 1] + 1,
          );
        if (y < height - 1)
          this.coastDistances[tile] = Math.min(
            this.coastDistances[tile],
            this.coastDistances[tile + width] + 1,
          );
      }
    }
    if (!hasWater) this.coastDistances.fill(-1);
  }

  find(player: Player, index: number, query: RegionQuery = {}): SpawnSite[] {
    const game = this.game;
    if (!game.inSpawnPhase() || game.config().isRandomSpawn()) return [];
    const x = Math.min(query.x ?? 0, game.width() - 1);
    const y = Math.min(query.y ?? 0, game.height() - 1);
    const width = Math.min(
      query.width ?? (query.x === undefined ? game.width() : 64),
      game.width() - x,
    );
    const height = Math.min(
      query.height ?? (query.y === undefined ? game.height() : 64),
      game.height() - y,
    );
    const cells: number[][] = Array.from({ length: 12 }, () => []);
    for (const tile of this.candidates) {
      const tx = game.x(tile);
      const ty = game.y(tile);
      if (tx < x || ty < y || tx >= x + width || ty >= y + height) continue;
      const col = Math.min(3, Math.floor(((tx - x) * 4) / width));
      const row = Math.min(2, Math.floor(((ty - y) * 3) / height));
      cells[row * 4 + col].push(tile);
    }
    const sites: SpawnSite[] = [];
    for (let offset = 0; offset < cells.length; offset++) {
      const cell = (offset + index) % cells.length;
      // Each seat receives its own anchor in every cell. This does not restrict its choice.
      const anchorX = 0.15 + (0.7 * ((index * 73 + cell * 29) % 401)) / 400;
      const anchorY = 0.15 + (0.7 * ((index * 151 + cell * 43) % 401)) / 400;
      const cx = x + (((cell % 4) + anchorX) * width) / 4;
      const cy = y + ((Math.floor(cell / 4) + anchorY) * height) / 3;
      const dist = (tile: number) =>
        (game.x(tile) - cx) ** 2 + (game.y(tile) - cy) ** 2;
      cells[cell].sort((a, b) => dist(a) - dist(b) || a - b);
      const tile = cells[cell].find(
        (candidate) =>
          !game.hasOwner(candidate) &&
          getSpawnTiles(game, candidate, false).length > 0,
      );
      if (tile === undefined) continue;
      let freeLandNearby = 0;
      game.circleSearch(tile, 24, (nearby) => {
        if (
          game.isLand(nearby) &&
          !game.isImpassable(nearby) &&
          !game.hasOwner(nearby)
        )
          freeLandNearby++;
        return true;
      });
      let nearestPlacedPlayer: SpawnSite["nearestPlacedPlayer"] = null;
      for (const other of game.allPlayers()) {
        const spawn = other.spawnTile();
        if (other.id() === player.id() || spawn === undefined) continue;
        const distance = game.manhattanDist(tile, spawn);
        if (
          nearestPlacedPlayer === null ||
          distance < nearestPlacedPlayer.distance
        ) {
          nearestPlacedPlayer = {
            playerId: other.id(),
            name: other.name(),
            playerType: other.type(),
            distance,
          };
        }
      }
      const waterDistance = this.coastDistances[tile];
      sites.push({
        tile,
        x: game.x(tile),
        y: game.y(tile),
        canSpawn: true,
        freeLandNearby,
        nearbyRadius: 24,
        coastDistance:
          waterDistance < 0 ? null : Math.max(0, waterDistance - 1),
        nearestPlacedPlayer,
      });
    }
    return sites;
  }
}
