import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LobbyInfoEvent } from "../../core/Schemas";
import { translateText } from "../Utils";
import {
  AgentLobby,
  AgentSettings,
  AgentTranscript,
  agentRequest,
} from "./AgentApi";
import { agentLobbyForm, defaultAgentSettings } from "./AgentLobbyForm";
import { agentPanelStyles } from "./AgentPanelStyles";
import { agentTranscript } from "./AgentTranscript";

type Role = "play" | "spectate";
const panelOpenKey = "openfront.agentPanelOpen";

@customElement("agent-panel")
export class AgentPanel extends LitElement {
  static styles = agentPanelStyles;

  joinLobby: (gameId: string, spectator: boolean) => void;
  @state() private opened = sessionStorage.getItem(panelOpenKey) === "true";
  @state() private lobby: AgentLobby | null = null;
  @state() private showSetup = true;
  @state() private busy = false;
  @state() private error = "";
  @state() private selectedId: string | null = null;
  @state() private transcript: AgentTranscript | null = null;
  @state() private fullThread = false;
  @state() private joinedGameId: string | null = null;
  @state() private joinedRole: Role | null = null;
  @state() private joining = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight = false;
  private readonly stopGameInput = (event: Event) => event.stopPropagation();

  connectedCallback(): void {
    super.connectedCallback();
    // Block global shortcuts and hover. Releases must reach the map to finish drags.
    for (const event of ["pointermove", "wheel", "keydown", "keyup"]) {
      this.addEventListener(event, this.stopGameInput);
    }
    if (this.opened) void this.refresh();
  }

  disconnectedCallback(): void {
    clearTimeout(this.pollTimer);
    super.disconnectedCallback();
  }

  acceptLobbyInfo(event: LobbyInfoEvent): void {
    const self = event.lobby.clients?.find(
      (player) => player.clientID === event.myClientID,
    );
    if (!self) return;
    this.joinedGameId = event.lobby.gameID;
    this.joinedRole = self.spectator === true ? "spectate" : "play";
    this.joining = false;
  }

  private toggle(): void {
    this.opened = !this.opened;
    sessionStorage.setItem(panelOpenKey, String(this.opened));
    if (this.opened) void this.refresh();
    else clearTimeout(this.pollTimer);
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return;
    clearTimeout(this.pollTimer);
    this.refreshInFlight = true;
    try {
      const lobby = await agentRequest<AgentLobby>();
      if (this.lobby === null) this.showSetup = lobby.phase === "idle";
      if (this.lobby?.gameId !== lobby.gameId) {
        this.selectedId = null;
        this.transcript = null;
        this.fullThread = false;
      }
      this.lobby = lobby;
      this.error = "";
      if (!this.fullThread) await this.loadTranscript();
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : translateText("agents.unavailable");
    } finally {
      this.refreshInFlight = false;
      if (this.opened && this.isConnected) {
        this.pollTimer = setTimeout(() => void this.refresh(), 2000);
      }
    }
  }

  private async loadTranscript(full = false): Promise<void> {
    const id = this.selectedId;
    if (id === null) return;
    const transcript = await agentRequest<AgentTranscript>(
      `/players/${encodeURIComponent(id)}${full ? "?full=1" : ""}`,
    );
    if (this.selectedId === id && this.fullThread === full)
      this.transcript = transcript;
  }

  private async loadFullThread(): Promise<void> {
    this.fullThread = true;
    this.busy = true;
    this.error = "";
    try {
      await this.loadTranscript(true);
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : translateText("agents.unavailable");
    } finally {
      this.busy = false;
    }
  }

