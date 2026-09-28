import { GoldRateTracker } from "../../client/hud/layers/lib/GoldRateTracker";
import { Game, GameMode, Player, UnitType } from "../../core/game/Game";

/** Public scoreboard data shares the native client's income-rate calculation. */
export class MatchStats {
  private readonly rates = new GoldRateTracker();
  private rateTick = -5;
  private leaderboardTick = -1;
  private players: ReturnType<MatchStats["playerRows"]> = [];

  constructor(private readonly game: Game) {}

  observe(player: Player) {
    const game = this.game;
    const tick = game.ticks();
    const landTiles = game.totalLandTiles();
    const landPercent = (tiles: number) =>
      landTiles > 0 ? (tiles / landTiles) * 100 : 0;
    if (tick >= this.rateTick + 5) {
      for (const other of game.allPlayers()) {
        this.rates.record(
          other.smallID(),
          {
            income: Number(other.goldEarned()),
            trade: Number(other.tradeGold()),
            train: Number(other.trainGold()),
            piracy: Number(other.piracyGold()),
          },
          tick,
        );
      }
      this.rateTick = tick;
    }
    if (this.leaderboardTick !== tick) {
      this.players = this.playerRows(landPercent);
      this.leaderboardTick = tick;
    }
    const elapsedSeconds = game.elapsedGameSeconds();
    const requiredLandPercent = game
      .config()
      .percentageTilesOwnedToWin(elapsedSeconds);
    const requiredTiles =
      Math.floor((landTiles * requiredLandPercent) / 100) + 1;
    const team =
      game.config().gameConfig().gameMode === GameMode.Team
        ? player.team()
        : null;
    const tilesOwned =
      team === null ? player.numTilesOwned() : game.teamTilesOwned(team);
    const timer = game.config().gameConfig().maxTimerValue;
    return {
      victory: {
        mode: game.config().gameConfig().gameMode,
        side: team ?? player.id(),
        requiredLandPercent,
        landTiles,
        requiredTiles,
        tilesOwned,
        landPercent: landPercent(tilesOwned),
        tilesRemaining: Math.max(0, requiredTiles - tilesOwned),
        elapsedSeconds,
        timerRemainingSeconds:
          timer === null || timer === undefined
            ? null
            : Math.max(0, timer * 60 - elapsedSeconds),
        hardLimitRemainingSeconds: Math.max(0, 170 * 60 - elapsedSeconds),
        overtime: game.config().overtimeConfig(),
      },
      leaderboard: {
        selfRank:
          this.players.find((row) => row.playerId === player.id())?.rank ??
          null,
        players: this.players,
        teams: game
          .teams()
          .map((team) => ({
            team,
            tiles: game.teamTilesOwned(team),
            landPercent: landPercent(game.teamTilesOwned(team)),
          }))
          .sort((a, b) => b.tiles - a.tiles),
      },
    };
  }

  private playerRows(landPercent: (tiles: number) => number) {
    return this.game
      .allPlayers()
      .filter((player) => player.isAlive())
      .sort(
        (a, b) =>
          b.numTilesOwned() - a.numTilesOwned() || a.smallID() - b.smallID(),
      )
      .map((player, index) => ({
        rank: index + 1,
        playerId: player.id(),
        smallId: player.smallID(),
        name: player.name(),
        playerType: player.type(),
        clanTag: player.clanTag(),
        team: player.team(),
        tiles: player.numTilesOwned(),
        landPercent: landPercent(player.numTilesOwned()),
        gold: Number(player.gold()),
        troops: Math.floor(player.troops()),
        maxTroops: Math.floor(this.game.config().maxTroops(player)),
        goldIncomePerMinute: Math.round(
          this.rates.goldIncomePerMin(player.smallID()),
        ),
        shipTradeGoldPerMinute: Math.round(
          this.rates.shipTradeGoldPerMin(player.smallID()),
        ),
        trainTradeGoldPerMinute: Math.round(
          this.rates.trainTradeGoldPerMin(player.smallID()),
        ),
        piracyGoldPerMinute: Math.round(
          this.rates.piracyGoldPerMin(player.smallID()),
        ),
        allies: player.allies().length,
        betrayals: player.betrayals(),
        unitLevels: Object.fromEntries(
          [
            UnitType.City,
            UnitType.Port,
            UnitType.Factory,
            UnitType.MissileSilo,
            UnitType.SAMLauncher,
            UnitType.Warship,
          ].map((type) => [
            type,
            player
              .units(type)
              .filter((unit) => !unit.isUnderConstruction())
              .reduce((sum, unit) => sum + unit.level(), 0),
          ]),
        ),
      }));
  }
}

export type AgentMatchStats = ReturnType<MatchStats["observe"]>;
