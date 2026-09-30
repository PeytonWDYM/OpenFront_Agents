# Agent game mechanics

The arena creates a private game on the local development server. Each agent joins through a normal binary player WebSocket.
The server assigns each sender identity and collects its intents. One shared native `GameRunner` executes the server turns.
The bridge stops observations and actions if a turn is missing or the mirror reports an error.

`agent001` identifies an arena seat. `self.playerId` and `rivals[].playerId` identify native simulation players.
Use native player IDs in action targets and recipients. The bridge rejects additional fields, including a forged `clientID`.
Local player tokens use the development server's UUID authentication path. They are not production JWTs.
The Codex `act` tool accepts `{ "intent": { ... } }`. The examples below describe the inner native intent.

The default game includes 100 tribes and 52 nations. `tribeCount` and `nationCount` each accept 0 through 400.
The bridge sends the tribe count as native `bots`. It sends a positive nation count as native `nations`.
A nation count of zero sends native `nations: "disabled"`. Agents join as native `HUMAN` players.
Native nation creation selects map nations, then fills larger counts from additional profiles and generated nation names.
Current native player types are `HUMAN`, `BOT`, and `NATION`. This fork has no `FakeHuman` player type.

## Observation limits

Full observations include exact resources for the current player, public rival names and territory, legal action hints, and recent private events.
Rival entries omit troop totals and gold balances. Public leaderboard rows expose these values, as the native human scoreboard does.
Enemy attacks show their attacker and attack ID, without their committed troop totals. Private messages and ship cargo stay hidden.
Limits are 12 border targets, 4 boat targets, 8 build sites, 32 owned units, and 12 events.
Rivals include all current border players, attackers, allies, requestors, and recent event participants, plus up to 12 ranked players.
Current threats, allies, and shared borders rank first. Remaining players rank by distance without a player-type preference.
Observations include native player types and communication capabilities.
An explicit map region returns at most 64 terrain samples. Sample coordinates use native map coordinates and tile references.
Request `observe_world({ "quickChatKeys": true })` to read the supported chat keys when needed.
Request `observe_world({ "sections": ["communication"] })` for native chat keys and numeric emoji indexes.
Add `image: true` to a region query to receive a bounded map image through the native Codex image tool response.
Use `observe_world({ "playerId": nativePlayerId })` to focus on a human, nation, or tribe's current territory.
This query returns a map image and public target metadata. Its affiliation colors retain the requesting agent's viewpoint.
Unknown IDs and targets without owned territory fail. Do not combine this selector with coordinates or `nukePreview`.
Additional selected sections still describe the requesting agent. They cannot expose the target's private resources or messages.
Regional `sections: ["units"]` queries filter owned units before the 32-unit limit and include up to 32 public enemy structures.
These queries expose native unit IDs, types, tiles, and levels. They omit enemy ships and private resources.
Spawn candidates use native `getSpawnTiles()`. Build sites and costs use native `buildableUnits()` and `Config.unitInfo()`.
The event history retains at most 128 events from the last minute. Recipient filters match `EventsDisplay` and `ActionableEvents`.

Model decisions receive public map images and a compact snapshot. The inspector retains full observations.
The compact snapshot lists available actions, useful build sites, owned units, current threats, and relevant rival IDs.
It omits empty map samples and the complete construction cost list. It includes six ranked rivals and each relevant border or event participant.
The arena supplies private events since the previous decision. A decision should use its supplied snapshot before requesting more data.
Neutral expansion needs no map query. A region query returns only map data unless the caller selects other sections.
Supported sections are `self`, `rivals`, `map`, `events`, `units`, `costs`, `leaderboard`, and `communication`.
Section queries preserve recipient filters. A query cannot reveal another player's private messages or attack commitments.

The `victory` summary reports the native land threshold, non-fallout land denominator, owned share, and tiles still required.
Normal matches require more than 80% of non-fallout land. FFA alliances do not combine ownership. Team games use team ownership.
The summary also reports elapsed time, the optional lobby timer, the 170-minute native hard limit, and overtime settings.
Routine decisions include the top five land owners and the current agent's rank and public resources.
Request `sections: ["leaderboard"]` for all living players, public resource totals, income rates, unit levels, alliances, and betrayals.
Income rates reuse the native client's two-minute rolling calculation. Rates begin at zero until the bridge has two samples.

Each image provides its world `region` and the image's `mapPixels` rectangle. World coordinates increase rightward and downward.
The grid labels and legend identify positions, ownership, and player types. Legal tile references still come from observations.
Image labels `H<smallId>`, `N<smallId>`, and `T<smallId>` match the snapshot's public `smallId` values.
Actions use the corresponding native `playerId`, rather than an image label.
Frames remain under `.agent-arena/frames/<gameId>/` as repeatable inspection artifacts.
Structure symbols include their native level, such as `C3` for a level-3 City and `A5` for a level-5 SAM Launcher.
Owned units and regional public structures also expose exact levels. These upgrade stacks do not represent troops or gold.

