// Failure cases: MIRV warnings use a generic event, impacts produce no wakeup,
// bystanders receive private warnings, and intercepted bombs count as impacts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isUrgentAgentEvent, playerEvents } from "../../src/agents/game/events";
import { AgentEvent } from "../../src/agents/game/schemas";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";

class FastBombConfig extends TestConfig {
  nukeSpeed(): number {
    return 50;
  }
  mirvNormalizeTargetTicks(): number {
    return 8;
  }
}

const seats = ["launch01", "victim01", "watch001"].map(
  (id) => new PlayerInfo(id, PlayerType.Human, id, id),
);
const failures: string[] = [];
const cases: Record<string, unknown>[] = [];
const check = (condition: boolean, failure: string) => {
  if (!condition) failures.push(failure);
};

for (const bomb of [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV]) {
  const game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true },
    seats,
    undefined,
    FastBombConfig,
  );
  const [launcher, victim, bystander] = seats.map((seat) =>
    game.player(seat.id),
  );
  launcher.conquer(game.ref(10, 10));
  launcher.setSpawnTile(game.ref(10, 10));
  for (let x = 48; x <= 52; x++)
    for (let y = 48; y <= 52; y++) victim.conquer(game.ref(x, y));
  victim.setSpawnTile(game.ref(50, 50));
  bystander.conquer(game.ref(170, 170));
  bystander.setSpawnTile(game.ref(170, 170));
  const initialVictimTiles = victim.numTilesOwned();
  const projected = new Map(seats.map((seat) => [seat.id, [] as AgentEvent[]]));
  const nativeEvents: unknown[] = [];
  const tick = (game: Game) => {
    const updates = game.executeNextTick();
    const impacts = game.drainNukeImpacts();
    for (const update of [
      ...updates[GameUpdateType.UnitIncoming],
      ...updates[GameUpdateType.DisplayEvent],
    ])
      nativeEvents.push(update);
    if (impacts.length)
      nativeEvents.push({ tick: game.ticks(), impactTiles: impacts });
    for (const seat of seats)
      projected
        .get(seat.id)!
        .push(...playerEvents(game, game.player(seat.id), updates));
  };
  game.addExecution(
    new ConstructionExecution(launcher, UnitType.MissileSilo, game.ref(10, 10)),
  );
  tick(game);
  tick(game);
  game.addExecution(
    new ConstructionExecution(launcher, bomb, game.ref(50, 50)),
  );
  for (let index = 0; index < 250; index++) tick(game);
  const victimEvents = projected.get(victim.id())!;
  const warnings = victimEvents.filter(
    (event) => event.type === "nuke_incoming",
  );
  const impactEvents = victimEvents.filter(
    (event) => event.type === "nuke_impact",
  );
  check(
    warnings.length > 0,
    `${bomb}: recipient missed the native bomb warning`,
  );
  check(
    warnings.every((event) => isUrgentAgentEvent(event, victim.id())),
    `${bomb}: warning did not wake its recipient`,
  );
  check(
    victim.numTilesOwned() < initialVictimTiles,
    `${bomb}: native bomb did not hit the victim`,
  );
  check(
    impactEvents.length > 0,
    `${bomb}: recipient did not learn that a bomb hit`,
  );
  check(
    impactEvents.every((event) => isUrgentAgentEvent(event, victim.id())),
    `${bomb}: impact did not wake its recipient`,
  );
  for (const other of [launcher, bystander]) {
    check(
      !projected
        .get(other.id())!
        .some(
          (event) =>
            event.type === "nuke_incoming" || event.type === "nuke_impact",
        ),
      `${bomb}: a private bomb event leaked to ${other.id()}`,
    );
  }
  cases.push({
    bomb,
    nativeEvents,
    victimEvents,
    victimTilesBefore: initialVictimTiles,
    victimTilesAfter: victim.numTilesOwned(),
    bystanderEvents: projected.get(bystander.id()),
  });
}

for (const intercepted of [true, false]) {
  const game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true },
    seats,
    undefined,
    FastBombConfig,
  );
  const [launcher, victim, bystander] = seats.map((seat) =>
    game.player(seat.id),
  );
  launcher.conquer(game.ref(10, 10));
  launcher.setSpawnTile(game.ref(10, 10));
  launcher.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
  victim.conquer(game.ref(50, 50));
  victim.setSpawnTile(game.ref(50, 50));
  bystander.conquer(game.ref(170, 170));
  const bomb = new NukeExecution(
    UnitType.AtomBomb,
    launcher,
    game.ref(50, 50),
    game.ref(10, 10),
  );
  game.addExecution(bomb);
  const projected: AgentEvent[] = [];
  for (let index = 0; index < 40; index++) {
    const updates = game.executeNextTick();
    projected.push(...playerEvents(game, victim, updates));
    if (index === 1 && intercepted) bomb.getNuke()!.delete(false);
  }
  if (intercepted) {
    check(victim.isAlive(), "An intercepted bomb eliminated its target");
    check(
      !projected.some((event) => event.type === "nuke_impact"),
      "An intercepted bomb produced an impact event",
    );
  } else {
    check(
      !victim.isAlive(),
      "The native bomb did not eliminate its one-tile target",
    );
    check(
      projected.some((event) => event.type === "eliminated"),
      "Native elimination did not immediately reach the arena",
    );
  }
  cases.push({
    case: intercepted ? "intercepted" : "eliminated",
    alive: victim.isAlive(),
    projected,
  });
}

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/events-e2e.json",
  JSON.stringify(
    { result: failures.length ? "failed" : "passed", failures, cases },
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  ),
);
assert.deepEqual(failures, []);
console.log("Native bomb event fixture passed.");
