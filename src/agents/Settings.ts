import { z } from "zod";
import { GameConfigSchema } from "../core/Schemas";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
} from "../core/game/Game";

// Use the native schemas so the arena accepts the same modifier bounds as solo play.
export const AgentGameSettingsSchema = GameConfigSchema.pick({
  gameMap: true,
  gameMapSize: true,
  difficulty: true,
  gameMode: true,
  playerTeams: true,
  infiniteGold: true,
  infiniteTroops: true,
  instantBuild: true,
  randomSpawn: true,
  disabledUnits: true,
  waterNukes: true,
  goldMultiplier: true,
  startingGold: true,
  customAllianceDuration: true,
  maxTimerValue: true,
  doomsdayClock: true,
  overtime: true,
}).extend({
  gameMap: GameConfigSchema.shape.gameMap.default(GameMapType.Europe),
  gameMapSize: GameConfigSchema.shape.gameMapSize.default(GameMapSize.Compact),
  useRandomMap: z.boolean().default(false),
  difficulty: GameConfigSchema.shape.difficulty.default(Difficulty.Easy),
  gameMode: GameConfigSchema.shape.gameMode.default(GameMode.FFA),
  playerTeams: GameConfigSchema.shape.playerTeams
    .refine(
      (count) => count === undefined || typeof count !== "number" || count >= 2,
      "At least two teams are required.",
    )
    .default(2),
  randomSpawn: z.boolean().default(false),
  infiniteGold: z.boolean().default(false),
  infiniteTroops: z.boolean().default(false),
  instantBuild: z.boolean().default(false),
  disabledUnits: GameConfigSchema.shape.disabledUnits.default([]),
  waterNukes: z.boolean().default(false),
});

export const ArenaSettingsSchema = AgentGameSettingsSchema.extend({
  agentCount: z.number().int().min(1).max(200).default(4),
  mediumAgentCount: z.number().int().min(0).max(200).default(0),
  tribeCount: z.number().int().min(0).max(400).default(100),
  nationCount: z.number().int().min(0).max(400).default(52),
  mode: z.enum(["codex", "scripted"]).default("codex"),
})
  .strict()
  .refine((settings) => settings.mediumAgentCount <= settings.agentCount, {
    message: "Medium reasoning agents cannot exceed the agent count.",
    path: ["mediumAgentCount"],
  });

export const defaultSettings = ArenaSettingsSchema.parse({});
