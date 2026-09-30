import type { AgentReasoningEffort } from "./types";

/** Use the same assignment for the game name and the native Codex thread. */
export function getAgentReasoningEffort(
  index: number,
  mediumAgentCount: number,
): AgentReasoningEffort {
  return index < mediumAgentCount ? "medium" : "low";
}
