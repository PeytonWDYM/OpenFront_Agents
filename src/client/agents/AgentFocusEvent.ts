import { GameEvent } from "../../core/EventBus";

export class AgentFocusEvent implements GameEvent {
  constructor(
    public readonly gameId: string,
    public readonly clientId: string,
  ) {}
}
