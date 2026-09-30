// Failure cases: a river attack is accepted as a land attack, a sampled border
// hides legal expansion, stale ownership or diplomacy permits an attack, an
// inland boat hint hides the actual landing, region samples hide rival shores,
// a native landing attack cannot receive reinforcements, or a native
// counterattack cannot cancel enemy troops after the land border is lost.
// Twelve allied border representatives must not hide legal neutral expansion.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { assertAgentAction } from "../../src/agents/game/actionLegality";
import { projectDecisionObservation } from "../../src/agents/game/decision";
import { ObservationBuilder } from "../../src/agents/game/observation";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { TransportShipExecution } from "../../src/core/execution/TransportShipExecution";
import { PlayerType, UnitType } from "../../src/core/game/Game";
import { targetTransportTile } from "../../src/core/game/TransportShipUtils";
import { playerInfo, setup } from "../util/Setup";

const results: {
  name: string;
  result: string;
  evidence?: Record<string, unknown>;
  error?: string;
}[] = [];
async function check(
  name: string,
  run: () => Promise<Record<string, unknown> | void>,
) {
  try {
    const evidence = await run();
    results.push({ name, result: "PASS", ...(evidence ? { evidence } : {}) });
  } catch (error) {
    results.push({ name, result: "FAIL", error: String(error) });
  }
}

async function riverGame() {
  const game = await setup(
    "plains",
    { waterNukes: true, disableNavMesh: false },
    [
      playerInfo("Self", PlayerType.Human),
      playerInfo("Rival", PlayerType.Human),
    ],
  );
  for (let y = 0; y < game.height(); y++)
    for (let x = 30; x < 32; x++) game.queueWaterConversion(game.ref(x, y));
  for (let tick = 0; tick < 21; tick++) game.executeNextTick();
  const self = game.player("Self");
  const rival = game.player("Rival");
  for (let y = 20; y < 40; y++) {
    for (let x = 20; x < 30; x++) self.conquer(game.ref(x, y));
    for (let x = 32; x < 62; x++) rival.conquer(game.ref(x, y));
  }
  self.setSpawnTile(game.ref(25, 30));
  rival.setSpawnTile(game.ref(50, 30));
  self.setTroops(100_000);
  rival.setTroops(10_000);
  return { game, self, rival, builder: new ObservationBuilder(game) };
}

await check(
  "river attacks fail before submission while boats remain available",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    const observation = builder.observe("self", self, 0, {}, []);
    const row = observation.rivals.find((row) => row.playerId === rival.id())!;
    assert.equal(row.sharesBorder, false);
    assert.equal(row.canAttack, false);
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "attack",
          targetID: rival.id(),
          troops: 10_000,
        }),
      /no passable land border.*boat/i,
    );
    const native = new AttackExecution(10_000, self, rival.id());
    native.init(game, game.ticks());
    native.tick(game.ticks());
    assert.equal(
      native.isActive(),
      false,
      "The rejected land intent would retreat without conquest",
    );
    assert.equal(rival.numTilesOwned(), 600);
    const hint = observation.map.boatTargets.find(
      (hint) => hint.ownerId === rival.id(),
    )!;
    assert.ok(hint, "The rival coastline remains visible");
    assert.equal(game.isShore(hint.tile), true);
    assert.equal(targetTransportTile(game, self, hint.tile), hint.tile);
    assert.equal(
      self.canBuild(UnitType.TransportShip, hint.tile),
      hint.launchTile,
    );
    assert.doesNotThrow(() =>
      assertAgentAction(game, self, {
        type: "boat",
        dst: hint.tile,
        troops: 10_000,
      }),
    );
    return {
      tick: game.ticks(),
      sharesBorder: row.sharesBorder,
      canAttack: row.canAttack,
      boatTarget: hint,
      rejectedNativeAttackRetreated: !native.isActive(),
      rivalTilesAfterRejectedNativeAttack: rival.numTilesOwned(),
    };
  },
);