  private async mutate(
    path: string,
    body: AgentSettings | Record<string, never> = {},
  ): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      await agentRequest<unknown>(path, body);
      if (path === "/create") {
        this.showSetup = false;
        this.selectedId = null;
        this.transcript = null;
        this.joinedGameId = null;
        this.joinedRole = null;
      }
      await this.refresh();
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : translateText("agents.unavailable");
    } finally {
      this.busy = false;
    }
  }

  private chooseRole(role: Role): void {
    this.joining = true;
    this.joinLobby(this.lobby!.gameId!, role === "spectate");
  }

  private async inspect(id: string): Promise<void> {
    this.selectedId = id;
    this.transcript = null;
    this.fullThread = false;
    try {
      await this.loadTranscript();
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : translateText("agents.unavailable");
    }
  }

  private renderControls(lobby: AgentLobby) {
    const joined = this.joinedGameId === lobby.gameId;
    return html`
      ${lobby.phase === "lobby"
        ? html`
            <p class="muted">
              ${translateText(
                joined
                  ? this.joinedRole === "spectate"
                    ? "agents.spectating"
                    : "agents.playing"
                  : "agents.choose_role",
              )}
            </p>
            <div class="toolbar">
              ${!joined
                ? html`
                    <button
                      ?disabled=${this.busy || this.joining}
                      @click=${() => this.chooseRole("play")}
                    >
                      ${translateText("agents.play")}
                    </button>
                    <button
                      ?disabled=${this.busy || this.joining}
                      @click=${() => this.chooseRole("spectate")}
                    >
                      ${translateText("agents.spectate")}
                    </button>
                  `
                : nothing}
              <button
                class="primary"
                ?disabled=${this.busy || !joined}
                @click=${() => void this.mutate("/start")}
              >
                ${translateText("agents.start")}
              </button>
            </div>
            ${this.joining
              ? html`<p class="muted">${translateText("agents.joining")}</p>`
              : nothing}
          `
        : nothing}
      <div class="toolbar">
        ${lobby.phase === "running"
          ? html`<button
              ?disabled=${this.busy}
              @click=${() => void this.mutate("/pause")}
            >
              ${translateText("agents.pause")}
            </button>`
          : nothing}
        ${lobby.phase === "paused"
          ? html`<button
              ?disabled=${this.busy}
              @click=${() => void this.mutate("/resume")}
            >
              ${translateText("agents.resume")}
            </button>`
          : nothing}
        ${["lobby", "running", "paused", "error"].includes(lobby.phase)
          ? html`<button
              ?disabled=${this.busy}
              @click=${() => void this.mutate("/stop")}
            >
              ${translateText("agents.stop")}
            </button>`
          : nothing}
        ${["stopped", "error"].includes(lobby.phase)
          ? html`<button
              ?disabled=${this.busy}
              @click=${() => {
                this.showSetup = true;
                this.selectedId = null;
              }}
            >
              ${translateText("agents.new_lobby")}
            </button>`
          : nothing}
      </div>
      ${lobby.phase === "paused"
        ? html`<p class="muted">${translateText("agents.pause_help")}</p>`
        : nothing}
    `;
  }

  private renderLobby(lobby: AgentLobby) {
    return html`
      <div class="status">
        <strong>${translateText(`agents.phase_${lobby.phase}`)}</strong
        ><span
          >${translateText("agents.tokens", {
            count: lobby.totalTokens.toLocaleString(),
          })}</span
        >
      </div>
      <p class="muted">
        ${translateText(
          lobby.settings.mode === "codex"
            ? "agents.model"
            : "agents.scripted_mode",
        )}
      </p>
      ${lobby.error ? html`<p class="error">${lobby.error}</p>` : nothing}
      ${this.renderControls(lobby)}
      ${this.selectedId !== null
        ? agentTranscript({
            transcript: this.transcript,
            busy: this.busy,
            canCompact: lobby.phase === "lobby" || lobby.phase === "paused",
            fullThread: this.fullThread,
            loadFull: () => void this.loadFullThread(),
            compact: () =>
              void this.mutate(
                `/players/${encodeURIComponent(this.selectedId!)}/compact`,
              ),
            back: () => {
              this.selectedId = null;
              this.transcript = null;
              this.fullThread = false;
            },
          })
        : html`
            <p class="muted">${translateText("agents.inspect_help")}</p>
            <ul class="players">
              ${lobby.players.map(
                (player) => html`
                  <li>
                    <button
                      class="player"
                      @click=${() => void this.inspect(player.id)}
                    >
                      <span class="player-head"
                        ><strong>${player.name}</strong
                        ><span
                          class="player-status ${player.alive ? "" : "dead"}"
                          >${translateText(
                            player.alive ? "agents.alive" : "agents.not_alive",
                          )}</span
                        ></span
                      >
                      <span class="muted"
                        >${translateText(`agents.status_${player.status}`)} ·
                        ${translateText("agents.decisions", {
                          count: player.decisions,
                        })}
                        ·
                        ${translateText("agents.tokens", {
                          count: player.tokens.toLocaleString(),
                        })}</span
                      >
                      <span class="muted"
                        >${player.lastAction ??
                        translateText("agents.no_decision")}</span
                      >
                      ${player.error
                        ? html`<span class="error">${player.error}</span>`
                        : nothing}
                    </button>
                  </li>
                `,
              )}
            </ul>
          `}
    `;
  }

  protected render() {
    if (!this.opened)
      return html`<button class="entry" @click=${this.toggle}>
        ${translateText("agents.title")}
      </button>`;
    return html`
      <section class="panel" aria-label=${translateText("agents.title")}>
        <header>
          <h2>${translateText("agents.title")}</h2>
          <button
            @click=${this.toggle}
            aria-label=${translateText("agents.hide")}
          >
            ${translateText("agents.hide")}
          </button>
        </header>
        <div class="body">
          ${this.error
            ? html`<p class="error" role="alert">${this.error}</p>`
            : nothing}
          ${this.lobby?.runtime.error
            ? html`<p class="error">${this.lobby.runtime.error}</p>`
            : nothing}
          ${this.showSetup
            ? html`
                <p class="muted">
                  ${translateText(
                    this.lobby?.runtime.authenticated
                      ? "agents.authenticated"
                      : "agents.auth_required",
                  )}
                </p>
                ${agentLobbyForm(
                  this.lobby?.settings ?? defaultAgentSettings,
                  this.busy,
                  (settings) => void this.mutate("/create", settings),
                )}
              `
            : this.lobby
              ? this.renderLobby(this.lobby)
              : html`<p class="muted">${translateText("agents.loading")}</p>`}
        </div>
      </section>
    `;
  }
}
