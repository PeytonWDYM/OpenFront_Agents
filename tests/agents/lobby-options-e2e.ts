// Failure cases: selected maps or modifiers disappear before native creation,
// random maps remain unresolved, invalid native values pass validation,
// default lobbies change, disabled units remain buildable, and team mode is ignored.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Arena } from "../../src/agents/Arena";
import { AgentGame } from "../../src/agents/game/AgentGame";
import { agentGameConfig } from "../../src/agents/game/config";
import { ArenaSettingsSchema } from "../../src/agents/Settings";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  UnitType,
} from "../../src/core/game/Game";
import { GameInfoSchema } from "../../src/core/Schemas";

const defaults = ArenaSettingsSchema.parse({});
const baseline = agentGameConfig(defaults);
assert.equal(baseline.gameMap, GameMapType.Europe);
assert.equal(baseline.gameMapSize, GameMapSize.Compact);
assert.equal(baseline.randomSpawn, false);
assert.equal(baseline.nations, 52);
assert.equal(baseline.bots, 100);
assert.equal(baseline.difficulty, Difficulty.Easy);
for (const invalid of [
  { gameMap: "missing-map" },
  { gameMapSize: "huge" },
  { startingGold: -1 },
  { goldMultiplier: 0 },
  { disabledUnits: ["missing-unit"] },
  { customAllianceDuration: 16 },
  { playerTeams: 1 },
  { mediumAgentCount: 5, agentCount: 4 },
])
  assert.equal(ArenaSettingsSchema.safeParse(invalid).success, false);
const random = agentGameConfig(
  ArenaSettingsSchema.parse({ useRandomMap: true }),
);
assert.ok(Object.values(GameMapType).includes(random.gameMap));

const settings = ArenaSettingsSchema.parse({
  agentCount: 2,
  mode: "scripted",
  tribeCount: 0,
  nationCount: 0,
  gameMap: GameMapType.Africa,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.Team,
  playerTeams: 2,
  difficulty: Difficulty.Hard,
  randomSpawn: true,
  instantBuild: true,
  startingGold: 5_000_000,
  goldMultiplier: 2,
  infiniteTroops: true,
  waterNukes: true,
  customAllianceDuration: 0,
  maxTimerValue: 45,
  doomsdayClock: { enabled: true, speed: "fast" },
  overtime: { enabled: true, startMinutes: 20 },
  disabledUnits: [UnitType.City, UnitType.Port],
});
const expected = agentGameConfig(settings);
const game = new AgentGame(settings);
try {
  const lobby = await game.create();
  const response = await fetch(
    `http://localhost:${3001 + lobby.workerId}/api/game/${lobby.gameId}`,
  );
  assert.equal(response.ok, true);
  const native = GameInfoSchema.parse(await response.json());
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(
      native.gameConfig![key as keyof typeof expected],
      value,
      key,
    );
  await game.start();
  const start = game.gameStart!;
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(start.config[key as keyof typeof expected], value, key);
  const observation = game.observe("agent001");
  assert.ok(
    !observation.map.buildSites.some(
      (site) => site.type === UnitType.City || site.type === UnitType.Port,
    ),
  );
  await mkdir(".agent-arena", { recursive: true });
  await writeFile(
    ".agent-arena/lobby-options-checks.json",
    JSON.stringify(
      {
        defaults: baseline,
        random,
        native: start.config,
        gameId: lobby.gameId,
        observation,
      },
      null,
      2,
    ),
  );
  console.log(
    "Native map, modifiers, team mode, validation, and disabled units passed.",
  );
} finally {
  await game.close();
}

// A manual-spawn lobby must let agents choose a native tile during spawn phase.
const manualArena = new Arena();
try {
  await manualArena.create({
    agentCount: 1,
    tribeCount: 0,
    nationCount: 0,
    mode: "scripted",
    randomSpawn: false,
  });
  await manualArena.start();
  const deadline = Date.now() + 8000;
  while (!manualArena.observe("agent001").self.spawned && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const manual = manualArena.observe("agent001");
  assert.equal(manual.spawnPhase, true);
  assert.equal(
    manual.self.spawned,
    true,
    "agent must spawn before native fallback",
  );
  assert.ok(manualArena.snapshot().players[0].decisions > 0);
  await writeFile(
    ".agent-arena/manual-spawn-checks.json",
    JSON.stringify(
      {
        snapshot: manualArena.snapshot(),
        observation: manual,
        transcript: manualArena.inspect("agent001"),
      },
      null,
      2,
    ),
  );
  console.log("Manual spawn agent choice passed.");
} finally {
  await manualArena.stop();
}
