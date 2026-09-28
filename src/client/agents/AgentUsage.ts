import { html, nothing } from "lit";
import type { AgentTokenUsage } from "../../agents/types";
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

export function agentUsageBreakdown(
  mode: AgentSettings["mode"],
  usage: AgentTokenUsage | undefined,
) {
  if (mode === "scripted")
    return html`<p class="muted">
      ${translateText("agents.scripted_tokens")}
    </p>`;
  if (usage === undefined)
    return html`<p class="muted">
      ${translateText("agents.usage_details_unavailable")}
    </p>`;
  return html`
    <dl class="usage-grid">
      <dt>${translateText("agents.usage_input")}</dt>
      <dd>${usage.inputTokens.toLocaleString()}</dd>
      <dt class="usage-subset">
        ${translateText("agents.usage_cached_input")}
      </dt>
      <dd>${usage.cachedInputTokens.toLocaleString()}</dd>
      <dt class="usage-subset">
        ${translateText("agents.usage_uncached_input")}
      </dt>
      <dd>${(usage.inputTokens - usage.cachedInputTokens).toLocaleString()}</dd>
      ${usage.cacheWriteInputTokens > 0
        ? html`<dt class="usage-subset">
              ${translateText("agents.usage_cache_write")}
            </dt>
            <dd>${usage.cacheWriteInputTokens.toLocaleString()}</dd>`
        : nothing}
      <dt>${translateText("agents.usage_output")}</dt>
      <dd>${usage.outputTokens.toLocaleString()}</dd>
      <dt class="usage-subset">${translateText("agents.usage_reasoning")}</dt>
      <dd>${usage.reasoningOutputTokens.toLocaleString()}</dd>
    </dl>
    <p class="usage-note">${translateText("agents.usage_included_help")}</p>
  `;
}
