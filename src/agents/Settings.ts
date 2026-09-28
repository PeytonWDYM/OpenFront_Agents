import { z } from "zod";

export const ArenaSettingsSchema = z
  .object({
    agentCount: z.number().int().min(1).max(200).default(4),
    mode: z.enum(["codex", "scripted"]).default("codex"),
    decisionIntervalMs: z.number().int().min(500).max(300_000).default(15_000),
    concurrency: z.number().int().min(1).max(16).default(2),
    maxTokens: z.number().int().min(4_096).max(10_000_000).default(100_000),
    maxDecisionsPerPlayer: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export const defaultSettings = ArenaSettingsSchema.parse({});
