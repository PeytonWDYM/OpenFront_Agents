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

/** Best-effort session and text recovery from `opencode run --format json`. */
export function parseRunEvents(stdout: string): {
  text: string;
  sessionId?: string;
} {
  const chunks: string[] = [];
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      const part = (event.part ?? event.data ?? event) as Record<
        string,
        unknown
      >;
      if (typeof event.sessionID === "string") sessionId = event.sessionID;
      if (typeof event.sessionId === "string") sessionId = event.sessionId;
      if (
        (type.includes("session") || type.includes("created")) &&
        typeof part.id === "string" &&
        part.id.length >= 8
      ) {
        sessionId ??= part.id;
      }
      const text =
        typeof part.text === "string"
          ? part.text
          : typeof event.text === "string"
            ? event.text
            : typeof part.content === "string"
              ? part.content
              : undefined;
      if (
        text &&
        (type.includes("message") ||
          type.includes("text") ||
          type.includes("part") ||
          type.includes("assistant") ||
          type === "event")
      ) {
        chunks.push(text);
      }
    } catch {
      chunks.push(line);
    }
  }
  const text = chunks.length > 0 ? chunks.join("\n") : stdout.trim();
  return sessionId ? { text, sessionId } : { text };
}
