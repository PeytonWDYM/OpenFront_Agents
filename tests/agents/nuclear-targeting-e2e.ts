// Failure cases: own silo or city tiles launch nuclear weapons, normal own-land
// builds get blocked, enemy targets fail, or previews miss own/allied structures.
// Native structure destruction uses a strict outer radius, including collateral.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { DecisionFeedback } from "../../src/agents/game/feedback";
import { assertAgentNuclearTarget } from "../../src/agents/game/nuclearTargeting";
import { buildNukePreview } from "../../src/agents/game/nukePreview";
import { Config } from "../../src/core/configuration/Config";
import { Executor } from "../../src/core/execution/ExecutionManager";
import {
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameRunner } from "../../src/core/GameRunner";
import type { ClientMessage, Turn } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";

class NativeBlastConfig extends TestConfig {
  nukeMagnitudes(type: UnitType) {
    return Config.prototype.nukeMagnitudes.call(this, type);
  }
}

const clientID = "nuclear001";
const game = await setup(
  "plains",
  { infiniteGold: true, instantBuild: true },
  [
    new PlayerInfo("Launcher", PlayerType.Human, clientID, "launcher"),
    new PlayerInfo("Ally", PlayerType.Human, "nuclear002", "ally"),
    new PlayerInfo("Enemy", PlayerType.Human, "nuclear003", "enemy"),
  ],
  undefined,
  NativeBlastConfig,
);
const self = game.player("launcher");
const ally = game.player("ally");
const enemy = game.player("enemy");
const home = game.ref(10, 50);
const target = game.ref(90, 50);
for (const [player, tile] of [
  [self, home],
  [ally, game.ref(85, 60)],
  [enemy, target],
] as const) {
  player.setSpawnTile(tile);
  player.conquer(tile);
}
for (let x = 5; x <= 30; x++) {
  for (let y = 5; y <= 30; y++) self.conquer(game.ref(x, y));
}
self.createAllianceRequest(ally)!.accept();
const silo = self.buildUnit(UnitType.MissileSilo, home, {});
const ownCityTile = game.ref(70, 50);
self.conquer(ownCityTile);
const ownCity = self.buildUnit(UnitType.City, ownCityTile, {});
ownCity.increaseLevel();
const boundaryTile = game.ref(60, 50);
self.conquer(boundaryTile);
const boundary = self.buildUnit(UnitType.DefensePost, boundaryTile, {});
const alliedFactory = ally.buildUnit(UnitType.Factory, game.ref(85, 60), {});
const enemyCity = enemy.buildUnit(UnitType.City, target, {});
const intents: Turn["intents"] = [];
const runner = new GameRunner(
  game,
  new Executor(game, "nuclearTargetingE2E", undefined),
  (update) => {
    if ("errMsg" in update) throw new Error(update.errMsg);
  },
);
const bridge = new AgentGame({ agentCount: 1, tribeCount: 0, nationCount: 0 });
Reflect.set(bridge, "runner", runner);
Reflect.set(bridge, "feedback", new DecisionFeedback(game));
Reflect.set(bridge, "attackRatios", new Map([["agent001", 0.2]]));
Reflect.set(bridge, "seats", [
  {
    id: "agent001",
    clientId: clientID,
    send(message: ClientMessage) {
      assert.equal(message.type, "intent");
      if (message.type === "intent")
        intents.push({ ...message.intent, clientID });
    },
  },
]);
const advance = (ticks: number) => {
  for (let index = 0; index < ticks; index++) {
    runner.addTurn({ turnNumber: game.ticks(), intents: intents.splice(0) });
    assert.ok(runner.executeNextTick());
  }
};

// Native FFA permits these targets. The agent bridge must stop them before send.
for (const unit of [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV]) {
  assert.notEqual(self.canBuild(unit, home), false);
  assert.doesNotThrow(() => assertAgentNuclearTarget(game, self, unit, target));
  for (const tile of [home, ownCityTile]) {
    await assert.rejects(
      bridge.act("agent001", { type: "build_unit", unit, tile }),
      /enemy TARGET tile.*own silo/,
    );
    assert.equal(intents.length, 0);
  }
}
assert.doesNotThrow(() =>
  assertAgentNuclearTarget(game, self, UnitType.AtomBomb, game.ref(88, 52)),
);
assert.doesNotThrow(() =>
  assertAgentNuclearTarget(game, self, UnitType.City, home),
);
await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.City,
  tile: game.ref(15, 15),
});
advance(3);
assert.equal(self.units(UnitType.City).length, 2);

