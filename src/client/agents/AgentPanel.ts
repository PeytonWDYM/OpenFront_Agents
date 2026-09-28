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
import { agentControls } from "./AgentControls";
import {
  AgentRole,
  agentLobbyForm,
  defaultAgentSettings,
} from "./AgentLobbyForm";
import { agentPanelStyles } from "./AgentPanelStyles";
import { agentPlayerList } from "./AgentPlayerList";
import { agentTranscript, agentTranscriptControls } from "./AgentTranscript";
import { agentTokenUsage } from "./AgentUsage";

const panelOpenKey = "openfront.agentPanelOpen";
const pendingGameKey = "openfront.agentPendingGame";
const pendingRoleKey = "openfront.agentPendingRole";

@customElement("agent-panel")
export class AgentPanel extends LitElement {
  static styles = agentPanelStyles;

  joinLobby: (gameId: string, spectator: boolean) => void;
  focusPlayer: (gameId: string, clientId: string) => void;
  @state() private opened = sessionStorage.getItem(panelOpenKey) === "true";
  @state() private lobby: AgentLobby | null = null;
  @state() private showSetup = true;
  @state() private busy = false;
  @state() private error = "";
  @state() private selectedId: string | null = null;
  @state() private transcript: AgentTranscript | null = null;
  @state() private fullThread = false;
  @state() private joinedGameId: string | null = null;
  @state() private joinedRole: AgentRole | null = null;
  @state() private joining = false;
  private joinedClientId = "";
  private pendingGameId = sessionStorage.getItem(pendingGameKey);
  private pendingRole = sessionStorage.getItem(pendingRoleKey);
  private starting = false;
  private startFailed = false;
  private mutationVersion = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight = false;
  private readonly stopGameInput = (event: Event) => event.stopPropagation();

