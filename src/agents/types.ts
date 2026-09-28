export type ArenaPhase =
  | "idle"
  | "lobby"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export interface ArenaSettings {
  agentCount: number;
  tribeCount: number;
  nationCount: number;
  mode: "codex" | "scripted";
}

export interface ArenaJoin {
  clientId: string;
  spectator: boolean;
}

export interface AgentPlayer {
  id: string;
  clientId: string;
  name: string;
  threadId: string | null;
  status: string;
  alive: boolean;
  tokens: number;
  decisions: number;
  lastAction?: string;
  error?: string;
}

export interface ArenaSnapshot {
  phase: ArenaPhase;
  gameId: string | null;
  players: AgentPlayer[];
  settings: ArenaSettings;
  runtime: { authenticated: boolean; models: string[]; error?: string };
  totalTokens: number;
  error?: string;
}

export interface PlayerEvent {
  time: number;
  type: string;
  text: string;
  image?: string;
}

export interface PlayerInspector {
  player: AgentPlayer;
  events: PlayerEvent[];
}