await check(
  "boat hints expose native landing and survive a full region sample",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    const observation = builder.observe(
      "self",
      self,
      0,
      { x: 45, y: 20, width: 40, height: 40 },
      [],
    );
    assert.ok(observation.map.cells.length > 40);
    const hint = observation.map.boatTargets.find(
      (hint) => hint.ownerId === rival.id(),
    )!;
    assert.ok(hint);
    assert.equal(
      game.isShore(hint.tile),
      true,
      "Hint tile is the resolved landing, not an inland request",
    );
    assert.equal(targetTransportTile(game, self, hint.tile), hint.tile);
    const decision = projectDecisionObservation(observation);
    const row = decision.rivals!.find((row) => row.playerId === rival.id())!;
    assert.deepEqual(row.boatTarget, {
      tile: hint.tile,
      launchTile: hint.launchTile,
    });
    const boat = new TransportShipExecution(self, hint.tile, 10_000);
    game.addExecution(boat);
    for (
      let tick = 0;
      tick < 200 && !self.units(UnitType.TransportShip).length;
      tick++
    )
      game.executeNextTick();
    const transport = self.units(UnitType.TransportShip)[0];
    assert.equal(transport.targetTile(), hint.tile);
    for (let tick = 0; tick < 200 && game.owner(hint.tile) !== self; tick++)
      game.executeNextTick();
    assert.equal(
      game.owner(hint.tile),
      self,
      "Native boat reaches and conquers the advertised landing",
    );
    game.executeNextTick();
    const landingAttack = self
      .outgoingAttacks()
      .find((attack) => attack.sourceTile() === hint.tile)!;
    assert.ok(landingAttack);
    const afterLanding = builder
      .observe("self", self, 0, {}, [])
      .rivals.find((row) => row.playerId === rival.id())!;
    assert.equal(afterLanding.canReinforceAttack, true);
    assert.equal(
      projectDecisionObservation(
        builder.observe("self", self, 0, {}, []),
      ).rivals!.find((row) => row.playerId === rival.id())!.canReinforceAttack,
      true,
    );
    const before = landingAttack.troops();
    assert.doesNotThrow(() =>
      assertAgentAction(game, self, {
        type: "attack",
        targetID: rival.id(),
        troops: 5_000,
      }),
    );
    const reinforcement = new AttackExecution(5_000, self, rival.id());
    reinforcement.init(game, game.ticks());
    assert.equal(landingAttack.isActive(), false);
    assert.equal(
      self
        .outgoingAttacks()
        .find((attack) => attack.target() === rival)!
        .troops(),
      before + 5_000,
    );
    return {
      hint,
      transportId: transport.id(),
      arrivalTick: game.ticks(),
      landingOwner: game.owner(hint.tile).id(),
      sourceTile: landingAttack.sourceTile(),
      landingAttackId: landingAttack.id(),
      canReinforceAttack: afterLanding.canReinforceAttack,
      reinforcementTroops: 5_000,
      beforeTroops: before,
      mergedTroops: self
        .outgoingAttacks()
        .find((attack) => attack.target() === rival)!
        .troops(),
    };
  },
);

await check(
  "current land borders and neutral counts use the full territory",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    self.conquer(game.ref(32, 40));
    let observation = builder.observe("self", self, 0, {}, []);
    assert.equal(
      observation.rivals.find((row) => row.playerId === rival.id())!.canAttack,
      true,
    );
    assert.equal(
      observation.rivals.find((row) => row.playerId === rival.id())!
        .sharesBorder,
      true,
    );
    assert.ok(
      observation.map.borders.some(
        (border) => border.ownerId === rival.id() && border.canAttack,
      ),
    );
    assert.doesNotThrow(() =>
      assertAgentAction(game, self, {
        type: "attack",
        targetID: rival.id(),
        troops: 5_000,
      }),
    );
    const expected = new Set<number>();
    for (const tile of self.borderTiles())
      for (const neighbor of game.neighbors(tile))
        if (
          game.owner(neighbor) !== self &&
          game.isLand(neighbor) &&
          !game.isImpassable(neighbor) &&
          self.canAttackPlayer(rival)
        )
          expected.add(neighbor);
    assert.equal(observation.offense.attackableBorders, expected.size);
    self.relinquish(game.ref(32, 40));
    observation = builder.observe("self", self, 0, {}, []);
    assert.equal(
      observation.rivals.find((row) => row.playerId === rival.id())!.canAttack,
      false,
    );
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "attack",
          targetID: rival.id(),
          troops: 5_000,
        }),
      /no passable land border/i,
    );
    assert.doesNotThrow(() =>
      assertAgentAction(game, self, {
        type: "attack",
        targetID: null,
        troops: 5_000,
      }),
    );
    const native = new AttackExecution(5_000, self, null);
    native.init(game, game.ticks());
    const before = self.numTilesOwned();
    native.tick(game.ticks());
    assert.ok(self.numTilesOwned() > before);
    return {
      fullAttackableBorderCount: expected.size,
      hintLimit: 12,
      staleTargetRejected: true,
      neutralTilesBefore: before,
      neutralTilesAfter: self.numTilesOwned(),
    };
  },
);

