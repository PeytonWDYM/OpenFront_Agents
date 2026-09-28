interface ScheduledPlayer {
  id: string;
  nextAt: number;
}

/** Fair queue with one active decision per player and an interval after completion. */
export class TurnQueue {
  private pending: ScheduledPlayer[] = [];
  private readonly active = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly concurrency: number,
    private readonly interval: number,
    private readonly eligible: (id: string) => boolean,
    private readonly reserve: (id: string) => boolean,
    private readonly decide: (id: string) => Promise<number | void>,
    private readonly release: (id: string) => void,
  ) {}

  start(ids?: string[]) {
    if (ids) this.pending = ids.map((id) => ({ id, nextAt: 0 }));
    this.running = true;
    this.timer ??= setInterval(() => this.pump(), 100);
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
      if (!this.reserve(player.id)) {
        this.pending.unshift(player);
        return;
      }
      // Start in a microtask so the active map always contains the decision first.
      let interval = this.interval;
      const work = Promise.resolve()
        .then(() => this.decide(player.id))
        .then((retryAfter) => {
          if (retryAfter !== undefined) interval = retryAfter;
        })
        .finally(() => {
          this.active.delete(player.id);
          this.release(player.id);
          this.pending.push({ id: player.id, nextAt: Date.now() + interval });
        });
      this.active.set(player.id, work);
    }
  }
}
