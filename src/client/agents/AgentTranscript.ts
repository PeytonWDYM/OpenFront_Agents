import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { translateText } from "../Utils";
import { AgentTranscript } from "./AgentApi";
import { transcriptEntries } from "./TranscriptEvents";

interface TranscriptControls {
  transcript: AgentTranscript | null;
  busy: boolean;
  canCompact: boolean;
  fullThread: boolean;
  loadFull: () => void;
  compact: () => void;
  diagnostics: boolean;
  setDiagnostics: (enabled: boolean) => void;
  following: boolean;
  followLatest: () => void;
}

export function agentTranscriptControls({
  transcript,
  busy,
  canCompact,
  fullThread,
  loadFull,
  compact,
  diagnostics,
  setDiagnostics,
  following,
  followLatest,
}: TranscriptControls) {
  return html`
    <div class="toolbar thread-controls">
      <label class="diagnostics-control">
        <input
          type="checkbox"
          .checked=${diagnostics}
          @change=${(event: Event) =>
            setDiagnostics((event.target as HTMLInputElement).checked)}
        />
        ${translateText("agents.show_diagnostics")}
      </label>
      <button
        class="latest-control"
        ?disabled=${following}
        @click=${followLatest}
      >
        ${translateText("agents.latest")}
      </button>
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
  diagnostics: boolean,
) {
  const entries = transcript
    ? transcriptEntries(transcript.events, diagnostics)
    : [];
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
            ${entries.length === 0
              ? html`<p class="muted">${translateText("agents.no_events")}</p>`
              : repeat(
                  entries,
                  (entry) => entry.key,
                  ({ key, event, preview, label }) => {
                    return html`
                      <article class="transcript-event" data-event-key=${key}>
                        <div class="event-meta">
                          <span class="event-type">${label}</span>
                          <time datetime=${new Date(event.time).toISOString()}>
                            ${new Date(event.time).toLocaleTimeString()}
                          </time>
                        </div>
                        <p class="event-preview">${preview}</p>
                        ${event.image
                          ? html`<div class="vision-preview">
                              <img
                                class="vision-image"
                                src=${event.image}
                                alt=${translateText("agents.vision_image")}
                                loading="lazy"
                              />
                            </div>`
                          : nothing}
                        <details class="event-details">
                          <summary>
                            ${translateText("agents.event_details")}
                          </summary>
                          <pre>${event.text}</pre>
                        </details>
                      </article>
                    `;
                  },
                )}
          `}
    </section>
  `;
}
