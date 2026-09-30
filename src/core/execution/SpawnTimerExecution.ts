import { z } from "zod";
import { Execution, Game } from "../game/Game";
import { GameUpdateType } from "../game/GameUpdates";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord, SnapshotReader } from "../snapshot/SnapshotContext";

export class SpawnTimerExecution implements Execution {
  private mg: Game;
  private countdownStartTick: number | null = null;

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    const requiredSeats = this.mg.config().gameConfig().spawnReadyClientIDs;
    let elapsedTicks = this.mg.ticks();
    if (requiredSeats !== undefined) {
      if (
        this.countdownStartTick === null &&
        requiredSeats.every((id) => this.mg.playerByClientID(id)?.hasSpawned())
      ) {
        this.countdownStartTick = this.mg.ticks();
      }
      elapsedTicks =
        this.countdownStartTick === null
          ? 0
          : this.mg.ticks() - this.countdownStartTick;
      this.mg.addUpdate({ type: GameUpdateType.SpawnCountdown, elapsedTicks });
    }
    if (elapsedTicks > this.mg.config().numSpawnPhaseTurns()) {
      this.mg.endSpawnPhase();
    }
  }

  isActive(): boolean {
    return this.mg.inSpawnPhase();
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  snapshot(): ExecRecord {
    return SpawnTimerExecutionSnapshot.write({
      initialized: this.mg !== undefined,
      countdownStartTick: this.countdownStartTick,
    });
  }

  restoreSnapshot(s: SpawnTimerState, r: SnapshotReader): void {
    if (s.initialized) this.mg = r.game;
    this.countdownStartTick = s.countdownStartTick;
  }
}

const SpawnTimerStateSchema = z.object({
  initialized: z.boolean(),
  countdownStartTick: z.number().int().nonnegative().nullable(),
});
type SpawnTimerState = z.infer<typeof SpawnTimerStateSchema>;

export const SpawnTimerExecutionSnapshot = execSnapshotType({
  name: "SpawnTimer",
  version: 2,
  migrations: { 1: (state) => ({ ...state, countdownStartTick: null }) },
  schema: SpawnTimerStateSchema,
  cls: () => SpawnTimerExecution,
});
