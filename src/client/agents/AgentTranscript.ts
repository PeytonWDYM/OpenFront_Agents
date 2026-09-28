import { html } from "lit";
import { translateText } from "../Utils";
import { AgentTranscript } from "./AgentApi";

interface TranscriptView {
  transcript: AgentTranscript | null;
  busy: boolean;
  canCompact: boolean;
  fullThread: boolean;
  loadFull: () => void;
  compact: () => void;
  back: () => void;
}

export function agentTranscript({
  transcript,
  busy,
  canCompact,
  fullThread,
  loadFull,
  compact,
  back,
}: TranscriptView) {
  return html`
    <section aria-label=${translateText("agents.transcript")}>
      <div class="toolbar">
        <button @click=${back}>${translateText("agents.back")}</button>
        <button ?disabled=${busy} @click=${loadFull}>
          ${translateText(
            fullThread ? "agents.refresh_full" : "agents.load_full",
          )}
        </button>
        <button
          ?disabled=${busy || !canCompact || !transcript?.player.threadId}
          @click=${compact}
          title=${translateText("agents.compact_help")}
        >
          ${translateText("agents.compact")}
        </button>
      </div>
      ${transcript === null
        ? html`<p class="muted">${translateText("agents.loading")}</p>`
        : html`
            <h3>${transcript.player.name}</h3>
            <p class="muted thread-id">
              ${transcript.player.threadId ?? translateText("agents.no_thread")}
            </p>
            <p class="muted">
              ${translateText(
                fullThread
                  ? "agents.full_thread_help"
                  : "agents.transcript_help",
              )}
            </p>
            ${transcript.events.length === 0
              ? html`<p class="muted">${translateText("agents.no_events")}</p>`
              : transcript.events.map(
                  (event) => html`
                    <article class="transcript-event">
                      <div class="event-meta">
                        <time datetime=${new Date(event.time).toISOString()}
                          >${new Date(event.time).toLocaleTimeString()}</time
                        ><span>${event.type}</span>
                      </div>
                      <pre>${event.text}</pre>
                    </article>
                  `,
                )}
          `}
    </section>
  `;
}
