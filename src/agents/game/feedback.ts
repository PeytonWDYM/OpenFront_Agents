import {
  ATTACK_INDEX_CANCEL,
  ATTACK_INDEX_SENT,
  BOAT_INDEX_SENT,
} from "../../core/StatsSchemas";
import { Game, Player, Structures, Unit } from "../../core/game/Game";
import type { AgentAction, AgentEvent } from "./schemas";

const ACTION_LIMIT = 12;
const CHANGE_LIMIT = 12;

function structureState(unit: Unit) {
  return {
    unitId: unit.id(),
    type: unit.type(),
    tile: unit.tile(),
    level: unit.level(),
    underConstruction: unit.isUnderConstruction(),
  };
}
type StructureState = ReturnType<typeof structureState>;
type ActionSummary = {
  type: AgentAction["type"];
  tick: number;
  unitType?: string;
  tile?: number;
  unitId?: number;
  requestedAmount?: number;
  previousLevel?: number;
  targetId?: string | null;
  requestedTroops?: number | null;
};
type SubmittedAction = {
  summary: ActionSummary;
  existingUnitIds?: Set<number>;
};

/** Decision baselines are separate from inspector and tool observations. */
export class DecisionFeedback {
  private baselines = new Map<
    string,
    ReturnType<DecisionFeedback["snapshot"]>
  >();
  private submissions = new Map<string, SubmittedAction[]>();
  private submissionCounts = new Map<string, number>();
  private captureCounts = new Map<string, number>();

  constructor(private readonly game: Game) {}

  recordEvents(player: Player, events: AgentEvent[]): void {
    const count = events.filter(
      (event) => event.type === "trade_ship_captured",
    ).length;
    if (count)
      this.captureCounts.set(
        player.id(),
        (this.captureCounts.get(player.id()) ?? 0) + count,
      );
  }

  recordSubmitted(player: Player, action: AgentAction): void {
    const summary: ActionSummary = {
      type: action.type,
      tick: this.game.ticks(),
    };
    let existingUnitIds: Set<number> | undefined;
    if (action.type === "build_unit") {
      summary.unitType = action.unit;
      summary.tile = action.tile;
      summary.requestedAmount = action.amount ?? 1;
      if (Structures.has(action.unit)) {
        const site = player.canBuild(action.unit, action.tile);
        if (site !== false) summary.tile = site;
        existingUnitIds = new Set(player.units().map((unit) => unit.id()));
      }
    } else if (action.type === "upgrade_structure") {
      summary.unitId = action.unitId;
      summary.requestedAmount = action.amount ?? 1;
      const unit = player.units().find((unit) => unit.id() === action.unitId);
      if (unit) {
        summary.unitType = unit.type();
        summary.tile = unit.tile();
        summary.previousLevel = unit.level();
      }
    } else if (action.type === "attack") {
      summary.targetId = action.targetID;
      summary.requestedTroops = action.troops;
    } else if (action.type === "boat") {
      summary.tile = action.dst;
      summary.requestedTroops = action.troops;
    }
    const actions = this.submissions.get(player.id()) ?? [];
    actions.push({ summary, existingUnitIds });
    this.submissions.set(player.id(), actions.slice(-ACTION_LIMIT));
    this.submissionCounts.set(
      player.id(),
      (this.submissionCounts.get(player.id()) ?? 0) + 1,
    );
  }