await check(
  "crowded allied borders retain a legal neutral expansion hint",
  async () => {
    const rivalNames = Array.from(
      { length: 12 },
      (_, index) => `Rival${index}`,
    );
    const game = await setup("plains", {}, [
      playerInfo("Self", PlayerType.Human),
      ...rivalNames.map((name) => playerInfo(name, PlayerType.Human)),
    ]);
    const self = game.player("Self");
    for (let y = 30; y < 50; y++)
      for (let x = 30; x < 50; x++) self.conquer(game.ref(x, y));
    self.setSpawnTile(game.ref(40, 40));
    self.setTroops(10_000);
    for (const [index, name] of rivalNames.entries()) {
      const rival = game.player(name);
      const tile = game.ref(30 + index, 29);
      rival.conquer(tile);
      rival.setSpawnTile(tile);
      const request = self.createAllianceRequest(rival);
      assert.ok(request);
      request.accept();
    }
    const observation = new ObservationBuilder(game).observe(
      "self",
      self,
      0,
      {},
      [],
    );
    assert.equal(observation.rivals.length, 12);
    assert.ok(
      observation.rivals.every(
        (rival) => rival.sharesBorder && !rival.canAttack,
      ),
    );
    assert.equal(observation.offense.attackableBorders, 68);
    assert.equal(observation.map.borders.length, 12);
    const neutral = observation.map.borders.find(
      (border) => border.ownerId === null && border.canAttack,
    );
    assert.ok(
      neutral,
      "Allied representatives must leave one legal neutral hint inside the cap",
    );
    assert.equal(self.canAttack(neutral.tile), true);
    assert.doesNotThrow(() =>
      assertAgentAction(game, self, {
        type: "attack",
        targetID: null,
        troops: 1_000,
      }),
    );
    const native = new AttackExecution(1_000, self, null);
    native.init(game, game.ticks());
    const before = self.numTilesOwned();
    native.tick(game.ticks());
    assert.ok(self.numTilesOwned() > before);
    return {
      borderingAllies: observation.rivals.length,
      fullNeutralAttackableBorderCount: observation.offense.attackableBorders,
      hintCount: observation.map.borders.length,
      neutralHint: neutral,
      nativeTilesBefore: before,
      nativeTilesAfter: self.numTilesOwned(),
    };
  },
);

await check(
  "native target and launch restrictions reject known no-ops",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    const boatTarget = builder
      .observe("self", self, 0, {}, [])
      .map.boatTargets.find((hint) => hint.ownerId === rival.id())!;
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "attack",
          targetID: "Missing",
          troops: 1_000,
        }),
      /target.*not.*exist/i,
    );
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "attack",
          targetID: self.id(),
          troops: 1_000,
        }),
      /own.*player|itself/i,
    );
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "boat",
          dst: game.width() * game.height(),
          troops: 1_000,
        }),
      /valid.*tile/i,
    );
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "boat",
          dst: self.spawnTile()!,
          troops: 1_000,
        }),
      /own.*land|own.*player/i,
    );
    const request = self.createAllianceRequest(rival);
    assert.ok(request);
    request.accept();
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "attack",
          targetID: rival.id(),
          troops: 1_000,
        }),
      /allied|friendly|native.*permission/i,
    );
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "boat",
          dst: boatTarget.tile,
          troops: 1_000,
        }),
      /allied|friendly|native.*permission/i,
    );
    return {
      rejectedTargets: [
        "missing player",
        "self player",
        "invalid boat tile",
        "owned boat target",
        "allied land target",
        "allied boat target",
      ],
    };
  },
);

