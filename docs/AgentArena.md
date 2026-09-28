# Local agent arena

The arena runs on this computer. It uses the local game server and Codex subscription authentication.
It does not change the daily Codex configuration. Each player gets a separate persistent Codex thread.

## Failure cases to verify before implementation

- Reject an invalid player count, interval, concurrency, or token budget.
- Reject requests with a remote Host or Origin.
- Do not substitute scripted decisions when Codex authentication or a model fails.
- Run one decision per player at a time. Start the next interval after completion.
- Give each living player a fair place in the queue.
- Interrupt active decisions when paused. Reject tool actions after pause or stop.
- Serialize native compaction with decisions for that player.
- Pause when the token budget cannot reserve another decision or subscription quota is exhausted.
- Count cumulative token usage by deltas. Do not count repeated notifications twice.
- Stop decisions after elimination or match completion.
- Limit each decision to four tool calls and two actions. Interrupt a decision that exceeds a limit.
- Keep private game events within the recipient's observation and thread.
- Preserve actual thread IDs and full JSONL event logs.
- Scripted verification must use the real game, sockets, observation, scheduler, and action dispatch.

## Operation

Run `npm run dev:agents` to start the local game and arena. Run `npm run agents` when the game already runs.
Open `http://localhost:9000` and select **Agent lobby**.
Create a lobby. Choose **Play** or **Spectate**, then start the match.
Select a player to inspect its thread, tool calls, game events, and token usage.
The sidecar listens on `127.0.0.1:9010`. The development client proxies `/api/agents` to it.

The default has four players, two concurrent decisions, a 15-second decision interval, and a 100,000-token budget.
The configured ceiling is 200 players. Hardware, subscription limits, game duration, and decision costs determine the practical count.
The scheduler reserves 4,096 tokens before each decision. Actual usage can exceed the reservation for active decisions.
The budget is a stop threshold, not a provider-enforced billing cap.

Pause stops agent decisions. The multiplayer simulation continues. Stop closes agent sockets and the Codex runtime.
Scripted mode is for deterministic verification only. It does not use model tokens.
Runtime files and private thread logs are under `.agent-arena/`. Do not share these logs without review.

## Verification

Run `npm run test:agents` while `npm run dev:agents` runs.
The driver creates a scripted lobby, submits spawn and attack actions, and checks pause, resume, and stop.
It writes a repeatable report to `.agent-arena/e2e-report.json`.
Set `AGENT_E2E_COUNT=32` for a larger local check.
Real Codex verification requires explicit `AGENT_E2E_CODEX=1`. It uses one Luna player and pauses after one decision.
The verification sets `maxDecisionsPerPlayer: 1` to prevent a second model decision.
Set `AGENT_E2E_COUNT` and `AGENT_E2E_MAX_TOKENS` only when an explicit test allowance permits a larger check.

For browser verification, create two scripted players and choose **Spectate**.
Confirm that the native lobby lists two players and one spectator. Reload the page and start the match.
Confirm that the URL retains `spectate=1` and the map shows no human player controls.
Select an agent, load its full transcript, pause the agents, and stop them.
Repeat with **Play**. Confirm that the native lobby lists three players.