Tactical and regional images show public ships, SAM coverage, and own or friendly territory cues.
Request `observe_world({ "nukePreview": { "type": "Atom Bomb", "tile": targetTile } })` before a planned launch.
This query returns an image with the selected silo, trajectory, blast radius, estimated interception point, and affected allies.
`Hydrogen Bomb` is also supported. `rocketDirectionUp` defaults to `true` and must match the eventual build action.
The preview bounds include the source, target, and curve. The returned image metadata identifies its actual region.
The compact preview reports native build legality, source and target tiles, blast radii, alliance risk, and estimated interception.
It reuses native alliance checks and the client's trajectory math. It does not replace the simulation.
SAM cooldowns, upgrades, and later state changes can alter interception. No displayed interception point does not guarantee a safe launch.
MIRV actions remain available. The bridge does not invent an Atom Bomb trajectory for MIRVs.

## Playing

Random spawn is the default. The native engine chooses spawn locations for all agent seats.
Native `SpawnExecution` uses a seeded random generator and requires legal, unoccupied land.
It requires a Manhattan distance of at least 30 from existing spawns for the first 750 attempts.
It then permits closer legal spawns until attempt 1,000. This native fallback supports crowded maps without changing the simulation.
The bridge does not replace native random placement. Manual agents should choose candidates far from nearby competitors.
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
Native attack rules reject friendly targets and illegal targets. Each agent starts with an attack ratio of 0.2.
The `act` tool accepts an optional root `attackRatio` from zero through one. It saves that fraction for the agent.
For example, `{ "intent": { "type": "attack", "targetID": null, "troops": null }, "attackRatio": 0.35 }` sends 35 percent.
A null attack troop amount uses the stored ratio. The bridge calculates troops from the player's current native balance before submission.
An explicit ratio overrides attack and boat troop amounts in that call. Explicit troop amounts remain exact when no ratio accompanies them.
The observation reports `self.attackRatio`. The acknowledgment reports the ratio and the resolved native intent.
The ratio follows the human attack slider. It does not change native combat, growth, or action validation.
An optional root `nextDecisionSeconds` selects the next decision delay from one through ten seconds.
Use it in an existing `act` call when a threat, landing, or build needs a faster check.
When waiting deliberately, `act({ "nextDecisionSeconds": 1 })` requests timing without a native game action.
Each call must supply an intent or timing. An attack ratio requires an intent.
The delay applies once. Routine decisions return to ten seconds. Timing metadata never enters the native intent.
Boat actions specify a native destination tile and a troop amount. The engine must find a valid shoreline launch and water route.
Transports require owned coastal access, without a Port. `boatTargets` includes legal neutral and rival landing sites.
The bridge checks each hint with native `canBuild(TransportShip, tile)`. `cancel_attack` and `cancel_boat` use owned attack or ship IDs.

Build actions use `build_unit`, a native unit type, and a tile. Check `buildSites` for the current legal site and cost.
A Warship build site uses its water patrol target. The engine selects a completed Port on connected water for the launch.
The bounded site list reserves a legal Warship hint when one exists. Affordability and native launch rules still apply.
`map.tradeTraffic` lists up to twelve nearby public Trade Ships with their current positions, owners, and public destination Ports.
Region queries filter traffic before this limit. Owner and destination affiliations distinguish self, team, ally, and other.
Other means non-allied. It does not assert that native piracy rules permit capture.
Image labels use `S<shipId>/<ownerSmallId><relation>`, where Y means self, T team, A ally, and O other.
Dashed destination lines and hollow endpoint diamonds show a public destination direction. They do not show the ship's actual water path.
The view omits private origins, cargo, and execution state. Captured trade pays piracy gold when it reaches the capturer's Port.
A first City costs 125,000 gold and normally takes 20 ticks to complete.
Later structure costs increase with native construction counts. Use the observed cost rather than a remembered price.
Owned units expose their IDs and upgrade eligibility. `upgrade_structure`, `move_warship`, and `delete_unit` use those IDs.
The engine enforces ownership, placement, affordability, and cooldowns for every action.
Use `act({ "intents": [firstIntent, secondIntent, ...] })` to submit multiple actions in one tool call.
Choose `intent` or `intents`. The bridge validates the complete batch before it submits actions in order.
There is no artificial action-count allowance. Batches return individual results and do not execute atomically.
For bulk upgrades, submit `upgrade_structure` with the structure's `unit`, numeric `unitId`, and `amount`, such as `5`.
The native engine buys as many requested levels as its resource and construction rules permit.
Use `observe_world({ "buildType": "Port", "sections": ["map"] })` to find multiple spaced build sites and upgrade IDs.

The spawn briefing explains each major structure and unit without a fixed build order:

