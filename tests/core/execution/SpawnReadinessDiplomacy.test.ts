// Failure cases: readiness waiting consumes early alliance/greeting windows,
// increases donation costs, or permits requests queued during spawn selection.
import { DonateGoldExecution } from "../../../src/core/execution/DonateGoldExecution";
import { NationAllianceBehavior } from "../../../src/core/execution/nation/NationAllianceBehavior";
import { NationEmojiBehavior } from "../../../src/core/execution/nation/NationEmojiBehavior";
import {
  Difficulty,
  GameType,
  PlayerInfo,
  PlayerType,
  Relation,
} from "../../../src/core/game/Game";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { PseudoRandom } from "../../../src/core/PseudoRandom";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

async function startedGame(
  difficulty: Difficulty,
  extraWait: number,
  readiness = true,
  gameplayTicks = 2,
) {
  const game = await setup(
    "plains",
    {
      difficulty,
      gameType: GameType.Private,
      ...(readiness ? { spawnReadyClientIDs: ["human001"] } : {}),
    },
    [
      new PlayerInfo("Nation", PlayerType.Nation, null, "nation"),
      new PlayerInfo("Human", PlayerType.Human, "human001", "human"),
    ],
    undefined,
    undefined,
    false,
  );
  executeTicks(game, game.config().numSpawnPhaseTurns() + 1 + extraWait);
  game.endSpawnPhase();
  executeTicks(game, gameplayTicks);
  const nation = game.player("nation");
  const human = game.player("human");
  nation.conquer(game.ref(20, 20));
  human.conquer(game.ref(21, 20));
  nation.setTroops(100_000);
  human.setTroops(1);
  return { game, nation, human };
}

describe("native diplomacy after agent spawn readiness", () => {
  test.each(Object.values(Difficulty))(
    "%s keeps its seeded early alliance decisions",
    async (difficulty) => {
      async function decisions(wait: number) {
        const { game, nation, human } = await startedGame(difficulty, wait);
        return Array.from({ length: 16 }, (_, seed) => {
          const random = new PseudoRandom(seed);
          const behavior = new NationAllianceBehavior(
            random,
            game,
            nation,
            new NationEmojiBehavior(random, game, nation),
          );
          const request = human.createAllianceRequest(nation)!;
          behavior.handleAllianceRequests();
          const status = request.status();
          nation.removeAllAlliances();
          return status;
        });
      }
      const immediate = await decisions(0);
      expect(immediate).toContain("accepted");
      expect(await decisions(8_000)).toEqual(immediate);
    },
  );

  test("rejects requests created at the actual delayed spawn deadline", async () => {
    const { game, nation, human } = await startedGame(
      Difficulty.Easy,
      8_000,
      true,
      0,
    );
    nation.updateRelation(human, 100);
    const request = human.createAllianceRequest(nation)!;
    const random = new PseudoRandom(46);
    const behavior = new NationAllianceBehavior(
      random,
      game,
      nation,
      new NationEmojiBehavior(random, game, nation),
    );
    behavior.handleAllianceRequests();
    expect(request.status()).toBe("rejected");
    executeTicks(game, 1);
    const laterRequest = human.createAllianceRequest(nation)!;
    behavior.handleAllianceRequests();
    expect(laterRequest.status()).toBe("accepted");
  });

  test("donations keep the ordinary game's relation value after waiting", async () => {
    async function donation(wait: number, readiness: boolean) {
      const { game, nation, human } = await startedGame(
        Difficulty.Hard,
        wait,
        readiness,
      );
      human.createAllianceRequest(nation)!.accept();
      human.addGold(250_000n);
      game.addExecution(new DonateGoldExecution(human, nation.id(), 250_000));
      executeTicks(game, 2);
      return nation.relation(human);
    }
    const ordinary = await donation(0, false);
    expect(ordinary).toBe(Relation.Friendly);
    expect(await donation(8_000, true)).toBe(ordinary);
  });

  test("native nations can still greet neighboring humans after waiting", async () => {
    async function greets(wait: number) {
      const { game, nation } = await startedGame(Difficulty.Easy, wait);
      for (let seed = 0; seed < 512; seed++) {
        const random = new PseudoRandom(seed);
        new NationEmojiBehavior(random, game, nation).maybeSendCasualEmoji();
      }
      game.executeNextTick();
      return game
        .executeNextTick()
        [GameUpdateType.Emoji].some((event) => event.emoji.message === "👋");
    }
    expect(await greets(0)).toBe(true);
    expect(await greets(8_000)).toBe(true);
  });
});
