import { z } from "zod";

export const ArenaSettingsSchema = z
  .object({
    agentCount: z.number().int().min(1).max(200).default(4),
    tribeCount: z.number().int().min(0).max(400).default(100),
    nationCount: z.number().int().min(0).max(400).default(52),
    mode: z.enum(["codex", "scripted"]).default("codex"),
  })
  .strict();

export const defaultSettings = ArenaSettingsSchema.parse({});
