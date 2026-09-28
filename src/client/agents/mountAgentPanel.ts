import { EventBus } from "../../core/EventBus";
import { LobbyInfoEvent } from "../../core/Schemas";
import { AgentPanel } from "./AgentPanel";

export function mountAgentPanel(
  eventBus: EventBus,
  joinLobby: (gameId: string, spectator: boolean) => void,
): void {
  const panel = new AgentPanel();
  panel.joinLobby = joinLobby;
  eventBus.on(LobbyInfoEvent, (event) => panel.acceptLobbyInfo(event));
  document.body.append(panel);
}
