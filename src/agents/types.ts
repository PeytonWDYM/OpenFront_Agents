export type ArenaPhase =
  | "idle"
  | "lobby"
  | "running"
  | "paused"
  | "stopped"
  | "error";

export type ArenaSettings = import("zod").output<
  typeof import("./Settings").ArenaSettingsSchema
>;

export interface ArenaJoin {
  clientId: string;
  spectator: boolean;
}

export interface AgentTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type AgentReasoningEffort = "low" | "medium";

export interface AgentPlayer {
  id: string;
  clientId: string;
  name: string;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  status: string;
  alive: boolean;
  tokens: number;
  tokenUsage?: AgentTokenUsage;
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
  tokenUsage?: AgentTokenUsage;
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