const preview = buildNukePreview(game, self, {
  type: UnitType.AtomBomb,
  tile: target,
});
assert.equal(preview.targetingSelf, false);
assert.equal(preview.source?.unitId, silo.id());
assert.deepEqual(
  preview.ownStructuresAtRisk.map((unit) => unit.unitId),
  [ownCity.id()],
);
assert.equal(preview.ownStructuresAtRisk[0].type, UnitType.City);
assert.equal(preview.ownStructuresAtRisk[0].level, 2);
assert.equal(preview.ownStructuresAtRisk[0].tile, ownCityTile);
assert.deepEqual(
  preview.friendlyStructuresAtRisk.map((unit) => unit.unitId),
  [alliedFactory.id()],
);
assert.equal(preview.friendlyStructuresAtRisk[0].playerId, ally.id());
const ownPreview = buildNukePreview(game, self, {
  type: UnitType.AtomBomb,
  tile: home,
});
assert.equal(ownPreview.targetingSelf, true);
assert.equal(ownPreview.canBuild, false);

// An enemy destination still reaches the native execution. Its source is the silo.
await bridge.act("agent001", {
  type: "build_unit",
  unit: UnitType.AtomBomb,
  tile: target,
});
advance(3);
const missile = self.units(UnitType.AtomBomb)[0];
assert.ok(missile);
assert.equal(missile.targetTile(), target);
advance(500);
assert.equal(enemyCity.isActive(), false);
assert.equal(ownCity.isActive(), false);
assert.equal(alliedFactory.isActive(), false);
assert.equal(boundary.isActive(), true);
assert.equal(silo.isActive(), true);

const teamGame = await setup(
  "plains",
  {
    gameMode: GameMode.Team,
    playerTeams: 2,
    infiniteGold: true,
    instantBuild: true,
  },
  [
    new PlayerInfo(
      "Launcher",
      PlayerType.Human,
      "team001",
      "team-launcher",
      false,
      "A",
    ),
    new PlayerInfo(
      "Teammate",
      PlayerType.Human,
      "team002",
      "teammate",
      false,
      "A",
    ),
    new PlayerInfo(
      "Enemy",
      PlayerType.Human,
      "team003",
      "team-enemy",
      false,
      "B",
    ),
  ],
  undefined,
  NativeBlastConfig,
);
const teamLauncher = teamGame.player("team-launcher");
const teammate = teamGame.player("teammate");
const teamEnemy = teamGame.player("team-enemy");
for (const [player, tile] of [
  [teamLauncher, home],
  [teammate, game.ref(80, 50)],
  [teamEnemy, target],
] as const) {
  player.setSpawnTile(tile);
  player.conquer(tile);
}
teamLauncher.buildUnit(UnitType.MissileSilo, home, {});
const teammateCity = teammate.buildUnit(UnitType.City, game.ref(80, 50), {});
const teamPreview = buildNukePreview(teamGame, teamLauncher, {
  type: UnitType.AtomBomb,
  tile: target,
});
assert.equal(teamLauncher.isOnSameTeam(teammate), true);
assert.deepEqual(teamPreview.ownStructuresAtRisk, []);
assert.deepEqual(
  teamPreview.friendlyStructuresAtRisk.map((unit) => unit.unitId),
  [teammateCity.id()],
);
assert.equal(teamPreview.canBuild, false);
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/nuclear-targeting-e2e.json",
  JSON.stringify(
    {
      passed: true,
      inferenceRequests: 0,
      selfTargetRejects: 6,
      normalOwnLandBuildExecuted: true,
      enemyTargetExecuted: true,
      exactOuterBoundarySurvived: true,
      teammateRiskListedAndNativeLaunchBlocked: true,
      ownPreview: {
        targetingSelf: ownPreview.targetingSelf,
        canBuild: ownPreview.canBuild,
      },
      ownStructuresAtRisk: preview.ownStructuresAtRisk,
      friendlyStructuresAtRisk: preview.friendlyStructuresAtRisk,
      nativeDestroyedUnitIds: [
        ownCity.id(),
        alliedFactory.id(),
        enemyCity.id(),
      ],
    },
    null,
    2,
  ),
);
console.log(
  "Nuclear targeting E2E passed. Artifact: .agent-arena/nuclear-targeting-e2e.json",
);
