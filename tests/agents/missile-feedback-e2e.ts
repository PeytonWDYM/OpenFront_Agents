// Failure cases: native SAM hits lose shooter identity, deleted missiles become
// false impacts, collateral notices duplicate global impacts, nation MIRVs stay
// invisible, private warnings leak, or conquest spam hides urgent events.
// Public lifecycle failures: neutral or water strikes have no public launch or
// impact, repeated unit updates duplicate outcomes, or MIRV separation is an impact.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  isUrgentAgentEvent,
  type NuclearEventHistory,
  playerEvents,
  selectAgentEvents,
} from "../../src/agents/game/events";
import type { AgentEvent } from "../../src/agents/game/schemas";
import { MirvExecution } from "../../src/core/execution/MIRVExecution";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import { SAMLauncherExecution } from "../../src/core/execution/SAMLauncherExecution";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameUpdateType as U } from "../../src/core/game/GameUpdates";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";

const seats = ["launcher", "victim", "collateral", "watcher"].map(
  (id) => new PlayerInfo(id, PlayerType.Human, id, id),
);
const proof: unknown[] = [];
for (const intercepted of [true, false]) {
  const game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true },
    seats,
  );
  const [launcher, victim, collateral, watcher] = seats.map((seat) =>
    game.player(seat.id),
  );
  for (const [player, x, y] of [
    [launcher, 10, 10],
    [victim, 50, 50],
    [collateral, 51, 50],
    [watcher, 170, 170],
  ] as const) {
    const tile = game.ref(x, y);
    player.setSpawnTile(tile);
    player.conquer(tile);
  }
  launcher.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
  if (intercepted) {
    const sam = victim.buildUnit(UnitType.SAMLauncher, game.ref(49, 50), {});
    game.addExecution(new SAMLauncherExecution(victim, null, sam));
  }
  const execution = new NukeExecution(
    UnitType.AtomBomb,
    launcher,
    game.ref(50, 50),
    null,
  );
  game.addExecution(execution);
  const events = new Map(seats.map((seat) => [seat.id, [] as AgentEvent[]]));
  const histories = new Map(
    seats.map((seat) => [
      seat.id,
      {
        launched: new Set<number>(),
        impacted: new Set<number>(),
      } satisfies NuclearEventHistory,
    ]),
  );
  const native: unknown[] = [];
  let missileId: number | undefined;
  for (let tick = 0; tick < 150; tick++) {
    const updates = game.executeNextTick();
    missileId ??= execution.getNuke()?.id();
    native.push(...updates[U.DisplayEvent]);
    for (const seat of seats)
      events
        .get(seat.id)!
        .push(
          ...playerEvents(
            game,
            game.player(seat.id),
            updates,
            undefined,
            undefined,
            histories.get(seat.id)!,
          ),
        );
  }
  const shooterEvents = events.get(launcher.id())!;
  const victimEvents = events.get(victim.id())!;
  const bystanderEvents = events.get(watcher.id())!;
  assert.ok(
    shooterEvents.some(
      (event) =>
        event.type === "global_nuke_launch" && event.data.unitId === missileId,
    ),
  );
  assert.ok(victimEvents.some((event) => event.type === "nuke_incoming"));
  assert.ok(
    !bystanderEvents.some(
      (event) =>
        event.type === "nuke_incoming" ||
        event.type === "nuke_impact" ||
        event.type === "missile_intercepted",
    ),
  );
  assert.ok(
    bystanderEvents.every((event) => !isUrgentAgentEvent(event, watcher.id())),
  );
  if (intercepted) {
    const hit = shooterEvents.find(
      (event) => event.type === "missile_intercepted",
    )!;
    assert.ok(hit, "Native SAM must inform the shooter");
    assert.equal(hit.data.unitId, missileId);
    assert.equal(hit.data.attackerId, launcher.id());
    assert.equal(hit.data.interceptorId, victim.id());
    assert.equal(hit.data.missileType, UnitType.AtomBomb);
    assert.equal(hit.data.targetTile, game.ref(50, 50));
    assert.ok(isUrgentAgentEvent(hit, launcher.id()));
    assert.ok(!isUrgentAgentEvent(hit, victim.id()));
    assert.ok(
      native.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "messageType" in event &&
          event.messageType === MessageType.SAM_HIT,
      ),
    );
    for (const list of events.values())
      assert.ok(
        !list.some(
          (event) =>
            event.type === "nuke_impact" || event.type === "global_nuke_impact",
        ),
      );
    assert.equal(victim.numTilesOwned(), 1);
  } else {
    const impacts = bystanderEvents.filter(
      (event) => event.type === "global_nuke_impact",
    );
    assert.equal(impacts.length, 1);
    assert.equal(impacts[0].data.unitId, missileId);
    assert.ok(victimEvents.some((event) => event.type === "nuke_impact"));
    assert.ok(!shooterEvents.some((event) => event.type === "nuke_impact"));
  }
  const threat = victimEvents.find((event) => event.type === "nuke_incoming")!;
  const spam: AgentEvent[] = Array.from({ length: 500 }, () => ({
    type: "conquest",
    tick: game.ticks(),
    at: 0,
    data: {},
  }));
  const selected = selectAgentEvents([threat, ...spam], 20, victim.id());
  assert.equal(selected.length, 20);
  assert.ok(selected.includes(threat));
  proof.push({
    intercepted,
    missileId,
    native,
    events: Object.fromEntries(events),
    retainedThreat: true,
  });
}

