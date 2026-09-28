# Local agent arena

The arena runs on this computer. It uses the local game server and Codex subscription authentication.
It does not change the daily Codex configuration. Each player gets a separate persistent Codex thread.

## Failure cases to verify before implementation

- Reject an invalid agent, tribe, or nation count and removed configuration fields.
- Reject requests with a remote Host or Origin.
- Do not substitute scripted decisions when Codex authentication or a model fails.
- Run one decision per player at a time, with independent decisions for more than 16 agents.
- Coalesce important events during an active decision into one fresh decision after a short cooldown.
- Continue quiet-player decisions every 10 seconds after completion without a decision count limit.
- Honor a requested next-decision delay without overlapping turns or keeping the override for later turns.
- Reject requested delays outside one to 10 seconds. Permit a turn without a gameplay action to select its next delay.
- Give each living player a fair place in the queue.
- Interrupt active decisions when paused. Reject tool actions after pause or stop.
- Serialize native compaction with decisions for that player.
- Pause when the Codex subscription reports exhausted quota or a rate limit.
- Keep token usage visible without a configured token limit.
- Count cumulative token usage by deltas. Do not count repeated notifications twice.
- Show native input, cached input, cache-write input, output, and reasoning output for each agent and the combined list.
- Treat cached input and reasoning output as subsets. Derive uncached input from input minus cached input.
- Stop decisions after elimination or match completion.
- Limit each decision to four tool calls and two actions. Interrupt a decision that exceeds a limit.
- Reject attack ratios outside zero to one. Keep each player's ratio separate.
- Apply the stored ratio when attack troops are null and report the resolved native troop count.
- Keep private game events within the recipient's observation and thread.
- Preserve actual thread IDs and full JSONL event logs.
- Scripted verification must use the real game, sockets, observation, scheduler, and action dispatch.

## Operation

Run `npm run dev:agents` to start the local game and arena. Run `npm run agents` when the game already runs.
Open `http://localhost:9000` and select **Agent lobby**.
Choose the agent, tribe, and nation counts, then select **Play** or **Spectate**.
The arena creates the lobby, joins the native page, and starts after the server confirms your selected role.
Select a player to inspect its thread, tool calls, game events, and token usage.
The agent list shows combined token usage. Each thread view shows only that player's token usage.
Usage updates when Codex reports it. Scripted tests do not use model tokens.
Expand **Usage breakdown** to inspect input, cached input, uncached input, output, and reasoning output.
Cache-write input appears when positive. Cached input belongs to input, and reasoning output belongs to output.
Older running arenas keep their headline totals and report that detailed usage is unavailable until the runtime reloads.
The sidecar listens on `127.0.0.1:9010`. The development client proxies `/api/agents` to it.

The default has four agents, 100 tribes, and 52 nations on the Europe map.
The agent ceiling is 200. The tribe and nation counts each range from zero to 400.
The scheduler permits one concurrent decision for each four agents, rounded up, without a fixed concurrency ceiling.
Each agent decides every 10 seconds after its previous decision completes.
The queue serves the earliest due turn first. Urgency breaks ties, so event floods cannot starve overdue quiet agents.
An agent can request its next decision in one to 10 seconds with the action tool's `nextDecisionSeconds` field.
For example, `act({nextDecisionSeconds: 2})` schedules an earlier check without a gameplay action.
The agent can also include this field with a normal intent. The last request in that turn wins.
Each later turn returns to the 10-second default unless the agent requests another delay.
Agents continue until you pause or stop them, the match ends, or the subscription reports a limit.
Each decision includes live overview and tactical map images with a small numeric snapshot.
The bridge reads the latest native tick when a decision starts. Tick updates alone do not request model inference.
It supplies only events newer than that agent's previous observation. Inspector logs stay local and are not appended to each prompt.
Earlier decisions remain in the persistent Codex thread and can contribute cached input until native compaction.
Agents can request focused data when they need exact tiles, costs, or communication choices.
Each decision includes current build prices, including units the agent cannot yet afford.
The action bridge checks native build legality before submission. Invalid builds report the required gold and current balance.
Troop transports use `boat`, so they do not appear as `build_unit` placement hints.
They also receive native victory progress and a short public leaderboard. A leaderboard query returns all living players and scoreboard columns.
Public trade observations and map cues identify ship owners, destination Ports, and owner or destination affiliations.
Warship hints use legal water patrol targets. Agents can submit one or two native actions in a single `act` call.
Batch actions share the existing per-decision allowance and return individual submission results.
The `think` tool records a short strategy note and can inspect a focused region in the same call.
It keeps Low reasoning and the existing call allowance. Routine decisions can act directly.
They can request a regional image or inspect owned units and public enemy structures within that region.
They can also focus an image on any human, nation, or tribe by its native player ID.
Focused views show current public territory and keep the requesting agent's private information separate.
The action tool accepts `attackRatio` as a fraction from zero to one. Each player starts at `0.2`.
For example, `act({intent: {type: "attack", targetID: null, troops: null}, attackRatio: 0.35})` sends 35% of current troops.
The player keeps that ratio for later attacks with null troops.
An explicit troop count applies when the call omits `attackRatio`.
The inspector shows the same decision images. Frame files remain under `.agent-arena/frames/`.
Incoming attacks, nukes, chat, and diplomacy can trigger an earlier decision after a five-second cooldown.
Actual nuclear impacts also wake affected agents. Native elimination updates immediately halt the eliminated agent.
Events during a decision schedule one fresh decision. Outgoing actions and broadcast emoji do not trigger another decision.
The arena reports token usage without a configured token limit. Real subscription quota and rate limits still pause decisions.
Hardware, subscription limits, match duration, and decision costs determine the practical agent count.

Pause stops agent decisions. The multiplayer simulation continues. Stop closes agent sockets and the Codex runtime.
Scripted mode is for deterministic verification only. It does not use model tokens.
Runtime files and private thread logs are under `.agent-arena/`. Do not share these logs without review.

## Verification

Run `npm run test:agents` while `npm run dev:agents` runs.
The driver checks the scheduler, then creates a scripted native lobby and submits attack actions.
It checks pause, resume, stop, settings, and localhost request boundaries.
It writes a repeatable report to `.agent-arena/e2e-report.json`.
Set `AGENT_E2E_COUNT=32` for a larger local check.
Real Codex verification requires explicit `AGENT_E2E_CODEX=1`. It uses one Luna player and pauses after one decision.
The test driver pauses after the first model decision and stops the arena during cleanup.
Set `AGENT_E2E_COUNT` only when an explicit test allowance permits a larger Codex check.

For browser verification, choose two agents and select **Spectate**.
Confirm that the native lobby includes two agents and your spectator seat before the match starts.
Confirm that the URL retains `spectate=1` and the map shows no human player controls.
Select an agent, load its full transcript, pause the agents, and stop them.
Repeat with **Play**. Confirm that the native match includes your player seat and two agents.
