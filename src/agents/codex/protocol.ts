import { z } from "zod";

export const record = z.record(z.string(), z.unknown());
export const message = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: record.optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export const thread = z.object({ id: z.string() }).passthrough();
export const threadStart = z.object({
  thread,
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  instructionSources: z.array(z.string()),
  approvalPolicy: z.string(),
  sandbox: z.object({ type: z.string() }).passthrough(),
});
export const turnState = z
  .object({
    id: z.string(),
    status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
    error: z.object({ message: z.string() }).passthrough().nullable(),
  })
  .passthrough();
export const toolCall = z.object({
  threadId: z.string(),
  turnId: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});
export const tokenUsage = z.object({
  threadId: z.string(),
  tokenUsage: z.object({
    total: z.object({
      totalTokens: z.number(),
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      cacheWriteInputTokens: z.number(),
      outputTokens: z.number(),
      reasoningOutputTokens: z.number(),
    }),
    modelContextWindow: z.number().nullable(),
  }),
});
