import { z } from "zod";
import { PlayerType } from "../../core/game/Game";
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
import { flattenedEmojiTable } from "../../core/Util";
import type { AgentMatchStats } from "./matchStats";
import type { NavalAffiliation } from "./naval";

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
export const AttackRatioSchema = z.number().min(0).max(1);
export const NextDecisionSecondsSchema = z.number().int().min(1).max(10);
export const AgentToolInputSchema = z
  .object({
    intent: AgentActionSchema.optional(),
    intents: z.array(AgentActionSchema).min(1).max(2).optional(),
    attackRatio: AttackRatioSchema.optional().describe(
      "Fraction 0..1 of current troops for each intent. Persists. Overrides attack/boat troops.",
    ),
    nextDecisionSeconds: NextDecisionSecondsSchema.optional().describe(
      "Next decision delay 1..10s. This turn only.",
    ),
  })
  .strict()
  .refine(
    (input) =>
      input.intent !== undefined ||
      input.intents !== undefined ||
      input.nextDecisionSeconds !== undefined,
    "Supply intent, intents, or nextDecisionSeconds",
  )
  .refine(
    (input) => input.intent === undefined || input.intents === undefined,
    "Choose intent or intents, not both",
  )
  .refine(
    (input) =>
      input.attackRatio === undefined ||
      input.intent !== undefined ||
      input.intents !== undefined,
    "attackRatio requires intent or intents",
  );
const toolActionSchema = z.discriminatedUnion("type", [
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
]);
// The Codex tool parser limits schemas to 5,000 bytes. Native validation retains
// these constraints and the full Quick Chat enum when an intent is submitted.
export const agentActionToolSchema = {
  type: "object",
  properties: {
    intent: { $ref: "#/$defs/action" },
    intents: {
      type: "array",
      items: { $ref: "#/$defs/action" },
      minItems: 1,
      maxItems: 2,
      description:
        "Choose intent or intents. Submit actions in order, not atomically.",
    },
    attackRatio: {
      type: "number",
      description:
        "Fraction 0..1 of current troops for each intent. Persists. Overrides attack/boat troops.",
    },
    nextDecisionSeconds: {
      type: "integer",
      description: "Next decision delay 1..10s. This turn only.",
    },
  },
  additionalProperties: false,
  $defs: { action: z.toJSONSchema(toolActionSchema) },
};
function removeToolMetadata(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeToolMetadata);
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    // A const already fixes its type. Omit the redundant type to save schema bytes.
    if ("const" in object) delete object.type;
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
export const emojiChoices = flattenedEmojiTable.map((message, emoji) => ({
  emoji,
  message,
}));

export const observationSections = [
  "self",
  "rivals",
  "map",
  "events",
  "units",
  "costs",
  "communication",
  "leaderboard",
] as const;

export const ObserveQuerySchema = z
  .object({
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    width: z.number().int().min(1).max(32768).optional(),
    height: z.number().int().min(1).max(32768).optional(),
    sections: z.array(z.enum(observationSections)).optional(),
  })
  .strict();
export type ObserveQuery = z.infer<typeof ObserveQuerySchema>;

export interface AgentEvent {
  type:
    | "chat"
    | "game"
    | "alliance_request"
    | "alliance_reply"
    | "alliance_broken"
    | "alliance_expired"
    | "alliance_extended"
    | "alliance_extension_request"
    | "unit_incoming"
    | "nuke_incoming"
    | "nuke_impact"
    | "eliminated"
    | "incoming_attack"
    | "attack_request"
    | "emoji"
    | "donation"
    | "conquest"
    | "spawn_end"
    | "win";
  tick: number;
  at: number;
  data: Record<string, unknown>;
}
export interface AgentGameEvent extends Omit<AgentEvent, "type"> {
  type: AgentEvent["type"] | "lobby_created" | "game_started" | "error";
  agentId?: string;
}
export interface AgentPlayer {
  id: string;
  clientId: string;
  name: string;
  playerId?: string;
  alive: boolean;
}
export interface AgentObservation extends AgentMatchStats {
  gameId: string;
  tick: number;
  spawnPhase: boolean;
  offense: {
    attackableBorders: number;
    rivalBorders: number;
    readySilos: number;
    affordableMissiles: string[];
    structureCounts: Record<string, number>;
    buildStreak: number;
  };
  self: {
    id: string;
    playerId: string;
    playerType: PlayerType;
    smallId: number;
    position?: { tile: number; x: number; y: number };
    alive: boolean;
    spawned: boolean;
    troops: number;
    attackRatio: number;
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
    playerType: PlayerType;
    smallId: number;
    position?: { tile: number; x: number; y: number };
    name: string;
    alive: boolean;
    tiles: number;
    allied: boolean;
    sharesBorder: boolean;
    canAttack: boolean;
    canRequestAlliance: boolean;
    canSendQuickChat: boolean;
    canSendEmoji: boolean;
    communication: {
      quickChatResponse: boolean;
      emojiResponse: boolean;
      allianceResponse: "player" | "automatic" | "conditional";
    };
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
    tradeTraffic: {
      id: number;
      type: string;
      tile: number;
      x: number;
      y: number;
      ownerId: string;
      ownerSmallId: number;
      affiliation: NavalAffiliation;
      destination?: {
        id: number;
        tile: number;
        x: number;
        y: number;
        ownerId: string;
        ownerSmallId: number;
        affiliation: NavalAffiliation;
      };
    }[];
    buildSites: {
      type: string;
      tile: number;
      cost: number;
      upgradeId: number | false;
    }[];
    buildCosts: { type: string; cost: number }[];
    publicStructures?: {
      id: number;
      type: string;
      tile: number;
      level: number;
      ownerId: string;
    }[];
  };
  events: AgentEvent[];
}
