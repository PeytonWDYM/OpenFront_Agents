const FALLBACK_MS = 10_000;
const EVENT_COOLDOWN_MS = 5_000;

interface ScheduledPlayer {
  id: string;
  nextAt: number;
  completedAt: number;
  wakeRequested: boolean;
}

/** Independent player turns with coalesced events and a periodic fallback. */
export class TurnQueue {
  private pending: ScheduledPlayer[] = [];
  private readonly players = new Map<string, ScheduledPlayer>();
  private readonly active = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly concurrency: number,
    private readonly eligible: (id: string) => boolean,
    private readonly decide: (id: string) => Promise<number | void>,
  ) {}

  start(ids?: string[]) {
    if (ids) {
      this.players.clear();
      this.pending = ids.map((id) => {
        const player = { id, nextAt: 0, completedAt: 0, wakeRequested: false };
        this.players.set(id, player);
        return player;
      });
    }
    this.running = true;
    this.timer ??= setInterval(() => this.pump(), 100);
    this.pump();
  }

  wake(id: string) {
    const player = this.players.get(id);
    if (!player || !this.running) return;
    player.wakeRequested = true;
    if (!this.active.has(id)) {
      player.nextAt = Math.min(
        player.nextAt,
        Math.max(Date.now(), player.completedAt + EVENT_COOLDOWN_MS),
      );
    }
    this.pump();
  }

  pause() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  activeIds() {
    return [...this.active.keys()];
  }

  async drain() {
    await Promise.allSettled(this.active.values());
  }

  private pump() {
    if (!this.running) return;
    this.pending.sort(
      (a, b) => Number(b.wakeRequested) - Number(a.wakeRequested),
    );
    let scanned = this.pending.length;
    while (
      this.running &&
      scanned-- > 0 &&
      this.active.size < this.concurrency
    ) {
      const player = this.pending.shift()!;
      if (!this.eligible(player.id)) continue;
      if (player.nextAt > Date.now()) {
        this.pending.push(player);
        continue;
      }
      player.wakeRequested = false;
      // Register the active turn before its first tool or game event.
      let interval = FALLBACK_MS;
      const work = Promise.resolve()
        .then(() => this.decide(player.id))
        .then((retryAfter) => {
          if (retryAfter !== undefined) interval = retryAfter;
        })
        .finally(() => {
          this.active.delete(player.id);
          player.completedAt = Date.now();
          player.nextAt =
            player.completedAt +
            (player.wakeRequested
              ? Math.min(interval, EVENT_COOLDOWN_MS)
              : interval);
          this.pending.push(player);
        });
      this.active.set(player.id, work);
    }
  }
}
