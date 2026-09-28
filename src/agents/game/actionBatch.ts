import type { AgentGame } from "./AgentGame";
import { type AgentAction, AgentToolInputSchema } from "./schemas";

type ActionResult = Awaited<ReturnType<AgentGame["act"]>>;
type SubmitAction = (
  intent: AgentAction,
  attackRatio?: number,
) => Promise<ActionResult>;

export class ActionLimitError extends Error {
  constructor() {
    super("The two-action limit ended this decision.");
  }
}

/** Share one native-action budget across single and batch calls in a decision. */
export class ActionDecision {
  private actions = 0;

  async submit(
    input: unknown,
    submit: SubmitAction,
    schedule: (seconds: number) => void,
  ) {
    // Validate every intent before scheduling or submitting any native action.
    const request = AgentToolInputSchema.parse(input);
    const intents = request.intents ?? (request.intent ? [request.intent] : []);
    if (this.actions + intents.length > 2) throw new ActionLimitError();
    this.actions += intents.length;
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
    for (const intent of intents) {
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
}
