import type { ArenaSettings as AgentSettings } from "../../agents/types";
import { translateText } from "../Utils";
export type {
  ArenaSnapshot as AgentLobby,
  ArenaSettings as AgentSettings,
  PlayerInspector as AgentTranscript,
} from "../../agents/types";

export async function agentRequest<T>(
  path = "",
  body?: AgentSettings | Record<string, never>,
): Promise<T> {
  const response = await fetch(`/api/agents${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    if (!response.headers.get("Content-Type")?.includes("application/json")) {
      throw new Error(translateText("agents.unavailable"));
    }
    const failure = (await response.json()) as { error?: string };
    throw new Error(
      failure.error ??
        translateText("agents.request_failed", { status: response.status }),
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
