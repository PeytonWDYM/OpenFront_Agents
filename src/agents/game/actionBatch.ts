import { Structures } from "../../core/game/Game";
import type { AgentGame } from "./AgentGame";
import { type AgentAction, AgentToolInputSchema } from "./schemas";

type ActionResult = Awaited<ReturnType<AgentGame["act"]>>;
type SubmitAction = (
  intent: AgentAction,
  attackRatio?: number,
) => Promise<ActionResult>;

function batchWarnings(intents: AgentAction[]) {
  const warnings: string[] = [];
  const builds = intents.filter((intent) => intent.type === "build_unit");
  if (
    builds.length &&
    intents.some((intent) => intent.type === "upgrade_structure")
  )
    warnings.push(
      "Native upgrades spend gold during initialization before missile launches and new construction ticks, regardless of array order. Shared upgrade, missile launch, and other build costs can leave later work unaffordable.",
    );
  const structures = builds.filter((intent) => Structures.has(intent.unit));
  const tiles = new Set<number>();
  if (
    structures.some((intent) => {
      const duplicate = tiles.has(intent.tile);
      tiles.add(intent.tile);
      return duplicate;
    })
  )
    warnings.push(
      "New structures on the same tile compete for placement. Submission does not reserve the site or budget.",
    );
  if (
    intents.filter(
      (intent) => intent.type === "attack" || intent.type === "boat",
    ).length > 1
  )
    warnings.push(
      "The persistent attackRatio applies to each army action that uses it. Combined troop requests can exceed available troops and native execution can reduce later commitments.",
    );
  return warnings;
}

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
    | {
        accepted: false;
        status: "rejected";
        execution: "not submitted";
        intent: AgentAction;
        error: string;
      }
  )[] = [];
  for (const intent of request.intents) {
    try {
      results.push(await submit(intent, request.attackRatio));
    } catch (error) {
      results.push({
        accepted: false,
        status: "rejected",
        execution: "not submitted",
        intent,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const warnings = batchWarnings(request.intents);
  const submitted = results.some((result) => result.accepted);
  return {
    accepted: results.every((result) => result.accepted),
    status: submitted ? ("submitted" as const) : ("rejected" as const),
    execution: submitted
      ? ("pending execution" as const)
      : ("not submitted" as const),
    results,
    ...(warnings.length ? { warnings } : {}),
  };
}
