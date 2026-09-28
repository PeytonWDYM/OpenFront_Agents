import { z } from "zod";
import {
  AllianceExtensionIntentSchema,
  AllianceRejectIntentSchema,
  AllianceRequestIntentSchema,
  AttackIntentSchema,
  BoatAttackIntentSchema,
  BreakAllianceIntentSchema,
  BuildUnitIntentSchema,
  CancelAttackIntentSchema,
  CancelBoatIntentSchema,
  DeleteUnitIntentSchema,
  DonateGoldIntentSchema,
  DonateTroopIntentSchema,
  EmbargoAllIntentSchema,
  EmbargoIntentSchema,
  EmojiIntentSchema,
  MoveWarshipIntentSchema,
  QuickChatIntentSchema,
  QuickChatKeySchema,
  SpawnIntentSchema,
  TargetPlayerIntentSchema,
  UpgradeStructureIntentSchema,
} from "../../core/Schemas";

// Native player intents only. Strict objects reject forged sender fields.
export const AgentActionSchema = z.discriminatedUnion("type", [
  AttackIntentSchema.strict(),
  CancelAttackIntentSchema.strict(),
  SpawnIntentSchema.strict(),
  BoatAttackIntentSchema.strict(),
  CancelBoatIntentSchema.strict(),
  AllianceRequestIntentSchema.strict(),
  AllianceRejectIntentSchema.strict(),
  BreakAllianceIntentSchema.strict(),
  TargetPlayerIntentSchema.strict(),
  EmojiIntentSchema.strict(),
  DonateGoldIntentSchema.strict(),
  DonateTroopIntentSchema.strict(),
  BuildUnitIntentSchema.strict(),
  UpgradeStructureIntentSchema.strict(),
  EmbargoIntentSchema.strict(),
  EmbargoAllIntentSchema.strict(),
  MoveWarshipIntentSchema.strict(),
  QuickChatIntentSchema.strict(),
  AllianceExtensionIntentSchema.strict(),
  DeleteUnitIntentSchema.strict(),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;
const actionToolInputSchema = z
  .object({
    intent: z.discriminatedUnion("type", [
      AgentActionSchema.options[0],
      ...AgentActionSchema.options.slice(1).map((option) =>
        option.shape.type.value === "quick_chat"
          ? option.extend({
              quickChatKey: z
                .string()
                .describe(
                  "Use a quickChatKeys value from observe_world({quickChatKeys:true})",
                ),
            })
          : option,
      ),
    ]),
  })
  .strict();

// The Codex tool parser limits schemas to 5,000 bytes. Native validation retains
// these constraints and the full Quick Chat enum when an intent is submitted.
export const agentActionToolSchema = z.toJSONSchema(actionToolInputSchema);
function removeToolMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeToolMetadata);
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of [
      "$schema",
      "pattern",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ])
      delete object[key];
    Object.values(object).forEach(removeToolMetadata);
  }
}
removeToolMetadata(agentActionToolSchema);
export const quickChatKeys = QuickChatKeySchema.options;

export const ObserveQuerySchema = z
  .object({
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    width: z.number().int().min(1).max(32768).optional(),
    height: z.number().int().min(1).max(32768).optional(),
  })
  .strict();
export type ObserveQuery = z.infer<typeof ObserveQuerySchema>;

export interface AgentEvent {
  type: string;
  tick: number;
  at: number;
  data: Record<string, unknown>;
}
export interface AgentGameEvent extends AgentEvent {
  agentId?: string;
}
export interface AgentPlayer {
  id: string;
  name: string;
  playerId?: string;
  alive: boolean;
}
export interface AgentObservation {
  gameId: string;
  tick: number;
  spawnPhase: boolean;
  self: {
    id: string;
    playerId: string;
    alive: boolean;
    spawned: boolean;
    troops: number;
    gold: number;
    maxTroops: number;
    tiles: number;
    canSendEmojiAllPlayers: boolean;
    canEmbargoAll: boolean;
    allies: string[];
    incomingAllianceRequests: string[];
    outgoingAttacks: { id: string; targetId: string | null; troops: number }[];
    incomingAttacks: { id: string; attackerId: string }[];
    units: {
      id: number;
      type: string;
      tile: number;
      level: number;
      canUpgrade: boolean;
      underConstruction: boolean;
    }[];
  };
  rivals: {
    playerId: string;
    name: string;
    alive: boolean;
    tiles: number;
    allied: boolean;
    sharesBorder: boolean;
    canAttack: boolean;
    canRequestAlliance: boolean;
    canSendQuickChat: boolean;
    canSendEmoji: boolean;
    embargoed: boolean;
    allianceExpiresAt?: number;
    canExtendAlliance: boolean;
    canDonateGold: boolean;
    canDonateTroops: boolean;
  }[];
  map: {
    width: number;
    height: number;
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
      stride: number;
    };
    cells: {
      tile: number;
      x: number;
      y: number;
      terrain: string;
      ownerId: string | null;
    }[];
    spawnCandidates: { tile: number; x: number; y: number }[];
    borders: {
      tile: number;
      x: number;
      y: number;
      ownerId: string | null;
      canAttack: boolean;
    }[];
    boatTargets: {
      tile: number;
      x: number;
      y: number;
      ownerId: string | null;
      launchTile: number;
    }[];
    buildSites: {
      type: string;
      tile: number;
      cost: number;
      upgradeId: number | false;
    }[];
    buildCosts: { type: string; cost: number }[];
  };
  events: AgentEvent[];
}
