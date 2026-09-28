import {
  AllPlayers,
  Game,
  GameUpdates,
  MessageType,
  Player,
} from "../../core/game/Game";
import { GameUpdateType as U } from "../../core/game/GameUpdates";
import { AgentEvent, AgentGameEvent } from "./schemas";

/** Project private native updates before they enter an agent's history. */
export function playerEvents(
  game: Game,
  player: Player,
  updates: GameUpdates,
  previousIncoming?: Set<string>,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const self = player.smallID();
  const playerId = (id: number) => game.playerBySmallID(id).id();
  const add = (type: AgentEvent["type"], data: Record<string, unknown>) =>
    events.push({ type, tick: game.ticks(), at: Date.now(), data });
  if (
    !game.inSpawnPhase() &&
    updates[U.Player].some(
      (update) => update.id === player.id() && update.isAlive === false,
    )
  ) {
    add("eliminated", { playerId: player.id() });
  }
  if (previousIncoming) {
    const incoming = player.incomingAttacks();
    for (const attack of incoming) {
      if (!previousIncoming.has(attack.id()))
        add("incoming_attack", {
          id: attack.id(),
          attackerId: attack.attacker().id(),
        });
    }
    previousIncoming.clear();
    for (const attack of incoming) previousIncoming.add(attack.id());
  }
  for (const event of updates[U.DisplayChatEvent]) {
    if (event.playerID === self)
      add("chat", {
        key: `${event.category}.${event.key}`,
        otherPlayerId: event.recipient,
        direction: event.isFrom ? "incoming" : "outgoing",
        target: event.target,
      });
  }
  for (const event of updates[U.DisplayEvent]) {
    if (event.playerID === null || event.playerID === self) {
      add(
        event.messageType === MessageType.NUKE_DETONATED
          ? "nuke_impact"
          : "game",
        {
          message: event.message,
          params: event.params,
          ...(event.messageType === MessageType.NUKE_DETONATED &&
          event.focusPlayerID !== undefined
            ? { attackerId: playerId(event.focusPlayerID) }
            : {}),
          gold:
            event.goldAmount === undefined
              ? undefined
              : Number(event.goldAmount),
        },
      );
      if (
        event.playerID === self &&
        event.message === "events_display.wants_to_renew_alliance"
      )
        add("alliance_extension_request", {
          requestor:
            event.focusPlayerID === undefined
              ? undefined
              : playerId(event.focusPlayerID),
        });
    }
  }
  for (const event of updates[U.AllianceRequest]) {
    if (event.recipientID === self)
      add("alliance_request", { requestor: playerId(event.requestorID) });
  }
  for (const event of updates[U.AllianceRequestReply]) {
    if (event.request.requestorID === self)
      add("alliance_reply", {
        recipient: playerId(event.request.recipientID),
        accepted: event.accepted,
      });
  }
  for (const event of updates[U.BrokeAlliance]) {
    if (event.betrayedID === self || event.traitorID === self)
      add("alliance_broken", {
        traitor: playerId(event.traitorID),
        betrayed: playerId(event.betrayedID),
      });
  }
  for (const event of updates[U.AllianceExpired]) {
    if (event.player1ID === self || event.player2ID === self)
      add("alliance_expired", {
        other: playerId(
          event.player1ID === self ? event.player2ID : event.player1ID,
        ),
      });
  }
  for (const event of updates[U.AllianceExtension]) {
    if (event.playerID === self)
      add("alliance_extended", { allianceId: event.allianceID });
  }
  for (const event of updates[U.UnitIncoming]) {
    if (event.playerID === self) {
      const unit = game.unit(event.unitID);
      add(
        event.messageType === MessageType.NUKE_INBOUND ||
          event.messageType === MessageType.HYDROGEN_BOMB_INBOUND ||
          event.messageType === MessageType.MIRV_INBOUND
          ? "nuke_incoming"
          : "unit_incoming",
        {
          unitId: event.unitID,
          message: event.message,
          messageType: event.messageType,
          ...(unit
            ? {
                unitType: unit.type(),
                attackerId: unit.owner().id(),
                targetTile: unit.targetTile(),
              }
            : {}),
        },
      );
    }
  }
  for (const event of updates[U.TargetPlayer]) {
    if (player.isFriendly(game.playerBySmallID(event.playerID) as Player))
      add("attack_request", {
        sender: playerId(event.playerID),
        target: playerId(event.targetID),
      });
  }
  for (const event of updates[U.Emoji]) {
    const emoji = event.emoji;
    if (
      emoji.recipientID === AllPlayers ||
      emoji.recipientID === self ||
      emoji.senderID === self
    )
      add("emoji", {
        sender: playerId(emoji.senderID),
        recipient:
          emoji.recipientID === AllPlayers
            ? AllPlayers
            : playerId(emoji.recipientID),
        message: emoji.message,
      });
  }
  for (const event of updates[U.DonateEvent]) {
    if (event.senderId === player.id() || event.recipientId === player.id())
      add("donation", {
        sender: event.senderId,
        recipient: event.recipientId,
        amount: Number(event.amount),
        resource: event.donationType,
      });
  }
  for (const event of updates[U.ConquestEvent])
    add("conquest", {
      conqueror: event.conquerorId,
      conquered: event.conqueredId,
    });
  for (const event of updates[U.SpawnPhaseEnd])
    add("spawn_end", { tick: event.startTick });
  for (const event of updates[U.Win]) add("win", { winner: event.winner });
  return events;
}

/** Wake only the recipient of a new threat or diplomatic event. */
export function isUrgentAgentEvent(
  event: AgentGameEvent,
  selfPlayerId: string,
): boolean {
  switch (event.type) {
    case "incoming_attack":
    case "nuke_incoming":
    case "nuke_impact":
    case "unit_incoming":
    case "alliance_request":
    case "alliance_reply":
    case "alliance_expired":
    case "alliance_extension_request":
      return true;
    case "chat":
      return event.data.direction === "incoming";
    case "alliance_broken":
      return event.data.betrayed === selfPlayerId;
    case "emoji":
      return (
        event.data.recipient === selfPlayerId &&
        event.data.sender !== selfPlayerId
      );
    case "donation":
      return event.data.recipient === selfPlayerId;
    case "attack_request":
      return event.data.sender !== selfPlayerId;
    case "conquest":
      return event.data.conquered === selfPlayerId;
    default:
      return false;
  }
}
