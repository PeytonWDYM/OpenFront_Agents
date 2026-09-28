import type { AgentAction, AgentObservation } from "./game/schemas";

/** Deterministic decisions for the real-engine verification mode. */
export function scriptedAction(
  observation: AgentObservation,
): AgentAction | null {
  if (observation.spawnPhase && !observation.self.spawned) {
    const candidate = observation.map.spawnCandidates[0];
    return candidate ? { type: "spawn", tile: candidate.tile } : null;
  }
  if (observation.spawnPhase) return null;
  if (!observation.self.spawned || observation.self.troops < 100) return null;
  return {
    type: "attack",
    targetID: null,
    troops: Math.floor(observation.self.troops / 5),
  };
}