  /** Read native changes once per decision. Action observations do not prove causality. */
  begin(player: Player) {
    const current = this.snapshot(player);
    const previous = this.baselines.get(player.id());
    const actions = (this.submissions.get(player.id()) ?? []).map((action) => {
      const { summary } = action;
      const unit =
        summary.unitId === undefined
          ? [...current.structures.values()].find(
              (unit) =>
                unit.type === summary.unitType &&
                unit.tile === summary.tile &&
                !action.existingUnitIds?.has(unit.unitId),
            )
          : current.structures.get(summary.unitId);
      // Matching state cannot prove which request caused a change. Concurrent
      // requests can target the same unit, so only the aggregate changes claim outcomes.
      return {
        ...summary,
        status: "submitted" as const,
        ...(summary.type === "upgrade_structure" ||
        (summary.type === "build_unit" && action.existingUnitIds)
          ? {
              observation: unit
                ? ("observed" as const)
                : ("not observed" as const),
            }
          : {}),
        ...(unit
          ? {
              observedUnitId: unit.unitId,
              observedLevel: unit.level,
              observedUnderConstruction: unit.underConstruction,
            }
          : {}),
      };
    });
    const actionsTotal = this.submissionCounts.get(player.id()) ?? 0;
    this.baselines.set(player.id(), current);
    this.submissions.delete(player.id());
    this.submissionCounts.delete(player.id());
    if (!previous) return undefined;

    const changes: (StructureState & {
      status: "new_owned" | "completed" | "upgraded" | "no_longer_owned";
      previousLevel?: number;
    })[] = [];
    for (const unit of current.structures.values()) {
      const before = previous.structures.get(unit.unitId);
      if (!before) changes.push({ ...unit, status: "new_owned" });
      else if (before.underConstruction && !unit.underConstruction)
        changes.push({ ...unit, status: "completed" });
      else if (unit.level > before.level)
        changes.push({
          ...unit,
          status: "upgraded",
          previousLevel: before.level,
        });
    }
    for (const unit of previous.structures.values())
      if (!current.structures.has(unit.unitId))
        changes.push({ ...unit, status: "no_longer_owned" });
    return {
      fromTick: previous.tick,
      toTick: current.tick,
      elapsedSeconds: (current.tick - previous.tick) / 10,
      goldDelta: current.gold - previous.gold,
      tilesDelta: current.tiles - previous.tiles,
      troopsDelta: current.troops - previous.troops,
      goldEarned: current.goldEarned - previous.goldEarned,
      shipTradeGoldEarned: current.tradeGold - previous.tradeGold,
      trainTradeGoldEarned: current.trainGold - previous.trainGold,
      piracyGoldEarned: current.piracyGold - previous.piracyGold,
      // Native attack counters include land attacks and naval landings. Adding
      // retreat totals restores launched commitments, not combat casualties.
      attackTroopsCommitted: current.attackCommitted - previous.attackCommitted,
      attackTroopsRetreated: current.attackRetreated - previous.attackRetreated,
      transportsLaunched:
        current.transportsLaunched - previous.transportsLaunched,
      tradeShipsCaptured: current.captures - previous.captures,
      actions,
      actionsTotal,
      actionsOmitted: actionsTotal - actions.length,
      construction: {
        changes: changes.slice(-CHANGE_LIMIT),
        total: changes.length,
        omitted: Math.max(0, changes.length - CHANGE_LIMIT),
      },
    };
  }

  private snapshot(player: Player) {
    const stats = this.game.stats().getPlayerStats(player);
    const attackRetreated = Number(stats?.attacks?.[ATTACK_INDEX_CANCEL] ?? 0n);
    return {
      tick: this.game.ticks(),
      gold: Number(player.gold()),
      tiles: player.numTilesOwned(),
      troops: Math.floor(player.troops()),
      goldEarned: Number(player.goldEarned()),
      tradeGold: Number(player.tradeGold()),
      trainGold: Number(player.trainGold()),
      piracyGold: Number(player.piracyGold()),
      attackCommitted:
        Number(stats?.attacks?.[ATTACK_INDEX_SENT] ?? 0n) + attackRetreated,
      attackRetreated,
      transportsLaunched: Number(stats?.boats?.trans?.[BOAT_INDEX_SENT] ?? 0n),
      captures: this.captureCounts.get(player.id()) ?? 0,
      structures: new Map(
        player
          .units(Structures.types)
          .map((unit) => [unit.id(), structureState(unit)]),
      ),
    };
  }
}

export type AgentDecisionFeedback = NonNullable<
  ReturnType<DecisionFeedback["begin"]>
>;