  connectedCallback(): void {
    super.connectedCallback();
    // Block global shortcuts and hover. Releases must reach the map to finish drags.
    for (const event of ["pointermove", "wheel", "keydown", "keyup"]) {
      this.addEventListener(event, this.stopGameInput);
    }
    if (this.opened || this.pendingGameId !== null) void this.refresh();
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
    this.joinedClientId = event.myClientID;
    this.joining = false;
    void this.startAfterJoin();
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
    const mutationVersion = this.mutationVersion;
    try {
      const lobby = await agentRequest<AgentLobby>();
      if (mutationVersion !== this.mutationVersion) return;
      if (this.lobby === null) this.showSetup = lobby.phase === "idle";
      if (this.lobby?.gameId !== lobby.gameId) {
        this.selectedId = null;
        this.transcript = null;
        this.fullThread = false;
      }
      this.lobby = lobby;
      this.error = "";
      if (!this.fullThread) await this.loadTranscript();
      if (lobby.phase !== "lobby" && lobby.phase !== "idle")
        this.clearPendingJoin();
      else void this.startAfterJoin();
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
    this.mutationVersion++;
    if (path === "/stop") {
      this.clearPendingJoin();
      this.joining = false;
    }
    this.busy = true;
    this.error = "";
    try {
      await agentRequest<unknown>(path, body);
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

  private async createAndJoin(
    settings: AgentSettings,
    role: AgentRole,
  ): Promise<void> {
    this.mutationVersion++;
    this.busy = true;
    this.error = "";
    try {
      this.lobby = await agentRequest<AgentLobby>("/create", settings);
      this.showSetup = false;
      this.selectedId = null;
      this.transcript = null;
      this.fullThread = false;
      this.joinedGameId = null;
      this.joinedRole = null;
      this.chooseRole(role);
    } catch (error) {
      this.error =
        error instanceof Error
          ? error.message
          : translateText("agents.unavailable");
    } finally {
      this.busy = false;
    }
  }

  private chooseRole(role: AgentRole): void {
    this.pendingGameId = this.lobby!.gameId!;
    this.pendingRole = role;
    sessionStorage.setItem(pendingGameKey, this.pendingGameId);
    sessionStorage.setItem(pendingRoleKey, role);
    this.startFailed = false;
    this.joining = true;
    this.joinLobby(this.lobby!.gameId!, role === "spectate");
  }

  private clearPendingJoin(): void {
    this.pendingGameId = null;
    this.pendingRole = null;
    sessionStorage.removeItem(pendingGameKey);
    sessionStorage.removeItem(pendingRoleKey);
  }

  // The native lobby event proves the server accepted this client's chosen role.
  private async startAfterJoin(): Promise<void> {
    if (
      this.starting ||
      this.startFailed ||
      this.lobby?.phase !== "lobby" ||
      this.pendingGameId !== this.lobby.gameId ||
      this.joinedGameId !== this.pendingGameId ||
      this.joinedRole !== this.pendingRole
    )
      return;
    this.mutationVersion++;
    this.starting = true;
    this.busy = true;
    try {
      this.lobby = await agentRequest<AgentLobby>("/start", {
        clientId: this.joinedClientId,
        spectator: this.joinedRole === "spectate",
      });
      this.clearPendingJoin();
    } catch (error) {
      this.startFailed = true;
      this.error =
        error instanceof Error
          ? error.message
          : translateText("agents.unavailable");
    } finally {
      this.starting = false;
      this.busy = false;
    }
  }

  private async inspect(player: AgentLobby["players"][number]): Promise<void> {
    const id = player.id;
    this.focusPlayer(this.lobby!.gameId!, player.clientId);
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

  private renderHeader(lobby: AgentLobby | null) {
    const inspecting = !this.showSetup && this.selectedId !== null;
    const selectedPlayer = inspecting
      ? lobby?.players.find((player) => player.id === this.selectedId)
      : undefined;
    const usage = lobby
      ? inspecting
        ? selectedPlayer
          ? agentTokenUsage(
              lobby.settings.mode,
              selectedPlayer.tokens,
              selectedPlayer.status === "thinking",
            )
          : translateText("agents.loading")
        : agentTokenUsage(
            lobby.settings.mode,
            lobby.totalTokens,
            lobby.players.some((player) => player.status === "thinking"),
          )
      : "";
    return html`
      <header class="panel-header">
        <div class="header-main">
          <div class="header-heading">
            ${this.showSetup
              ? nothing
              : html`<span class="eyebrow"
                  >${translateText("agents.title")}</span
                >`}
            <h2>
              ${this.showSetup
                ? translateText("agents.title")
                : inspecting
                  ? (selectedPlayer?.name ?? translateText("agents.loading"))
                  : translateText("agents.all_agents")}
            </h2>
          </div>
          <button
            class="hide-control"
            @click=${this.toggle}
            aria-label=${translateText("agents.hide")}
          >
            ${translateText("agents.hide")}
          </button>
        </div>
        ${!this.showSetup && lobby
          ? html`
              <div class="header-summary">
                <span class="phase-badge"
                  >${translateText(`agents.phase_${lobby.phase}`)}</span
                >
                <strong
                  class="usage"
                  aria-live="polite"
                  aria-label=${translateText(
                    inspecting ? "agents.player_usage" : "agents.total_usage",
                  )}
                  title=${lobby.settings.mode === "codex"
                    ? translateText("agents.usage_help")
                    : ""}
                >
                  ${usage}
                </strong>
              </div>
              <div class="header-model">
                ${translateText(
                  lobby.settings.mode === "codex"
                    ? "agents.model"
                    : "agents.scripted_mode",
                )}
              </div>
              <div class="header-actions">
                ${inspecting
                  ? html`<button
                      class="back-control"
                      @click=${() => {
                        this.selectedId = null;
                        this.transcript = null;
                        this.fullThread = false;
                      }}
                    >
                      <span aria-hidden="true">‹</span> ${translateText(
                        "agents.back",
                      )}
                    </button>`
                  : nothing}
                ${agentControls({
                  lobby,
                  busy: this.busy,
                  joining: this.joining,
                  joined: this.joinedGameId === lobby.gameId,
                  startFailed: this.startFailed,
                  chooseRole: (role) => this.chooseRole(role),
                  action: (path) => void this.mutate(path),
                  newLobby: () => {
                    this.showSetup = true;
                    this.selectedId = null;
                  },
                })}
              </div>
              ${inspecting
                ? agentTranscriptControls({
                    transcript: this.transcript,
                    busy: this.busy,
                    canCompact:
                      lobby.phase === "lobby" || lobby.phase === "paused",
                    fullThread: this.fullThread,
                    loadFull: () => void this.loadFullThread(),
                    compact: () =>
                      void this.mutate(
                        `/players/${encodeURIComponent(this.selectedId!)}/compact`,
                      ),
                  })
                : nothing}
            `
          : nothing}
      </header>
    `;
  }

  private renderLobby(lobby: AgentLobby) {
    return html`
      ${lobby.error ? html`<p class="error">${lobby.error}</p>` : nothing}
      <details class="panel-info">
        <summary>${translateText("agents.lobby_help")}</summary>
        ${lobby.settings.mode === "codex"
          ? html`<p class="muted">${translateText("agents.usage_help")}</p>`
          : nothing}
        <p class="muted">${translateText("agents.inspect_help")}</p>
        ${lobby.phase === "paused"
          ? html`<p class="muted">${translateText("agents.pause_help")}</p>`
          : nothing}
        ${lobby.phase === "lobby"
          ? html`<p class="muted">${translateText("agents.choose_role")}</p>`
          : nothing}
      </details>
      ${this.selectedId !== null
        ? agentTranscript(this.transcript, this.fullThread)
        : agentPlayerList(lobby, (player) => void this.inspect(player))}
    `;
  }

  protected render() {
    if (!this.opened)
      return html`<button class="entry" @click=${this.toggle}>
        ${translateText("agents.title")}
      </button>`;
    return html`
      <section class="panel" aria-label=${translateText("agents.title")}>
        ${this.renderHeader(this.lobby)}
        <div class="body">
          ${this.error
            ? html`<p class="error" role="alert">${this.error}</p>`
            : nothing}
          ${this.lobby?.runtime.error
            ? html`<p class="error">${this.lobby.runtime.error}</p>`
            : nothing}
          ${this.showSetup
            ? html`
                <p class="muted auth-status">
                  ${translateText(
                    this.lobby?.runtime.authenticated
                      ? "agents.authenticated"
                      : "agents.auth_required",
                  )}
                </p>
                ${agentLobbyForm(
                  this.lobby?.settings ?? defaultAgentSettings,
                  this.busy,
                  (settings, role) => void this.createAndJoin(settings, role),
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
