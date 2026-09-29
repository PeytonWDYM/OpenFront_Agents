import { z } from "zod";
import { AgentToolInputSchema } from "../game/schemas";

const noteSchema = z.object({
  note: z.string().trim().min(1).max(600).optional(),
  intent: z.unknown().optional(),
  intents: z.unknown().optional(),
  attackRatio: z.number().min(0).max(1).optional(),
  nextDecisionSeconds: z.number().int().min(1).max(10).optional(),
});

/** Extract the last JSON object from model prose (code fences included). */
export function extractActionJson(text: string): unknown | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1],
  );
  const candidates = fenced.length > 0 ? fenced : [text];
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index].trim();
    // Try the whole block first, then each brace-balanced suffix.
    const attempts = [candidate];
    let depth = 0;
    let start = -1;
    for (let cursor = 0; cursor < candidate.length; cursor++) {
      if (candidate[cursor] === "{") {
        if (depth === 0) start = cursor;
        depth++;
      } else if (candidate[cursor] === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          attempts.push(candidate.slice(start, cursor + 1));
          start = -1;
        }
      }
    }
    for (let attempt = attempts.length - 1; attempt >= 0; attempt--) {
      try {
        return JSON.parse(attempts[attempt]);
      } catch {
        // Try the next smaller JSON candidate.
      }
    }
  }
  return undefined;
}

/** Validate the extracted JSON against the native action contract. */
export function parseActionOutput(
  text: string,
):
  | { note?: string; action?: z.infer<typeof AgentToolInputSchema> }
  | { error: string } {
  const extracted = extractActionJson(text);
  if (extracted === undefined) {
    return { error: "The model reply contained no JSON action object." };
  }
  const noted = noteSchema.safeParse(extracted);
  if (!noted.success) {
    return { error: "The model JSON did not match the action contract." };
  }
  const { note, ...rest } = noted.data;
  if (
    rest.intent === undefined &&
    rest.intents === undefined &&
    rest.nextDecisionSeconds === undefined
  ) {
    return note ? { note } : {};
  }
  const action = AgentToolInputSchema.safeParse(rest);
  if (!action.success) {
    return { error: "The model JSON did not match the action contract." };
  }
  return note ? { note, action: action.data } : { action: action.data };
}

/** The free pool throttles instead of failing: retry these, fail on the rest. */
export function isTransientRunError(message: string): boolean {
  return /rate|limit|429|overloaded|temporar|busy|try again/i.test(message);
}

/** Join assistant text parts from a serve message response. */
export function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      chunks.push((part as { text: string }).text);
    }
  }
  return chunks.join("\n");
}
