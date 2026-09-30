import { html } from "lit";
import { translateText } from "../Utils";
import { AgentSettings } from "./AgentApi";

export type AgentRole = "play" | "spectate";

export const defaultAgentSettings: AgentSettings = {
  agentCount: 4,
  mediumAgentCount: 0,
  tribeCount: 100,
  nationCount: 52,
  mode: "codex",
};

export function agentLobbyForm(
  settings: AgentSettings,
  busy: boolean,
  create: (settings: AgentSettings, role: AgentRole) => void,
) {
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const role =
      (event.submitter as HTMLButtonElement).value === "spectate"
        ? "spectate"
        : "play";
    create(
      {
        agentCount: Number(values.get("agentCount")),
        mediumAgentCount: Number(values.get("mediumAgentCount")),
        tribeCount: Number(values.get("tribeCount")),
        nationCount: Number(values.get("nationCount")),
        mode: "codex",
      },
      role,
    );
  };

  const updateCount = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    input.form!.querySelector<HTMLOutputElement>(
      `output[for="${input.id}"]`,
    )!.value = input.value;
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
            @input=${(event: Event) => {
              const input = event.currentTarget as HTMLInputElement;
              input.form!.querySelector<HTMLInputElement>(
                'input[name="mediumAgentCount"]',
              )!.max = input.value;
            }}
          />
        </label>
        <label>
          ${translateText("agents.medium_count")}
          <input
            name="mediumAgentCount"
            type="number"
            min="0"
            max=${settings.agentCount}
            step="1"
            required
            .value=${String(settings.mediumAgentCount)}
          />
        </label>
        <p class="muted">${translateText("agents.medium_count_help")}</p>
        <label for="agent-tribes">
          ${translateText("agents.tribes")}
          <output
            for="agent-tribes"
            .value=${String(settings.tribeCount)}
          ></output>
        </label>
        <input
          id="agent-tribes"
          name="tribeCount"
          type="range"
          min="0"
          max="400"
          step="1"
          .value=${String(settings.tribeCount)}
          @input=${updateCount}
        />
        <p class="muted">${translateText("agents.tribes_help")}</p>
        <label for="agent-nations">
          ${translateText("agents.nations")}
          <output
            for="agent-nations"
            .value=${String(settings.nationCount)}
          ></output>
        </label>
        <input
          id="agent-nations"
          name="nationCount"
          type="range"
          min="0"
          max="400"
          step="1"
          .value=${String(settings.nationCount)}
          @input=${updateCount}
        />
        <p class="muted">${translateText("agents.model_choice")}</p>
        <div class="role-buttons">
          <button class="primary" type="submit" value="play">
            ${translateText("agents.play")}
          </button>
          <button class="primary" type="submit" value="spectate">
            ${translateText("agents.spectate")}
          </button>
        </div>
      </fieldset>
    </form>
  `;
}
