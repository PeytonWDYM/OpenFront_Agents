import {
  AgentObservation,
  ObserveQuery,
  emojiChoices,
  quickChatKeys,
} from "./schemas";

/** Keep the decision snapshot small. Full observations remain available to the inspector. */
export function projectDecisionObservation(
  observation: AgentObservation,
  sections?: ObserveQuery["sections"],
) {
  const include = (section: NonNullable<ObserveQuery["sections"]>[number]) =>
    sections === undefined || sections.includes(section);
  const { canSendEmojiAllPlayers, canEmbargoAll, units, unitSummary, ...self } =
    observation.self;
  const {
    cells,
    region,
    buildCosts,
    buildSites,
    publicStructures,
    tradeTraffic,
    ...map
  } = observation.map;
  const relevantIds = new Set([
    ...observation.self.allies,
    ...observation.self.incomingAllianceRequests,
    ...observation.self.incomingAttacks.map((attack) => attack.attackerId),
    ...observation.self.outgoingAttacks.flatMap((attack) =>
      attack.targetId ? [attack.targetId] : [],
    ),
  ]);
  for (const event of observation.events) {
    const other =
      event.data.otherPlayerId ??
      event.data.requestor ??
      event.data.attackerId ??
      event.data.captorId ??
      event.data.sender;
    if (typeof other === "string") relevantIds.add(other);
  }
  const rivals = observation.rivals.filter(
    (rival, index) =>
      (sections !== undefined && sections.includes("rivals")) ||
      index < 6 ||
      rival.allied ||
      rival.sharesBorder ||
      relevantIds.has(rival.playerId),
  );
  return {
    gameId: observation.gameId,
    tick: observation.tick,
    spawnPhase: observation.spawnPhase,
    victory: observation.victory,
    offense: observation.offense,
    ...(include("self") ? { economy: observation.economy } : {}),
    ...(include("leaderboard")
      ? {
          leaderboard: sections?.includes("leaderboard")
            ? observation.leaderboard
            : {
                selfRank: observation.leaderboard.selfRank,
                players: observation.leaderboard.players
                  .filter(
                    (row) =>
                      row.rank <= 5 ||
                      row.playerId === observation.self.playerId,
                  )
                  .map(
                    ({
                      rank,
                      playerId,
                      name,
                      playerType,
                      landPercent,
                      gold,
                      troops,
                    }) => ({
                      rank,
                      playerId,
                      name,
                      playerType,
                      landPercent,
                      gold,
                      troops,
                    }),
                  ),
                ...(observation.leaderboard.teams.length
                  ? { teams: observation.leaderboard.teams }
                  : {}),
              },
        }
      : {}),
    ...(include("self")
      ? {
          self: {
            ...self,
            availableActions: [
              ...(canSendEmojiAllPlayers ? ["emoji:AllPlayers"] : []),
              ...(canEmbargoAll ? ["embargo_all"] : []),
            ],
          },
        }
      : {}),
    ...(include("units")
      ? { units, unitSummary, militaryIntel: observation.militaryIntel }
      : {}),
    ...(include("units") && publicStructures !== undefined
      ? { publicStructures }
      : {}),
    ...(sections?.includes("units") && !sections.includes("map")
      ? { tradeTraffic }
      : {}),
    ...(include("rivals")
      ? {
          rivals: rivals.map((rival) => ({
            playerId: rival.playerId,
            name: rival.name,
            playerType: rival.playerType,
            smallId: rival.smallId,
            ...(rival.position ? { position: rival.position } : {}),
            tiles: rival.tiles,
            troops: rival.troops,
            gold: rival.gold,
            maxTroops: rival.maxTroops,
            ...(rival.allied
              ? { allied: true, allianceExpiresAt: rival.allianceExpiresAt }
              : {}),
            ...(rival.sharesBorder ? { sharesBorder: true } : {}),
            ...(rival.embargoed ? { embargoed: true } : {}),
            availableActions: [
              ...(rival.canAttack ? ["attack"] : []),
              ...(rival.canRequestAlliance ? ["allianceRequest"] : []),
              ...(rival.canSendQuickChat ? ["quick_chat"] : []),
              ...(rival.canSendEmoji ? ["emoji"] : []),
              ...(rival.canExtendAlliance ? ["allianceExtension"] : []),
              ...(rival.canDonateGold ? ["donate_gold"] : []),
              ...(rival.canDonateTroops ? ["donate_troops"] : []),
            ],
          })),
        }
      : {}),
    ...(include("map")
      ? {
          map: {
            ...map,
            ...(sections?.includes("map") ? { tradeTraffic } : {}),
            buildSites: buildSites.map(({ upgradeId, ...site }) =>
              upgradeId === false ? site : { ...site, upgradeId },
            ),
            ...(cells.length ? { region, cells } : {}),
          },
        }
      : {}),
    ...(include("costs") ? { buildCosts } : {}),
    ...(include("events") ? { events: observation.events } : {}),
    ...(sections?.includes("communication")
      ? { quickChatKeys, emojiChoices }
      : {}),
  };
}
