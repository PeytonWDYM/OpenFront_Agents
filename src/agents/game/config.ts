import { z } from "zod";
import { GameConfig, GameConfigSchema } from "../../core/Schemas";
import { GameMapType, GameType } from "../../core/game/Game";
import { AgentGameSettingsSchema } from "../Settings";

export type AgentGameConfigOptions = z.input<typeof AgentGameSettingsSchema> & {
  tribeCount?: number;
  nationCount?: number;
};

/** Resolve Random once, before the native server and all clients receive the config. */
export function agentGameConfig(options: AgentGameConfigOptions): GameConfig {
  const { useRandomMap, ...settings } = AgentGameSettingsSchema.parse(options);
  const maps = Object.values(GameMapType);
  return GameConfigSchema.parse({
    ...settings,
    gameMap: useRandomMap
      ? maps[Math.floor(Math.random() * maps.length)]
      : settings.gameMap,
    gameType: GameType.Private,
    bots: options.tribeCount ?? 100,
    nations:
      options.nationCount === 0 ? "disabled" : (options.nationCount ?? 52),
    donateGold: true,
    donateTroops: true,
  });
}

export function matchSettingsPrompt(config: GameConfig): string {
  const { spawnReadyClientIDs, ...settings } = config;
  const spawnRule = spawnReadyClientIDs
    ? " Choose a spawn tile in your first decision. After all placements, review your location and optionally relocate up to twice. The native countdown starts after every agent finishes review."
    : "";
  return `MATCH SETTINGS\nThe native lobby uses this configuration: ${JSON.stringify(settings)}\nThese settings override standard mechanics described below. Disabled units cannot be built. Infinite resources, instant builds, alliance duration, team victory, timers, overtime, and the Doomsday Clock apply when enabled. Use current legal sites, costs, available actions, and victory progress from observations. In team mode, teammates share victory.${spawnRule}\n\n`;
}
