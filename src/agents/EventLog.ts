import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayerEvent } from "./types";

/** Keep a bounded inspector view and full private event evidence on disk. */
export class EventLog {
  private readonly events = new Map<string, PlayerEvent[]>();
  private readonly directory: string;

  constructor() {
    this.directory = join(".agent-arena", "runs", `${Date.now()}`);
    mkdirSync(this.directory, { recursive: true });
  }

  add(id: string, type: string, text: string, raw?: unknown, image?: string) {
    const event = { time: Date.now(), type, text, ...(image ? { image } : {}) };
    const history = this.events.get(id) ?? [];
    history.push(event);
    if (history.length > 500) history.splice(0, history.length - 500);
    this.events.set(id, history);
    appendFileSync(
      join(this.directory, `${id}.jsonl`),
      JSON.stringify({ ...event, raw }) + "\n",
    );
  }

  read(id: string, full = false) {
    if (full) {
      return readFileSync(join(this.directory, `${id}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const event = JSON.parse(line) as PlayerEvent;
          return {
            time: event.time,
            type: event.type,
            text: event.text,
            ...(event.image ? { image: event.image } : {}),
          };
        });
    }
    return [...(this.events.get(id) ?? [])];
  }
}
