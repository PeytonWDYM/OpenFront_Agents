import { translateText } from "../Utils";
import { AgentSettings } from "./AgentApi";

export function agentTokenUsage(
  mode: AgentSettings["mode"],
  tokens: number,
  thinking: boolean,
): string {
  if (mode === "scripted") return translateText("agents.scripted_tokens");
  if (tokens === 0 && thinking) return translateText("agents.usage_pending");
  return translateText("agents.tokens", { count: tokens.toLocaleString() });
}