class FastMirvConfig extends TestConfig {
  override nukeSpeed() {
    return 50;
  }
  override mirvNormalizeTargetTicks() {
    return 8;
  }
}
const mirvGame = await setup(
  "big_plains",
  { infiniteGold: true, instantBuild: true },
  seats,
  undefined,
  FastMirvConfig,
);
const nation = mirvGame.addPlayer(
  new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
);
const victim = mirvGame.player("victim");
nation.conquer(mirvGame.ref(10, 10));
nation.setSpawnTile(mirvGame.ref(10, 10));
nation.addGold(100_000_000n);
nation.buildUnit(UnitType.MissileSilo, mirvGame.ref(10, 10), {});
for (let x = 48; x <= 52; x++)
  for (let y = 48; y <= 52; y++) victim.conquer(mirvGame.ref(x, y));
victim.setSpawnTile(mirvGame.ref(50, 50));
mirvGame.addExecution(new MirvExecution(nation, mirvGame.ref(50, 50)));
const mirvEvents: AgentEvent[] = [];
const mirvHistory: NuclearEventHistory = {
  launched: new Set(),
  impacted: new Set(),
};
for (let tick = 0; tick < 250; tick++)
  mirvEvents.push(
    ...playerEvents(
      mirvGame,
      mirvGame.player("watcher"),
      mirvGame.executeNextTick(),
      undefined,
      undefined,
      mirvHistory,
    ),
  );
assert.ok(
  mirvEvents.some(
    (event) =>
      event.type === "global_nuke_launch" &&
      event.data.attackerId === nation.id() &&
      event.data.missileType === UnitType.MIRV,
  ),
);
assert.ok(
  mirvEvents.some(
    (event) =>
      event.type === "global_nuke_impact" &&
      event.data.attackerId === nation.id() &&
      event.data.missileType === UnitType.MIRVWarhead,
  ),
);
assert.ok(
  !mirvEvents.some(
    (event) => event.type === "nuke_incoming" || event.type === "nuke_impact",
  ),
);
proof.push({ nationMirv: mirvEvents });
assert.equal(
  mirvEvents.filter(
    (event) =>
      event.type === "global_nuke_launch" &&
      event.data.missileType === UnitType.MIRV,
  ).length,
  1,
);
assert.ok(
  !mirvEvents.some(
    (event) =>
      event.type === "global_nuke_impact" &&
      event.data.missileType === UnitType.MIRV,
  ),
);
for (const terrain of ["neutral", "water"] as const) {
  const game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true, waterNukes: true },
    seats,
  );
  const launcher = game.player("launcher");
  const watcher = game.player("watcher");
  launcher.conquer(game.ref(10, 10));
  launcher.setSpawnTile(game.ref(10, 10));
  launcher.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
  const target = game.ref(80, 80);
  if (terrain === "water") {
    game.queueWaterConversion(target);
    game.executeNextTick();
    assert.ok(game.isWater(target));
  }
  assert.equal(game.hasOwner(target), false);
  const execution = new NukeExecution(
    UnitType.AtomBomb,
    launcher,
    target,
    null,
  );
  assert.notEqual(launcher.canBuild(UnitType.AtomBomb, target), false);
  game.addExecution(execution);
  const history: NuclearEventHistory = {
    launched: new Set(),
    impacted: new Set(),
  };
  const events: AgentEvent[] = [];
  const native: unknown[] = [];
  for (let tick = 0; tick < 150; tick++) {
    const updates = game.executeNextTick();
    native.push(
      ...updates[U.Unit].filter((unit) => unit.unitType === UnitType.AtomBomb),
    );
    assert.equal(updates[U.UnitIncoming].length, 0);
    assert.ok(
      !updates[U.DisplayEvent].some(
        (event) => event.messageType === MessageType.NUKE_DETONATED,
      ),
    );
    events.push(
      ...playerEvents(game, watcher, updates, undefined, undefined, history),
    );
    // Replaying native updates must not repeat either public lifecycle event.
    assert.ok(
      !playerEvents(game, watcher, updates, undefined, undefined, history).some(
        (event) =>
          event.type === "global_nuke_launch" ||
          event.type === "global_nuke_impact",
      ),
    );
  }
  const id = execution.getNuke()!.id();
  assert.equal(
    events.filter(
      (event) =>
        event.type === "global_nuke_launch" && event.data.unitId === id,
    ).length,
    1,
    `${terrain} launch must appear once`,
  );
  const impacts = events.filter(
    (event) => event.type === "global_nuke_impact" && event.data.unitId === id,
  );
  assert.equal(
    impacts.length,
    1,
    `${terrain} native detonation must appear once`,
  );
  assert.equal(impacts[0].data.attackerId, launcher.id());
  assert.equal(impacts[0].data.targetTile, target);
  assert.deepEqual(impacts[0].data.impactedPlayerIds, []);
  assert.ok(
    !events.some(
      (event) => event.type === "nuke_incoming" || event.type === "nuke_impact",
    ),
  );
  assert.ok(events.every((event) => !isUrgentAgentEvent(event, watcher.id())));
  proof.push({ terrain, events, native });
}
await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/missile-feedback-e2e.json",
  JSON.stringify(
    { passed: true, proof },
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  ),
);
console.log(
  "Missile feedback E2E passed: .agent-arena/missile-feedback-e2e.json",
);
