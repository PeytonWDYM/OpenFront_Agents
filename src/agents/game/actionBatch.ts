import type { AgentGame } from "./AgentGame";
import { type AgentAction, AgentToolInputSchema } from "./schemas";

type ActionResult = Awaited<ReturnType<AgentGame["act"]>>;
type SubmitAction = (
  intent: AgentAction,
  attackRatio?: number,
) => Promise<ActionResult>;

/** Validate and submit native actions in order, with no harness action limit. */
export async function submitActions(
  input: unknown,
  submit: SubmitAction,
  schedule: (seconds: number) => void,
) {
  // Validate every intent before scheduling or submitting any native action.
  const request = AgentToolInputSchema.parse(input);
  if (request.nextDecisionSeconds !== undefined)
    schedule(request.nextDecisionSeconds);
  if (request.intent) return submit(request.intent, request.attackRatio);
  if (!request.intents)
    return {
      accepted: true as const,
      nextDecisionSeconds: request.nextDecisionSeconds,
    };

  // Native submissions are sequential, not atomic. Report each failure separately.
  const results: (
    | ActionResult
    | { accepted: false; intent: AgentAction; error: string }
  )[] = [];
  for (const intent of request.intents) {
    try {
      results.push(await submit(intent, request.attackRatio));
    } catch (error) {
      results.push({
        accepted: false,
        intent,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { accepted: results.every((result) => result.accepted), results };
}
