import { AllPlayers, Game, GameUpdates, Player } from "../../core/game/Game";
import { GameUpdateType as U } from "../../core/game/GameUpdates";
import { AgentEvent } from "./schemas";

/** Project private native updates before they enter an agent's history. */
export function playerEvents(
  game: Game,
  player: Player,
  updates: GameUpdates,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const self = player.smallID();
  const playerId = (id: number) => game.playerBySmallID(id).id();
  const add = (type: string, data: Record<string, unknown>) =>
    events.push({ type, tick: game.ticks(), at: Date.now(), data });
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
    if (event.playerID === null || event.playerID === self)
      add("game", {
        message: event.message,
        params: event.params,
        gold:
          event.goldAmount === undefined ? undefined : Number(event.goldAmount),
      });
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
    if (event.playerID === self)
      add("unit_incoming", { unitId: event.unitID, message: event.message });
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
