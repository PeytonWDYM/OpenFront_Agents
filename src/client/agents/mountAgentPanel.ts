import { EventBus } from "../../core/EventBus";
import { LobbyInfoEvent } from "../../core/Schemas";
import { AgentFocusEvent } from "./AgentFocusEvent";
import { AgentPanel } from "./AgentPanel";

export function mountAgentPanel(
  eventBus: EventBus,
  joinLobby: (gameId: string, spectator: boolean) => void,
): void {
  const panel = new AgentPanel();
  panel.joinLobby = joinLobby;
  panel.focusPlayer = (gameId, clientId) =>
    eventBus.emit(new AgentFocusEvent(gameId, clientId));
  eventBus.on(LobbyInfoEvent, (event) => panel.acceptLobbyInfo(event));
  document.body.append(panel);
}
