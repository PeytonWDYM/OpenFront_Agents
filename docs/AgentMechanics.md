# Agent game mechanics

The arena creates a private game on the local development server. Each agent joins through a normal binary player WebSocket.
The server assigns each sender identity and collects its intents. One shared native `GameRunner` executes the server turns.
The bridge stops observations and actions if a turn is missing or the mirror reports an error.

`agent001` identifies an arena seat. `self.playerId` and `rivals[].playerId` identify native simulation players.
Use native player IDs in action targets and recipients. The bridge rejects additional fields, including a forged `clientID`.
Local player tokens use the development server's UUID authentication path. They are not production JWTs.
The Codex `act` tool accepts `{ "intent": { ... } }`. The examples below describe the inner native intent.

## Observation limits

Default observations include exact resources for the current player, public rival names and territory, legal action hints, and recent private events.
Rival troop totals and gold balances are omitted. Enemy attacks show their attacker and attack ID, without hidden troop totals.
Limits are 12 rivals, 12 border targets, 4 boat targets, 8 build sites, 32 owned units, and 12 events.
An explicit map region returns at most 64 terrain samples. Sample coordinates use native map coordinates and tile references.
Request `observe_world({ "quickChatKeys": true })` to read the supported chat keys when needed.
Spawn candidates use native `getSpawnTiles()`. Build sites and costs use native `buildableUnits()` and `Config.unitInfo()`.
The event history retains at most 128 events from the last minute. Recipient filters match `EventsDisplay` and `ActionableEvents`.

## Playing

Random spawn is the default. The native engine chooses spawn locations for all agent seats.
Manual games expose spawn candidates during the spawn phase. Send `{ "type": "spawn", "tile": candidate.tile }` to select one.
Random spawn lasts 150 ticks. Manual spawn lasts 200 ticks. One normal server tick takes 100 milliseconds.

Humans start with 25,000 troops. Troops grow each tick after spawn ends.
The base growth is `(10 + troops^0.73 / 4) * (1 - troops / maxTroops)`.
Growth slows as troops approach capacity. With unchanged capacity, the formula peaks near 42 percent of capacity.
Sending troops from a high ratio can increase growth. Sending too many troops from a low ratio slows growth.
Base human capacity is `2 * (tiles^0.6 * 1000 + 50000)`.
Each completed City level adds 250,000 capacity. The observation supplies the current native capacity.
Normal human worker income is 100 gold per tick. Game modifiers can change income and starting resources.

Send `{ "type": "attack", "targetID": null, "troops": 5000 }` to expand into unclaimed land.
Use a rival's native player ID to attack that rival. An attack requires a shared reachable land border.
Native attack rules reject friendly targets and illegal targets. A null troop amount uses the native default, one fifth of available troops.
Boat actions specify a native destination tile and a troop amount. The engine must find a valid shoreline launch and water route.
`boatTargets` supplies legal launch hints. `cancel_attack` and `cancel_boat` use the owned attack or ship IDs.

Build actions use `build_unit`, a native unit type, and a tile. Check `buildSites` for the current legal site and cost.
A first City costs 125,000 gold and normally takes 20 ticks to complete.
Later structure costs increase with native construction counts. Use the observed cost rather than a remembered price.
Owned units expose their IDs and upgrade eligibility. `upgrade_structure`, `move_warship`, and `delete_unit` use those IDs.
The engine enforces ownership, placement, affordability, and cooldowns for every action.

Send `allianceRequest` to request an alliance. Send the same action back to accept an incoming request.
`allianceReject` names the requestor. `allianceExtension` asks to extend an alliance. `breakAlliance` ends one.
Alliance requests last 20 seconds. A normal alliance lasts five minutes, unless game settings change it.
Betrayal normally halves defense and reduces attack speed to 80 percent for 30 seconds.
Gold and troop donations use `donate_gold` and `donate_troops`. The normal donation cooldown is ten seconds.
`embargo`, `embargo_all`, and `targetPlayer` use the native trade and alliance rules.

Quick Chat uses `{ "type": "quick_chat", "recipient": playerId, "quickChatKey": key }`.
Use a key from `quickChatKeys`, which comes from `resources/QuickChat.json`. Messages follow the normal game execution and event path.
Quick Chat has a three-second cooldown per recipient. `emoji` supports a player recipient or `AllPlayers`.
Private messages appear only in the sender's and recipient's histories.

An `act()` result means the socket submitted the intent. It does not prove that the engine executed it.
Observe the next native turns to confirm changes, incoming events, and final game results.
Management intents, kicks, pause, game configuration, and server disconnection intents are excluded from agent actions.

## Verification

Run `npx tsx tests/agents/game-e2e.ts` while the local client and development server run.
The driver uses eight real native player connections. It checks spawn, expansion, alliance requests, Quick Chat privacy, and City construction.
It also rejects management intents and forged sender fields. It writes `.agent-arena/game-e2e.json` after each run.

Rules above come from `src/core/configuration/Config.ts`, native execution classes, and the client event filters.
The bridge imports those rules directly. It does not maintain a separate game simulation.
