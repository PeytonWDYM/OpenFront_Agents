import { html, nothing } from "lit";
import { translateText } from "../Utils";
import { AgentTranscript } from "./AgentApi";

interface TranscriptControls {
  transcript: AgentTranscript | null;
  busy: boolean;
  canCompact: boolean;
  fullThread: boolean;
  loadFull: () => void;
  compact: () => void;
}

export function agentTranscriptControls({
  transcript,
  busy,
  canCompact,
  fullThread,
  loadFull,
  compact,
}: TranscriptControls) {
  return html`
    <div class="toolbar thread-controls">
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
  `;
}

export function agentTranscript(
  transcript: AgentTranscript | null,
  fullThread: boolean,
) {
  return html`
    <section aria-label=${translateText("agents.transcript")}>
      ${transcript === null
        ? html`<p class="muted">${translateText("agents.loading")}</p>`
        : html`
            <details class="thread-info">
              <summary>${translateText("agents.thread_details")}</summary>
              <p class="thread-id">
                ${transcript.player.threadId ??
                translateText("agents.no_thread")}
              </p>
              <p class="muted">
                ${translateText(
                  fullThread
                    ? "agents.full_thread_help"
                    : "agents.transcript_help",
                )}
              </p>
            </details>
            ${transcript.events.length === 0
              ? html`<p class="muted">${translateText("agents.no_events")}</p>`
              : transcript.events.map((event) => {
                  const text = event.text.trimStart();
                  const structured =
                    text.startsWith("{") || text.startsWith("[");
                  return html`
                    <article class="transcript-event">
                      <div class="event-meta">
                        <span class="event-type">${event.type}</span>
                        <time datetime=${new Date(event.time).toISOString()}>
                          ${new Date(event.time).toLocaleTimeString()}
                        </time>
                      </div>
                      ${event.image
                        ? html`<img
                            class="vision-image"
                            src=${event.image}
                            alt=${translateText("agents.vision_image")}
                            loading="lazy"
                          />`
                        : nothing}
                      <p class="event-preview">
                        ${structured
                          ? translateText("agents.structured_event")
                          : event.text}
                      </p>
                      <details class="event-details">
                        <summary>
                          ${translateText("agents.event_details")}
                        </summary>
                        <pre>${event.text}</pre>
                      </details>
                    </article>
                  `;
                })}
          `}
    </section>
  `;
}
