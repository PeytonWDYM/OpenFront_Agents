import { html } from "lit";
import { translateText } from "../Utils";
import { AgentSettings } from "./AgentApi";

export const defaultAgentSettings: AgentSettings = {
  agentCount: 4,
  mode: "codex",
  decisionIntervalMs: 15_000,
  concurrency: 2,
  maxTokens: 100_000,
};

export function agentLobbyForm(
  settings: AgentSettings,
  busy: boolean,
  create: (settings: AgentSettings) => void,
) {
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    create({
      agentCount: Number(values.get("agentCount")),
      mode: values.get("mode") === "scripted" ? "scripted" : "codex",
      decisionIntervalMs: Number(values.get("interval")) * 1000,
      concurrency: Number(values.get("concurrency")),
      maxTokens: Number(values.get("maxTokens")),
    });
  };

  return html`
    <form @submit=${submit}>
      <p class="muted">${translateText("agents.description")}</p>
      <fieldset ?disabled=${busy}>
        <label>
          ${translateText("agents.count")}
          <input
            name="agentCount"
            type="number"
            min="1"
            max="200"
            step="1"
            required
            .value=${String(settings.agentCount)}
          />
        </label>
        <label>
          ${translateText("agents.mode")}
          <select name="mode" .value=${settings.mode}>
            <option value="codex">${translateText("agents.codex_mode")}</option>
            <option value="scripted">
              ${translateText("agents.scripted_mode")}
            </option>
          </select>
        </label>
        <details>
          <summary>${translateText("agents.settings")}</summary>
          <p class="muted">${translateText("agents.model")}</p>
          <label>
            ${translateText("agents.interval")}
            <input
              name="interval"
              type="number"
              min="1"
              max="3600"
              step="1"
              required
              .value=${String(settings.decisionIntervalMs / 1000)}
            />
          </label>
          <label>
            ${translateText("agents.concurrency")}
            <input
              name="concurrency"
              type="number"
              min="1"
              max="200"
              step="1"
              required
              .value=${String(settings.concurrency)}
            />
          </label>
          <label>
            ${translateText("agents.token_limit")}
            <input
              name="maxTokens"
              type="number"
              min="1"
              step="1"
              required
              .value=${String(settings.maxTokens)}
            />
          </label>
        </details>
        <button class="primary" type="submit">
          ${translateText(busy ? "agents.working" : "agents.create")}
        </button>
      </fieldset>
    </form>
  `;
}
