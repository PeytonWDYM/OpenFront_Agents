// Failure cases: captures stay generic, captor identity is missing, private events
// reach other players, repeated ticks duplicate losses, and losses wake each ship.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isUrgentAgentEvent, playerEvents } from "../../src/agents/game/events";
import { AgentEvent } from "../../src/agents/game/schemas";
import { TradeShipExecution } from "../../src/core/execution/TradeShipExecution";
import {
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import { setup } from "../util/Setup";

const seats = ["origin", "partner", "pirate", "watcher"].map(
  (id) => new PlayerInfo(id, PlayerType.Human, null, id),
);
const game = await setup(
  "half_land_half_ocean",
  { infiniteGold: true, instantBuild: true },
  seats,
);
const [origin, partner, pirate, watcher] = seats.map((seat) =>
  game.player(seat.id),
);
const port = (owner: Player, y: number) => {
  const tile = game.ref(7, y);
  owner.conquer(tile);
  owner.setSpawnTile(tile);
  return owner.buildUnit(UnitType.Port, tile, {});
};
const source = port(origin, 1);
const destination = port(partner, 14);
port(pirate, 4);
port(watcher, 10);
for (let index = 0; index < 2; index++)
  game.addExecution(new TradeShipExecution(origin, source, destination));
game.executeNextTick();
game.executeNextTick();
const ships = origin.units(UnitType.TradeShip);
assert.equal(ships.length, 2, "Native fixture did not launch two trade ships");
for (const ship of ships) pirate.captureUnit(ship);

const updates = game.executeNextTick();
const nativeCaptures = updates[GameUpdateType.DisplayEvent].filter(
  (event) => event.message === "events_display.trade_ship_captured",
);
const projected = new Map(
  seats.map((seat) => [
    seat.id,
    playerEvents(game, game.player(seat.id), updates),
  ]),
);
const captures = projected
  .get(origin.id())!
  .filter((event) => event.type === "trade_ship_captured");
const failures: string[] = [];
const check = (condition: boolean, failure: string) => {
  if (!condition) failures.push(failure);
};
check(
  nativeCaptures.length === 2,
  "Native simulation did not report both captures",
);
check(captures.length === 2, "Agent did not receive both native ship losses");
check(
  captures.every(
    (event) =>
      ships.some((ship) => ship.id() === event.data.unitId) &&
      event.data.captorId === pirate.id() &&
      typeof event.data.tile === "number",
  ),
  "Capture projection missed native ship, captor, or current tile",
);
check(
  captures.every((event) => !isUrgentAgentEvent(event, origin.id())),
  "Ship losses each triggered an urgent model wakeup",
);
check(
  captures.every(
    (event) =>
      Object.keys(event.data).sort().join(",") === "captorId,tile,unitId",
  ),
  "Capture event exposed cargo, routes, or private recipient details",
);
for (const other of [partner, pirate, watcher])
  check(
    !projected
      .get(other.id())!
      .some((event) => event.type === "trade_ship_captured"),
    `Private ship loss leaked to ${other.id()}`,
  );
const laterEvents: AgentEvent[] = [];
for (let index = 0; index < 5; index++)
  laterEvents.push(...playerEvents(game, origin, game.executeNextTick()));
check(
  !laterEvents.some((event) => event.type === "trade_ship_captured"),
  "Capture projection repeated the same native ship loss",
);

await mkdir(".agent-arena", { recursive: true });
await writeFile(
  ".agent-arena/trade-capture-e2e.json",
  JSON.stringify(
    {
      result: failures.length ? "failed" : "passed",
      failures,
      nativeCaptures,
      projected: Object.fromEntries(projected),
      laterEvents,
    },
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  ),
);
assert.deepEqual(failures, []);
console.log("Native trade capture fixture passed.");
