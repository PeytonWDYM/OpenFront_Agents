import { html, TemplateResult } from "lit";
import { GameMapSize } from "../../core/game/Game";
import { GameConfigSettingsData } from "../components/GameConfigSettings";
import "../components/ToggleInputCard";
import { toOptionalNumber } from "../utilities/GameConfigHelpers";
import { translateText } from "../Utils";
import { AgentSettings } from "./AgentApi";

const toggles = [
  { key: "instantBuild", labelKey: "game_settings.instant_build" },
  { key: "randomSpawn", labelKey: "game_settings.random_spawn" },
  { key: "infiniteGold", labelKey: "game_settings.infinite_gold" },
  { key: "infiniteTroops", labelKey: "game_settings.infinite_troops" },
  { key: "waterNukes", labelKey: "game_settings.water_nukes" },
] as const;

type UpdateSettings = (change: Partial<AgentSettings>) => void;

function numberCard(
  labelKey: string,
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
  step: number | "any",
  update: (value: number | undefined) => void,
): TemplateResult {
  return html`<toggle-input-card
    .labelKey=${labelKey}
    .checked=${value !== undefined}
    .inputValue=${value}
    .inputMin=${min}
    .inputMax=${max}
    .inputStep=${step}
    .inputAriaLabel=${translateText(labelKey)}
    .defaultInputValue=${defaultValue}
    .minValidOnEnable=${min}
    .onToggle=${(checked: boolean, next: number | string | undefined) =>
      update(checked ? toOptionalNumber(next) : undefined)}
    .onInput=${(event: Event) =>
      update((event.target as HTMLInputElement).valueAsNumber)}
  ></toggle-input-card>`;
}

/** Adapt the arena settings to the shared native solo configuration UI. */
export function agentLobbySettings(
  settings: AgentSettings,
  update: UpdateSettings,
): GameConfigSettingsData {
  return {
    map: { selected: settings.gameMap, useRandom: settings.useRandomMap },
    difficulty: {
      selected: settings.difficulty,
      disabled: settings.nationCount === 0,
    },
    gameMode: { selected: settings.gameMode },
    teamCount: { selected: settings.playerTeams ?? 2 },
    options: {
      titleKey: "game_settings.options",
      bots: {
        value: settings.tribeCount,
        labelKey: "agents.tribes",
        disabledKey: "common.disabled",
      },
      nations: {
        value: settings.nationCount,
        labelKey: "agents.nations",
        disabledKey: "common.disabled",
      },
      toggles: [
        ...toggles.map(({ key, labelKey }) => ({
          labelKey,
          checked: settings[key],
        })),
        {
          labelKey: "game_settings.compact_map",
          checked: settings.gameMapSize === GameMapSize.Compact,
        },
        {
          labelKey: "game_settings.doomsday_clock",
          checked: settings.doomsdayClock?.enabled === true,
          doomsdayClockSpeed: settings.doomsdayClock?.speed ?? "normal",
        },
      ],
      inputCards: [
        numberCard(
          "game_settings.gold_multiplier",
          settings.goldMultiplier ?? undefined,
          2,
          0.1,
          1000,
          "any",
          (goldMultiplier) => update({ goldMultiplier }),
        ),
        numberCard(
          "game_settings.starting_gold",
          settings.startingGold === null || settings.startingGold === undefined
            ? undefined
            : settings.startingGold / 1_000_000,
          5,
          0,
          1000,
          "any",
          (value) =>
            update({
              startingGold:
                value === undefined ? undefined : Math.round(value * 1_000_000),
            }),
        ),
        numberCard(
          "game_settings.custom_alliances",
          settings.customAllianceDuration ?? undefined,
          0,
          0,
          15,
          1,
          (customAllianceDuration) => update({ customAllianceDuration }),
        ),
        numberCard(
          "game_settings.max_timer",
          settings.maxTimerValue ?? undefined,
          30,
          1,
          120,
          1,
          (maxTimerValue) => update({ maxTimerValue }),
        ),
        numberCard(
          "game_settings.overtime",
          settings.overtime?.enabled
            ? (settings.overtime.startMinutes ?? 30)
            : undefined,
          30,
          1,
          120,
          1,
          (startMinutes) =>
            update({
              overtime:
                startMinutes === undefined
                  ? undefined
                  : { enabled: true, startMinutes },
            }),
        ),
      ],
    },
    unitTypes: {
      titleKey: "game_settings.disable_units",
      disabledUnits: settings.disabledUnits,
    },
  };
}

export function agentOptionChange(
  settings: AgentSettings,
  labelKey: string,
  checked: boolean,
): Partial<AgentSettings> {
  const toggle = toggles.find((option) => option.labelKey === labelKey);
  if (toggle) return { [toggle.key]: checked };
  if (labelKey === "game_settings.compact_map")
    return { gameMapSize: checked ? GameMapSize.Compact : GameMapSize.Normal };
  return {
    doomsdayClock: {
      enabled: checked,
      speed: settings.doomsdayClock?.speed ?? "normal",
    },
  };
}
