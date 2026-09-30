import { LitElement, PropertyValues, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ArenaSettingsSchema, defaultSettings } from "../../agents/Settings";
import { DoomsdayClockSpeed } from "../../core/game/DoomsdayClock";
import {
  Difficulty,
  GameMapType,
  GameMode,
  UnitType,
} from "../../core/game/Game";
import { TeamCountConfig } from "../../core/Schemas";
import { documentStylesSheet } from "../components/baseComponents/SharedStyles";
import "../components/GameConfigSettings";
import { getUpdatedDisabledUnits } from "../utilities/GameConfigHelpers";
import { translateText } from "../Utils";
import { AgentSettings } from "./AgentApi";
import { agentLobbyFormStyles } from "./AgentLobbyFormStyles";
import { agentLobbySettings, agentOptionChange } from "./AgentLobbySettings";

export type AgentRole = "play" | "spectate";
export const defaultAgentSettings = defaultSettings;

@customElement("agent-lobby-form")
export class AgentLobbyForm extends LitElement {
  static styles = [documentStylesSheet(), agentLobbyFormStyles];
  @property({ attribute: false }) settings: AgentSettings =
    defaultAgentSettings;
  @property({ type: Boolean }) busy = false;
  @property({ attribute: false }) onCreate!: (
    settings: AgentSettings,
    role: AgentRole,
  ) => void;
  @state() private draft: AgentSettings = defaultAgentSettings;
  @state() private error = "";
  private initialized = false;

  protected willUpdate(changed: PropertyValues): void {
    if (!this.initialized && changed.has("settings")) {
      this.draft = { ...this.settings };
      this.initialized = true;
    }
  }

  private updateSettings = (change: Partial<AgentSettings>) => {
    if (!this.busy) this.draft = { ...this.draft, ...change };
  };

  private submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (this.busy) return;
    for (const input of this.renderRoot.querySelectorAll<HTMLInputElement>(
      "input",
    )) {
      if (!input.reportValidity()) return;
    }
    const parsed = ArenaSettingsSchema.safeParse(this.draft);
    if (!parsed.success) {
      this.error = translateText("agents.invalid_settings");
      return;
    }
    this.error = "";
    const role =
      (event.submitter as HTMLButtonElement).value === "spectate"
        ? "spectate"
        : "play";
    this.onCreate(parsed.data, role);
  };

  protected render() {
    const settings = this.draft;
    return html`
      <p class="intro">${translateText("agents.setup_description")}</p>
      <fieldset ?disabled=${this.busy} ?inert=${this.busy}>
        <form id="agent-lobby-create" @submit=${this.submit}>
          <section class="agent-seats">
            <h3>${translateText("agents.roster")}</h3>
            <div class="seat-inputs">
              <label
                >${translateText("agents.count")}
                <input
                  name="agentCount"
                  type="number"
                  min="1"
                  max="200"
                  step="1"
                  required
                  .value=${String(settings.agentCount)}
                  @input=${(event: Event) => {
                    const agentCount = (event.target as HTMLInputElement)
                      .valueAsNumber;
                    this.updateSettings({
                      agentCount,
                      mediumAgentCount: Math.min(
                        settings.mediumAgentCount,
                        agentCount,
                      ),
                    });
                  }}
                />
              </label>
              <label
                >${translateText("agents.medium_count")}
                <input
                  name="mediumAgentCount"
                  type="number"
                  min="0"
                  max=${settings.agentCount}
                  step="1"
                  required
                  .value=${String(settings.mediumAgentCount)}
                  @input=${(event: Event) =>
                    this.updateSettings({
                      mediumAgentCount: (event.target as HTMLInputElement)
                        .valueAsNumber,
                    })}
                />
              </label>
            </div>
            <p>${translateText("agents.medium_count_help")}</p>
            ${!settings.randomSpawn
              ? html`<p>${translateText("agents.spawn_setup_help")}</p>`
              : nothing}
          </section>
        </form>
        <game-config-settings
          .settings=${agentLobbySettings(settings, this.updateSettings)}
          @map-selected=${(event: CustomEvent<{ map: GameMapType }>) =>
            this.updateSettings({
              gameMap: event.detail.map,
              useRandomMap: false,
            })}
          @random-map-selected=${() =>
            this.updateSettings({ useRandomMap: true })}
          @difficulty-selected=${(
            event: CustomEvent<{ difficulty: Difficulty }>,
          ) => this.updateSettings({ difficulty: event.detail.difficulty })}
          @game-mode-selected=${(event: CustomEvent<{ mode: GameMode }>) =>
            this.updateSettings({ gameMode: event.detail.mode })}
          @team-count-selected=${(
            event: CustomEvent<{ count: TeamCountConfig }>,
          ) => this.updateSettings({ playerTeams: event.detail.count })}
          @bots-changed=${(event: CustomEvent<{ value: number }>) =>
            this.updateSettings({ tribeCount: event.detail.value })}
          @nations-changed=${(event: CustomEvent<{ value: number }>) =>
            this.updateSettings({ nationCount: event.detail.value })}
          @option-toggle-changed=${(
            event: CustomEvent<{ labelKey: string; checked: boolean }>,
          ) =>
            this.updateSettings(
              agentOptionChange(
                settings,
                event.detail.labelKey,
                event.detail.checked,
              ),
            )}
          @doomsday-clock-speed-selected=${(
            event: CustomEvent<{ speed: DoomsdayClockSpeed }>,
          ) =>
            this.updateSettings({
              doomsdayClock: { enabled: true, speed: event.detail.speed },
            })}
          @unit-toggle-changed=${(
            event: CustomEvent<{ unit: UnitType; checked: boolean }>,
          ) =>
            this.updateSettings({
              disabledUnits: getUpdatedDisabledUnits(
                settings.disabledUnits,
                event.detail.unit,
                event.detail.checked,
              ),
            })}
        ></game-config-settings>
        <footer>
          <p role=${this.error ? "alert" : "status"}>
            ${this.error || translateText("agents.model_choice")}
          </p>
          <div class="role-buttons">
            <button
              class="primary"
              type="submit"
              form="agent-lobby-create"
              value="play"
            >
              ${translateText("agents.play")}
            </button>
            <button
              class="secondary"
              type="submit"
              form="agent-lobby-create"
              value="spectate"
            >
              ${translateText("agents.spectate")}
            </button>
          </div>
        </footer>
      </fieldset>
    `;
  }
}
