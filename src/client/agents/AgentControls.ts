import { html, nothing } from "lit";
import { translateText } from "../Utils";
import { AgentLobby } from "./AgentApi";
import { AgentRole } from "./AgentLobbyForm";

interface LobbyControls {
  lobby: AgentLobby;
  busy: boolean;
  joining: boolean;
  joined: boolean;
  startFailed: boolean;
  chooseRole: (role: AgentRole) => void;
  action: (path: string) => void;
  newLobby: () => void;
}

export function agentControls({
  lobby,
  busy,
  joining,
  joined,
  startFailed,
  chooseRole,
  action,
  newLobby,
}: LobbyControls) {
  return html`
    <div class="toolbar arena-controls">
      ${lobby.phase === "lobby" && (!joined || startFailed)
        ? html`
            <button
              ?disabled=${busy || joining}
              @click=${() => chooseRole("play")}
            >
              ${translateText("agents.play")}
            </button>
            <button
              ?disabled=${busy || joining}
              @click=${() => chooseRole("spectate")}
            >
              ${translateText("agents.spectate")}
            </button>
          `
        : nothing}
      ${lobby.phase === "running"
        ? html`<button ?disabled=${busy} @click=${() => action("/pause")}>
            ${translateText("agents.pause")}
          </button>`
        : nothing}
      ${lobby.phase === "paused"
        ? html`<button ?disabled=${busy} @click=${() => action("/resume")}>
            ${translateText("agents.resume")}
          </button>`
        : nothing}
      ${["lobby", "running", "paused", "error"].includes(lobby.phase)
        ? html`<button
            class="stop-control"
            ?disabled=${busy}
            @click=${() => action("/stop")}
          >
            ${translateText("agents.stop")}
          </button>`
        : nothing}
      ${["stopped", "error"].includes(lobby.phase)
        ? html`<button ?disabled=${busy} @click=${newLobby}>
            ${translateText("agents.new_lobby")}
          </button>`
        : nothing}
    </div>
    ${joining
      ? html`<p class="join-status">${translateText("agents.joining")}</p>`
      : nothing}
  `;
}
