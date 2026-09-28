import { html, nothing } from "lit";
import { translateText } from "../Utils";
import { AgentLobby } from "./AgentApi";
import { agentTokenUsage } from "./AgentUsage";

type Player = AgentLobby["players"][number];

export function agentPlayerList(
  lobby: AgentLobby,
  inspect: (player: Player) => void,
) {
  return html`
    <ul class="players">
      ${lobby.players.map(
        (player) => html`
          <li>
            <button class="player" @click=${() => inspect(player)}>
              <span class="player-head">
                <strong>${player.name}</strong>
                <span class="player-status ${player.alive ? "" : "dead"}">
                  ${translateText(
                    player.alive ? "agents.alive" : "agents.not_alive",
                  )}
                </span>
              </span>
              <span class="player-stats">
                <span>${translateText(`agents.status_${player.status}`)}</span>
                <span
                  >${translateText("agents.decisions", {
                    count: player.decisions,
                  })}</span
                >
                <span class="player-usage"
                  >${agentTokenUsage(
                    lobby.settings.mode,
                    player.tokens,
                    player.status === "thinking",
                  )}</span
                >
              </span>
              <span class="last-action" title=${player.lastAction ?? ""}>
                ${player.lastAction
                  ? translateText("agents.last_action", {
                      action: (
                        JSON.parse(player.lastAction) as { type: string }
                      ).type,
                    })
                  : translateText("agents.no_decision")}
              </span>
              ${player.error
                ? html`<span class="error">${player.error}</span>`
                : nothing}
            </button>
          </li>
        `,
      )}
    </ul>
  `;
}
