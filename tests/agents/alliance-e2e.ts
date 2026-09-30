// Failure cases: no renewal opportunity, repeated wakeups, private reminder leaks,
// wrong custom duration, automatic renewal, expiry debuffs, and wrong betrayal cost.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isUrgentAgentEvent, playerEvents } from "../../src/agents/game/events";
import { AgentEvent } from "../../src/agents/game/schemas";
import { Executor } from "../../src/core/execution/ExecutionManager";
import { PlayerExecution } from "../../src/core/execution/PlayerExecution";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { StampedIntent } from "../../src/core/Schemas";
import { setup } from "../util/Setup";
import { UseRealAttackLogic } from "../util/TestConfig";

const seats = ["ally0001", "ally0002", "watch001"].map(
  (id) => new PlayerInfo(id, PlayerType.Human, id, id),
);
const cases: Record<string, unknown>[] = [];
const artifact: Record<string, unknown> = { cases };
const ofType = (events: AgentEvent[], type: string) =>
  events.filter((event) => event.type === type);

try {
  for (const duration of [1, 2]) {
    const game = await setup(
      "big_plains",
      { customAllianceDuration: duration },
      seats,
      undefined,
      UseRealAttackLogic,
    );
    const [first, second, watcher] = seats.map((seat) => game.player(seat.id));
    for (const [index, player] of [first, second, watcher].entries()) {
      const tile = game.ref(10 + index * 50, 10);
      player.conquer(tile);
      player.setSpawnTile(tile);
      game.addExecution(new PlayerExecution(player));
    }
    const manager = new Executor(game, "allianc1", first.clientID()!);
    const reminders = new Map(
      seats.map((seat) => [seat.id, new Map<number, number>()]),
    );
    const histories = new Map(
      seats.map((seat) => [seat.id, [] as AgentEvent[]]),
    );
    const tick = (intents: StampedIntent[] = []) => {
      for (const intent of intents)
        game.addExecution(manager.createExec(intent));
      const updates = game.executeNextTick();
      const projected = new Map(
        seats.map((seat) => [
          seat.id,
          playerEvents(
            game,
            game.player(seat.id),
            updates,
            undefined,
            reminders.get(seat.id)!,
          ),
        ]),
      );
      for (const seat of seats)
        histories.get(seat.id)!.push(...projected.get(seat.id)!);
      return projected;
    };
    tick([
      {
        type: "allianceRequest",
        recipient: second.id(),
        clientID: first.clientID()!,
      },
    ]);
    tick();
    tick([
      {
        type: "allianceRequest",
        recipient: first.id(),
        clientID: second.clientID()!,
      },
    ]);
    tick();
    assert.ok(first.isAlliedWith(second));
    const alliance = first.allianceWith(second)!;
    const originalExpiry = alliance.expiresAt();
    assert.equal(originalExpiry - alliance.createdAt(), duration * 600);
    const windowStart =
      originalExpiry - game.config().allianceExtensionPromptOffset();
    while (game.ticks() < windowStart - 1) tick();
    assert.equal(
      ofType(histories.get(first.id())!, "alliance_renewal_available").length,
      0,
    );
    // A disconnected ally cannot renew. Reconnecting in the window enables one reminder.
    second.markDisconnected(true);
    while (game.ticks() < windowStart + 2) tick();
    assert.equal(
      ofType(histories.get(first.id())!, "alliance_renewal_available").length,
      0,
    );
    second.markDisconnected(false);
    const available = tick();
    for (const player of [first, second]) {
      const reminder = ofType(
        available.get(player.id())!,
        "alliance_renewal_available",
      );
      assert.equal(
        reminder.length,
        1,
        "Both allies must receive their own renewal opportunity",
      );
      assert.ok(isUrgentAgentEvent(reminder[0], player.id()));
      assert.equal(
        reminder[0].data.other,
        player === first ? second.id() : first.id(),
      );
      assert.equal(reminder[0].data.expiresAt, originalExpiry);
      assert.equal(
        reminder[0].data.ticksRemaining,
        originalExpiry - game.ticks(),
      );
    }
    for (let index = 0; index < 8; index++) tick();
    assert.equal(
      ofType(histories.get(first.id())!, "alliance_renewal_available").length,
      1,
    );
    assert.equal(
      alliance.expiresAt(),
      originalExpiry,
      "The reminder must not renew an alliance",
    );
    tick([
      {
        type: "allianceExtension",
        recipient: second.id(),
        clientID: first.clientID()!,
      },
    ]);
    assert.equal(
      alliance.expiresAt(),
      originalExpiry,
      "One agreement must not renew the alliance",
    );
    assert.equal(
      ofType(histories.get(first.id())!, "alliance_extended").length,
      0,
      "A renewal request must not report a completed renewal",
    );
    const request = ofType(
      histories.get(second.id())!,
      "alliance_extension_request",
    );
    assert.equal(request.length, 1);
    assert.equal(request[0].data.requestor, first.id());
    assert.ok(isUrgentAgentEvent(request[0], second.id()));
    tick([
      {
        type: "allianceExtension",
        recipient: first.id(),
        clientID: second.clientID()!,
      },
    ]);
    const renewedExpiry = alliance.expiresAt();
    assert.ok(renewedExpiry > originalExpiry);
    assert.equal(renewedExpiry - (game.ticks() - 1), duration * 600);
    for (const player of [first, second]) {
      const extended = ofType(histories.get(player.id())!, "alliance_extended");
      assert.equal(extended.length, 1);
      assert.equal(extended[0].data.expiresAt, renewedExpiry);
      assert.ok(!isUrgentAgentEvent(extended[0], player.id()));
    }
    while (game.ticks() <= renewedExpiry) tick();
    // Ignoring the next opportunity expires the native alliance without a debuff.
    assert.equal(
      ofType(histories.get(first.id())!, "alliance_renewal_available").length,
      2,
    );
    assert.ok(!first.isAlliedWith(second));
    for (const player of [first, second]) {
      assert.equal(player.getTraitorRemainingTicks(), 0);
      const expired = ofType(histories.get(player.id())!, "alliance_expired");
      assert.equal(expired.length, 1);
      assert.ok(isUrgentAgentEvent(expired[0], player.id()));
      assert.equal(reminders.get(player.id())!.size, 0);
    }
    assert.equal(
      ofType(histories.get(watcher.id())!, "alliance_renewal_available").length,
      0,
    );
    assert.equal(
      ofType(histories.get(watcher.id())!, "alliance_extension_request").length,
      0,
    );
    assert.equal(
      ofType(histories.get(watcher.id())!, "alliance_expired").length,
      0,
    );

    // Betray a new active alliance through the native intent path.
    tick([
      {
        type: "allianceRequest",
        recipient: second.id(),
        clientID: first.clientID()!,
      },
    ]);
    tick();
    tick([
      {
        type: "allianceRequest",
        recipient: first.id(),
        clientID: second.clientID()!,
      },
    ]);
    tick();
    assert.ok(first.isAlliedWith(second));
    tick([
      {
        type: "breakAlliance",
        recipient: second.id(),
        clientID: first.clientID()!,
      },
    ]);
    tick();
    const broken = ofType(histories.get(second.id())!, "alliance_broken");
    assert.equal(broken.length, 1);
    assert.ok(isUrgentAgentEvent(broken[0], second.id()));
    assert.equal(first.getTraitorRemainingTicks(), 299);
    assert.equal(second.getTraitorRemainingTicks(), 0);
    assert.equal(broken[0].data.traitorRemainingTicks, 299);
    // Use the native attack rule, changing only the defender's traitor status.
    const attacker = { type: PlayerType.Human, numTiles: 100 };
    const defender = {
      type: PlayerType.Human,
      troops: 1000,
      numTiles: 100,
      isTraitor: false,
      isDisconnectedTeammate: false,
    };
    const input = {
      attacker,
      defender,
      attackTroops: 500,
      terrain: game.terrainType(first.spawnTile()!),
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 5,
    };
    const normal = game.config().attackLogic(input);
    const betrayed = game
      .config()
      .attackLogic({ ...input, defender: { ...defender, isTraitor: true } });
    assert.equal(betrayed.attackerTroopLoss, normal.attackerTroopLoss * 0.5);
    assert.equal(betrayed.tickFraction, normal.tickFraction * 0.8);
    for (let index = 0; index < 300; index++) tick();
    assert.equal(first.getTraitorRemainingTicks(), 0);
    cases.push({
      durationMinutes: duration,
      originalExpiry,
      renewedExpiry,
      histories: Object.fromEntries(histories),
      betrayalCosts: { normal, betrayed },
    });
  }

  // Disabled alliances never offer a renewal, even if an imported alliance exists.
  for (const config of [
    { customAllianceDuration: 0 },
    { disableAlliances: true },
  ]) {
    const game = await setup("big_plains", config, seats);
    const [first, second] = seats.map((seat) => game.player(seat.id));
    for (const [index, player] of [first, second].entries()) {
      const tile = game.ref(10 + index * 50, 10);
      player.conquer(tile);
      player.setSpawnTile(tile);
    }
    first.createAllianceRequest(second)!.accept();
    const reminders = new Map<number, number>();
    while (
      game.ticks() <
      first.allianceWith(second)!.expiresAt() -
        game.config().allianceExtensionPromptOffset()
    )
      game.executeNextTick();
    const events = playerEvents(
      game,
      first,
      game.executeNextTick(),
      undefined,
      reminders,
    );
    assert.equal(ofType(events, "alliance_renewal_available").length, 0);
    cases.push({ disabledConfig: config, events });
  }
  artifact.result = "passed";
} catch (error) {
  artifact.result = "failed";
  artifact.error = String(error);
  throw error;
} finally {
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/alliance-e2e.json",
    JSON.stringify(artifact, null, 2),
  );
}
console.log("Native alliance event fixture passed.");
