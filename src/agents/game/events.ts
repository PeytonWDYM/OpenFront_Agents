import {
  AllPlayers,
  Game,
  GameUpdates,
  MessageType,
  Player,
  UnitType,
} from "../../core/game/Game";
import { GameUpdateType as U } from "../../core/game/GameUpdates";
import { AgentEvent, AgentGameEvent } from "./schemas";

export interface NuclearEventHistory {
  launched: Set<number>;
  impacted: Set<number>;
}
const nuclearTypes = new Set([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
]);

/** Project private native updates before they enter an agent's history. */
export function playerEvents(
  game: Game,
  player: Player,
  updates: GameUpdates,
  previousIncoming?: Set<string>,
  previousAllianceReminders?: Map<number, number>,
  nuclearHistory?: NuclearEventHistory,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  const self = player.smallID();
  const playerId = (id: number) => game.playerBySmallID(id).id();
  const add = (type: AgentEvent["type"], data: Record<string, unknown>) =>
    events.push({ type, tick: game.ticks(), at: Date.now(), data });
  const publicImpacts = nuclearHistory?.impacted ?? new Set<number>();
  const publicLaunches = nuclearHistory?.launched ?? new Set<number>();
  const impactedPlayers = new Map<number, ReturnType<typeof playerId>[]>();
  for (const event of updates[U.DisplayEvent]) {
    if (
      event.messageType !== MessageType.NUKE_DETONATED ||
      event.unitID === undefined ||
      event.playerID === null
    )
      continue;
    const recipients = impactedPlayers.get(event.unitID) ?? [];
    recipients.push(playerId(event.playerID));
    impactedPlayers.set(event.unitID, recipients);
  }
  if (nuclearHistory) {
    for (const unit of updates[U.Unit]) {
      if (!nuclearTypes.has(unit.unitType)) continue;
      const missile = {
        unitId: unit.id,
        attackerId: playerId(unit.ownerID),
        missileType: unit.unitType,
        targetTile: unit.targetTile,
      };
      if (unit.isActive && !publicLaunches.has(unit.id)) {
        publicLaunches.add(unit.id);
        const incoming = updates[U.UnitIncoming].find(
          (event) => event.unitID === unit.id,
        );
        add("global_nuke_launch", {
          ...missile,
          recipientId:
            incoming && incoming.playerID !== null
              ? playerId(incoming.playerID)
              : undefined,
        });
      }
      // Native detonation sets reachedTarget before deletion. SAM hits and
      // carrier separation leave it false, so neither is an impact.
      if (
        !unit.isActive &&
        unit.reachedTarget &&
        unit.unitType !== UnitType.MIRV &&
        !publicImpacts.has(unit.id)
      ) {
        publicImpacts.add(unit.id);
        add("global_nuke_impact", {
          ...missile,
          impactedPlayerIds: impactedPlayers.get(unit.id) ?? [],
        });
      }
    }
  }
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
  if (previousAllianceReminders) {
    const alliances = player.alliances();
    const activeIds = new Set(alliances.map((alliance) => alliance.id()));
    for (const id of previousAllianceReminders.keys())
      if (!activeIds.has(id)) previousAllianceReminders.delete(id);
    if (!game.config().disableAlliances()) {
      for (const alliance of alliances) {
        const other = alliance.other(player);
        const info = player.allianceInfo(other)!;
        if (
          !info.canExtend ||
          info.expiresAt <= game.ticks() ||
          previousAllianceReminders.get(alliance.id()) === info.expiresAt
        )
          continue;
        previousAllianceReminders.set(alliance.id(), info.expiresAt);
        add("alliance_renewal_available", {
          allianceId: alliance.id(),
          other: other.id(),
          expiresAt: info.expiresAt,
          ticksRemaining: info.expiresAt - game.ticks(),
          otherAgreedToExtend: info.otherAgreedToExtend,
        });
      }
    }
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
    if (event.messageType === MessageType.SAM_HIT) {
      // The native notice goes to the interceptor. Its focus identifies the shooter.
      if (event.playerID === self || event.focusPlayerID === self) {
        add("missile_intercepted", {
          unitId: event.unitID,
          attackerId:
            event.focusPlayerID === undefined
              ? undefined
              : playerId(event.focusPlayerID),
          interceptorId:
            event.playerID === null ? undefined : playerId(event.playerID),
          missileType: event.params?.missileType,
          targetTile: event.params?.targetTile,
        });
      }
      continue;
    }
    if (
      event.messageType === MessageType.NUKE_DETONATED &&
      event.unitID !== undefined &&
      !publicImpacts.has(event.unitID)
    ) {
      publicImpacts.add(event.unitID);
      add("global_nuke_impact", {
        unitId: event.unitID,
        attackerId:
          event.focusPlayerID === undefined
            ? undefined
            : playerId(event.focusPlayerID),
        missileType: event.params?.missileType,
        targetTile: event.params?.targetTile,
        impactedPlayerIds: impactedPlayers.get(event.unitID) ?? [],
      });
    }
    if (
      event.messageType === MessageType.NUKE_DETONATED &&
      event.playerID !== self
    )
      continue;
    if (event.playerID === null || event.playerID === self) {
      if (
        event.playerID === self &&
        event.message === "events_display.trade_ship_captured"
      ) {
        const ship =
          event.unitID === undefined ? undefined : game.unit(event.unitID);
        add("trade_ship_captured", {
          unitId: event.unitID,
          captorId:
            event.focusPlayerID === undefined
              ? undefined
              : playerId(event.focusPlayerID),
          ...(ship ? { tile: ship.tile() } : {}),
        });
        continue;
      }
      add(
        event.messageType === MessageType.NUKE_DETONATED
          ? "nuke_impact"
          : "game",
        {
          message: event.message,
          params: event.params,
          ...(event.messageType === MessageType.NUKE_DETONATED
            ? {
                unitId: event.unitID,
                missileType: event.params?.missileType,
                targetTile: event.params?.targetTile,
              }
            : {}),
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
      if (
        event.playerID === self &&
        event.message === "events_display.alliance_renewed"
      ) {
        const other = game.playerBySmallID(event.focusPlayerID!) as Player;
        const alliance = player.allianceWith(other)!;
        add("alliance_extended", {
          allianceId: alliance.id(),
          other: other.id(),
          expiresAt: alliance.expiresAt(),
        });
      }
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
        traitorRemainingTicks: (
          game.playerBySmallID(event.traitorID) as Player
        ).getTraitorRemainingTicks(),
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
  for (const event of updates[U.UnitIncoming]) {
    const nuclear =
      event.messageType === MessageType.NUKE_INBOUND ||
      event.messageType === MessageType.HYDROGEN_BOMB_INBOUND ||
      event.messageType === MessageType.MIRV_INBOUND;
    const unit = game.unit(event.unitID);
    const update = updates[U.Unit].find((update) => update.id === event.unitID);
    const missile = {
      unitId: event.unitID,
      missileType: unit?.type() ?? update?.unitType,
      attackerId:
        unit?.owner().id() ?? (update ? playerId(update.ownerID) : undefined),
      targetTile: unit?.targetTile() ?? update?.targetTile,
    };
    if (nuclear && !publicLaunches.has(event.unitID)) {
      publicLaunches.add(event.unitID);
      add("global_nuke_launch", {
        ...missile,
        recipientId:
          event.playerID === null ? undefined : playerId(event.playerID),
      });
    }
    if (event.playerID === self) {
      add(nuclear ? "nuke_incoming" : "unit_incoming", {
        ...missile,
        message: event.message,
        messageType: event.messageType,
        ...(unit
          ? {
              unitType: unit.type(),
              attackerId: unit.owner().id(),
              targetTile: unit.targetTile(),
            }
          : {}),
      });
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
    case "alliance_renewal_available":
      return true;
    case "missile_intercepted":
      return event.data.attackerId === selfPlayerId;
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

/** Retain threats and diplomacy before routine map notices, preserving order. */
export function selectAgentEvents<T extends AgentGameEvent>(
  events: readonly T[],
  limit: number,
  selfPlayerId: string,
): T[] {
  if (limit <= 0) return [];
  const priority = (event: T) =>
    isUrgentAgentEvent(event, selfPlayerId) ||
    event.type === "eliminated" ||
    event.type === "win"
      ? 3
      : event.type === "alliance_extended" ||
          event.type === "alliance_broken" ||
          event.type === "missile_intercepted"
        ? 2
        : event.type === "global_nuke_launch" ||
            event.type === "global_nuke_impact"
          ? 1
          : 0;
  const selected = events
    .map((event, index) => ({ event, index, priority: priority(event) }))
    .sort((a, b) => b.priority - a.priority || b.index - a.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
  return selected.map(({ event }) => event);
}