- Cities increase troop capacity. Ports create sea trade and enable Warships. Connected sea routes can make Ports major income sources.
- Factories spawn trains between connected City, Port, and Factory stations. Trade and train visits generate gold.
- Defense Posts strengthen nearby land defense. Their cost competes with capacity and income investments.
- SAM Launchers intercept supported nuclear missiles. Upgrades increase coverage.
- Missile Silos launch Atom Bombs, Hydrogen Bombs, and MIRVs when construction, cooldown, and gold permit.
- Atom Bombs affect a smaller area. Hydrogen Bombs affect a larger area. Both can cause collateral damage and fallout.
- MIRVs split into warheads aimed at the selected player's territory. Their cost increases after global MIRV launches.
- Warships patrol water, capture hostile trade for gold, and fight ships or transports. Trade captures also increase veterancy.
- Transports carry troops to another shore. They require owned coastal access, without a Port.
- Trade Ships, trains, shells, SAM missiles, and MIRV warheads spawn through their parent structures or attacks.

Nuclear `build_unit` actions use the enemy target tile. The native engine selects the launch silo.
Build hints preserve that target tile instead of substituting the silo tile returned by the native placement check.
Agents receive early tribe-conquest guidance, mechanics, and tradeoffs. They choose their own actions and strategy.
Each City level adds the same capacity. SAM levels add reload slots, while range gains diminish at higher levels.
Port levels add trade spawning opportunities. Factory levels add train spawning opportunities. Missile Silo levels add reload slots.
Overlapping Defense Posts do not multiply the same tile's bonus. A post covers land within 30 tiles and adds no City capacity.
Upgrades count toward construction pricing. Current costs and useful coverage determine the tradeoff between upgrades and additional structures.

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

Tribes accept alliance requests and renewal requests automatically on their next eligible AI turn.
Tribes can receive Quick Chat and emojis, but tribe AI does not interpret those messages or send replies.
Nations decide alliances through native relation and strategy rules. Nation AI does not interpret Quick Chat.
Nations react to supported emojis. Peace, surrender, love, and applause emojis can produce a private reply.
Only Easy difficulty adds the friendly relation bonus from those emojis. Hostile emojis can reduce relations.
These responses use native `TribeExecution`, nation behavior, and normal diplomacy executions.

The bridge emits one `incoming_attack` event when a new land attack reaches the player's attack list.
Recipient-filtered native warnings produce `nuke_incoming` or `unit_incoming` events with available unit and target details.
Atom Bomb, Hydrogen Bomb, and MIRV warnings count as incoming nuclear threats.
Native detonation messages produce private `nuke_impact` events only for affected players. Intercepted missiles produce no impact event.
Native death updates immediately interrupt the eliminated agent and stop later decisions and actions.
Incoming chat, alliance requests, alliance replies, alliance renewal requests, betrayal, expiry, and donations can wake a decision.
Outgoing actions and public emojis do not trigger the same recipient wake. Event data never includes rival troop or gold totals.

An `act()` result means the socket submitted the intent. It does not prove that the engine executed it.
Observe the next native turns to confirm changes, incoming events, and final game results.
Management intents, kicks, pause, game configuration, and server disconnection intents are excluded from agent actions.

The agent prompt explains expansion, reserves, investment, defense, and diplomacy.
Nearby non-allied tribes are suggested as early conquest opportunities. No fixed strategy or native bot policy controls agent decisions.
Agents retain all 20 native player actions, including structures, upgrades, ships, donations, embargos, and diplomacy.
The model chooses its strategy. The bridge does not copy native nation decision code or select model actions.

## Verification

Run `npx tsx tests/agents/game-e2e.ts` while the local client and development server run.
The driver uses eight real native player connections. It checks spawn, expansion, alliance requests, Quick Chat privacy, and City construction.
It also rejects management intents and forged sender fields. It writes `.agent-arena/game-e2e.json` after each run.
It checks persisted attack ratios, default and selected percentages, exact explicit amounts, fractional boat forces, and invalid ratios.
Run `npx tsx tests/agents/game-e2e.ts --controls-only` to skip the City income wait while checking these controls and native diplomacy.

Run `npx tsx tests/agents/game-e2e.ts --native-only` without a server or model connection.
This driver runs the native map and simulation with eight human agents, 100 tribes, and 52 nations.
It checks native random spacing, repeatable seeded spawns, tribe alliance acceptance, Quick Chat delivery, and nation emoji replies.
It checks recipient IDs, relevant rival visibility, resource privacy, and compact snapshot size.
It launches a transport without a Port, confirms the landing, and verifies a native Atom Bomb target.
It checks regional retrieval of an owned unit beyond the default limit and public enemy structure visibility.
It also checks 11 tribes with seven, zero, and 64 nations. Each configured nation must actually spawn.
The driver writes `.agent-arena/native-population-e2e.json` with its seed, setup, spawns, events, and byte counts.

Run `npx tsx tests/agents/events-e2e.ts` to verify native nuclear warning, impact, privacy, interception, and elimination events.
The driver writes `.agent-arena/events-e2e.json`. It makes no model request and needs no running server.
Run `npx tsx tests/agents/vision-e2e.ts` for regional and player-focused images, public ships, structure levels, SAM coverage, and missile previews.
The driver saves repeatable PNG and JSON artifacts without a model request.

Rules above come from `src/core/configuration/Config.ts`, native execution classes, and the client event filters.
The bridge imports those rules directly. It does not maintain a separate game simulation.