await check(
  "outgoing attacks without a beachhead cannot claim reinforcement capability",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    const landing = game.ref(32, 30);
    self.conquer(landing);
    const native = new AttackExecution(5_000, self, rival.id(), landing, false);
    native.init(game, game.ticks());
    const old = self.outgoingAttacks()[0];
    rival.conquer(landing);
    assert.equal(old.sourceTile(), landing);
    const observation = builder.observe("self", self, 0, {}, []);
    const row = observation.rivals.find((row) => row.playerId === rival.id())!;
    assert.equal(row.sharesBorder, false);
    assert.equal(row.canAttack, false);
    assert.equal(row.canReinforceAttack, false);
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "attack",
          targetID: rival.id(),
          troops: 1_000,
        }),
      /no passable land border/i,
    );
    const merged = new AttackExecution(1_000, self, rival.id());
    merged.init(game, game.ticks());
    assert.equal(old.isActive(), false);
    assert.equal(self.outgoingAttacks()[0].troops(), 6_000);
    merged.tick(game.ticks());
    assert.equal(
      merged.isActive(),
      false,
      "The native merged attack retreats without a frontier",
    );
    return {
      lostBeachhead: landing,
      canAttack: row.canAttack,
      canReinforceAttack: row.canReinforceAttack,
      nativeMergedAttackRetreated: !merged.isActive(),
    };
  },
);

await check(
  "counterattacks can cancel native incoming commitments without a land frontier",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    const landing = game.ref(20, 30);
    rival.conquer(landing);
    const incoming = new AttackExecution(
      5_000,
      rival,
      self.id(),
      landing,
      false,
    );
    incoming.init(game, game.ticks());
    const enemyAttack = self.incomingAttacks()[0];
    self.conquer(landing);
    const row = builder
      .observe("self", self, 0, {}, [])
      .rivals.find((row) => row.playerId === rival.id())!;
    assert.equal(row.sharesBorder, false);
    assert.equal(row.canAttack, true);
    assert.equal(row.canCounterAttack, true);
    assert.doesNotThrow(() =>
      assertAgentAction(game, self, {
        type: "attack",
        targetID: rival.id(),
        troops: 1_000,
      }),
    );
    const counter = new AttackExecution(1_000, self, rival.id());
    counter.init(game, game.ticks());
    assert.equal(
      enemyAttack.troops(),
      4_000,
      "Native counterattack cancels 1,000 committed enemy troops",
    );
    assert.equal(counter.isActive(), false);
    return {
      lostBeachhead: landing,
      sharesBorder: row.sharesBorder,
      canCounterAttack: row.canCounterAttack,
      incomingTroopsBefore: 5_000,
      incomingTroopsAfter: enemyAttack.troops(),
    };
  },
);

await check(
  "transport disablement and capacity remove hints and reject launches",
  async () => {
    const { game, self, rival, builder } = await riverGame();
    const hint = builder
      .observe("self", self, 0, {}, [])
      .map.boatTargets.find((row) => row.ownerId === rival.id())!;
    for (let index = 0; index < game.config().boatMaxNumber(); index++)
      self.buildUnit(UnitType.TransportShip, hint.launchTile, {
        troops: 1_000,
      });
    assert.equal(
      builder.observe("self", self, 0, {}, []).map.boatTargets.length,
      0,
    );
    assert.throws(
      () =>
        assertAgentAction(game, self, {
          type: "boat",
          dst: hint.tile,
          troops: 1_000,
        }),
      /transport.*limit|capacity/i,
    );
    const disabled = await setup(
      "plains",
      { disabledUnits: [UnitType.TransportShip] },
      [playerInfo("Self", PlayerType.Human)],
    );
    const disabledSelf = disabled.player("Self");
    disabledSelf.conquer(disabled.ref(20, 20));
    disabledSelf.setSpawnTile(disabled.ref(20, 20));
    assert.throws(
      () =>
        assertAgentAction(disabled, disabledSelf, {
          type: "boat",
          dst: disabled.ref(30, 30),
          troops: 1_000,
        }),
      /disabled/i,
    );
    return {
      nativeTransportLimit: game.config().boatMaxNumber(),
      activeTransports: self.unitCount(UnitType.TransportShip),
      hintsAtCapacity: builder.observe("self", self, 0, {}, []).map.boatTargets
        .length,
      disabledLaunchRejected: true,
    };
  },
);

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/river-reachability-e2e.json",
  JSON.stringify(
    {
      result: results.every((result) => result.result === "PASS")
        ? "PASS"
        : "FAIL",
      modelRequests: 0,
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
assert.ok(
  results.every((result) => result.result === "PASS"),
  "See .agent-arena/river-reachability-e2e.json",
);
