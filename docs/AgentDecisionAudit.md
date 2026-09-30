# Agent decision audit

The review covers all 30 agents in game aSNkEZLMQj and all 30 in the previous game abcuP7fMAP. Current-game evidence stops at September 30, 2026, 08:10:31.759 UTC. Every saved event record was parsed. Six reviewers inspected the full chronological tool calls, responses, observations, errors, and game events for their assigned players.

The corpus contains 101,745 event records, 1,891 completed decisions, and 2,054 completed tool calls. Streaming copies were removed from the readable timelines. Pending turns remain identified. Image metadata supplies exact tiles and coordinates. The review does not claim inspection of every image pixel.

## Findings

- The harness accepted enemy attack cancellations and enemy Warship commands that the native game ignores. Agents then described these commands as completed actions.
- Accepted construction and upgrade batches often produced fewer purchases than agents expected. Native upgrades charge during initialization. New construction charges on a later tick. Submission order does not reserve gold for the builds listed first.
- General build suggestions sometimes offered owned City tiles as nuclear targets. These suggestions conflicted with the self-target guard and the prompt.
- The first 32 owned units could contain trains and trade ships while omitting newer military structures. A missing snapshot unit also could have appeared and died between decisions. Missing state alone does not prove failed construction.
- Missile previews were seldom requested. Existing interception messages reached the SAM owner, with no missile identity or shooter outcome. Nuclear impact notices lacked usable global identity and location.
- Conquest bursts could crowd important events out of the default observation. Income rates could remain positive after infrastructure losses because they use a trailing two-minute window.
- Agents built dense City, Factory, and Silo clusters. Some native Atom Bomb events were followed by losses across an entire cluster. Other clusters show exposure without evidence of an actual hit. Defense Posts cannot intercept missiles.
- Only 13 current-game players submitted a Warship by cutoff. Some ships earned substantial piracy income. Others died before the next decision. The review distinguishes these outcomes from submissions.

Current players began with five million gold. The previous match used different settings. These matches do not isolate a context-window or reasoning-level effect.

## Per-agent coverage

Each pair below is current / previous. Warship counts are submitted intents, not confirmed builds. Previews count completed explicit nukePreview queries.

| Agent | Current reasoning | Decisions | Completed tools | Warship submissions | Missile previews |
| ----- | ----------------- | --------: | --------------: | ------------------: | ---------------: |
| 1     | medium            |   45 / 32 |         53 / 34 |               2 / 0 |            3 / 0 |
| 2     | medium            |   23 / 29 |         25 / 31 |               2 / 1 |            0 / 0 |
| 3     | medium            |   47 / 29 |         55 / 31 |               0 / 0 |            4 / 0 |
| 4     | medium            |   13 / 30 |         14 / 30 |               0 / 0 |            0 / 0 |
| 5     | medium            |   26 / 30 |         29 / 31 |               2 / 0 |            2 / 0 |
| 6     | medium            |   32 / 29 |         33 / 31 |               0 / 1 |            0 / 0 |
| 7     | medium            |   49 / 28 |         56 / 29 |               4 / 0 |            2 / 0 |
| 8     | medium            |    8 / 29 |          8 / 33 |               0 / 0 |            0 / 0 |
| 9     | medium            |   47 / 26 |         53 / 27 |               0 / 0 |            2 / 0 |
| 10    | medium            |   13 / 31 |         13 / 31 |               0 / 0 |            0 / 0 |
| 11    | medium            |   35 / 28 |         37 / 30 |               0 / 0 |            1 / 0 |
| 12    | medium            |   48 / 14 |         52 / 14 |               1 / 0 |            1 / 0 |
| 13    | low               |   51 / 29 |         61 / 31 |               2 / 0 |            2 / 0 |
| 14    | low               |   52 / 29 |         55 / 33 |               0 / 1 |            0 / 0 |
| 15    | low               |   26 / 30 |         27 / 30 |               1 / 0 |            0 / 0 |
| 16    | low               |   13 / 31 |         16 / 32 |               0 / 1 |            0 / 0 |
| 17    | low               |   25 / 27 |         25 / 30 |               0 / 1 |            0 / 0 |
| 18    | low               |   21 / 30 |         21 / 32 |               1 / 3 |            0 / 0 |
| 19    | low               |   55 / 28 |         63 / 30 |               1 / 1 |            0 / 0 |
| 20    | low               |   30 / 27 |         33 / 28 |               0 / 0 |            0 / 0 |
| 21    | low               |   28 / 29 |         30 / 30 |               0 / 0 |            0 / 0 |
| 22    | low               |   47 / 31 |         49 / 31 |               2 / 0 |            0 / 0 |
| 23    | low               |   50 / 31 |         60 / 30 |               0 / 0 |            1 / 0 |
| 24    | low               |   33 / 29 |         40 / 30 |               1 / 0 |            2 / 0 |
| 25    | low               |   38 / 17 |         42 / 18 |               1 / 0 |            3 / 0 |
| 26    | low               |   30 / 29 |         34 / 31 |               0 / 3 |            1 / 0 |
| 27    | low               |   25 / 27 |         26 / 29 |               0 / 0 |            0 / 0 |
| 28    | low               |   45 / 31 |         56 / 35 |               6 / 1 |            0 / 0 |
| 29    | low               |   35 / 30 |         37 / 33 |               0 / 1 |            1 / 0 |
| 30    | low               |   54 / 27 |         57 / 29 |               0 / 0 |            0 / 0 |

The six full reports and reproducible readers are saved under out/agent-audit/audit-01-05 through audit-26-30. Immutable normalized transcripts, run identifiers, cutoff, and player-level counts are saved beside them. These files contain local match evidence and are not part of the source distribution.

## Mechanic and creator checks

The latest official stable release checked was [v0.34.20](https://github.com/openfrontio/OpenFrontIO/releases/tag/v0.34.20). Exact tool facts follow this fork's code and lobby settings. September auto-caption transcripts were checked directly. They were not replaced with third-party video summaries.

Ports can fund further trade investment. Returns depend on foreign endpoints, travel distance, connected water, embargoes, piracy, and saturation. Growth is not guaranteed exponential. Warships can earn piracy gold by chasing eligible trade ships and directing captures to a completed reachable Port. They do not capture all trade instantly within a broad radius.

[Biff's September 29 match](https://www.youtube.com/watch?v=EdV0SRwmQmo&t=146s) shows a deliberate Warship purchase and alliances that reduce mutual piracy. [Rex's September 21 match](https://www.youtube.com/watch?v=UBqT2eJrG5Y&t=233s) shows the economic opportunity and cost of naval attrition. At [18:20](https://www.youtube.com/watch?v=UBqT2eJrG5Y&t=1100s), Rex spreads Cities. [Enzo's September 15 match](https://www.youtube.com/watch?v=x-gZ2IFXfnY&t=207s) weighs expansion against exposed fronts and reserves. These examples support conditional choices, not a fixed build order.

Completed Defense Posts affect defended land within 30 tiles. Their coverage does not stack, and they have no upgrades. Nuclear blasts destroy whole structures within the outer radius. SAM protection depends on construction, range, missile slots, and reloads. The intact MIRV carrier cannot be intercepted. Its separated warheads can.

The changes preserve player choice. They add useful observations, exact native notifications, and clearer action receipts. They do not add spending quotas, attack quotas, or forced strategies.

## Verification

The focused checks run native game simulation without inference or live matches. Each writes repeatable evidence under `.agent-arena/`:

- `tests/agents/action-legality-e2e.ts`: owned controls, native shore targets, deletion, and alliance renewal.
- `tests/agents/batch-feedback-e2e.ts`: native purchase order, pending receipts, and observed-state feedback.
- `tests/agents/missile-feedback-e2e.ts`: interception attribution, public nuclear events, and private recipient isolation.
- `tests/agents/military-intel-e2e.ts`: actual threats, construction, reload slots, defense coverage, and infrastructure exposure.
- `tests/agents/trade-heatmap-e2e.ts`: native piracy filters, legal water targets, patrol ranges, and a rendered heatmap.
- `tests/agents/qol-integration-e2e.ts`: complete tool results, prioritized units, both bomb preview images, and schema sizes.

Run a check with `node node_modules/tsx/dist/cli.mjs tests/agents/<name>.ts`. Full TypeScript, lint, and production build checks also apply. Existing SAM and nuclear simulation tests were run with a local Windows path-alias configuration because the standard runner resolves a legacy browser path polyfill.

## Agent 17 follow-up: initiative and missile spending

This review covers Agent 17 - medium in game `agXF9DByww`.
The frozen evidence ends at September 30, 2026, 10:54:23.460 UTC.
It contains 45 completed decisions and one pending decision.
The local evidence is `.agent-arena/audits/agent017-missile-review.json` in the serving checkout.
Counts below describe this cutoff, rather than the later complete match.

Agent 17 submitted two new silos and 29 silo upgrade calls requesting 137 levels.
Requested levels are not purchased levels. Bulk upgrades stop when native requirements fail.
Some owned silos came from conquests. One tracked silo rose from level 1 to level 59.
The agent reached 80 ready launch slots but usually submitted one bomb per decision.
It submitted 38 Atom Bomb intents. The event log recorded 18 launches, 15 interceptions, and three impacts.
A submitted intent is not proof of a launch. The remaining 20 submissions had no recorded launch by this cutoff.
The agent made six explicit observations, no missile preview query, and no saved strategy note.
It continued to request upgrades despite idle slots and repeated interception feedback.

The batch warning missed missile-only builds combined with upgrades.
Native upgrades spend gold during initialization, before missile execution ticks, regardless of submission order.
At decision 32, the agent had 1,214,017 gold and requested silo upgrades plus a 750,000-gold Atom Bomb.
A silo upgrade costs 1,000,000 gold under these settings.
This combination can spend the launch budget before the missile executes.
A focused native simulation reproduces that failure and confirms that multiple same-target missiles can launch with sufficient resources.
The warning now includes missile launches. It does not reserve gold, reorder actions, or impose an action limit.
The logs do not prove that this budget collision caused every missing launch.

The agent also divided small troop allocations among several fronts.
At decision 14, it had 4,002,765 troops. Bordering Tanzania had 361,426 troops and Ethiopia had 967,207.
It requested a six-percent ratio separately against four rivals and neutral land.
At decision 43, it had 12,170,126 troops with no incoming attacks.
Bordering DR Congo had 942,262 troops, 36,862 tiles, and 28,815,695 gold.
The agent requested a four-percent ratio against DR Congo and neutral land, plus another silo upgrade.
These facts show a visible opening and a small requested commitment. They do not establish a guaranteed winning attack.
Terrain, defense coverage, troop density, and commitments elsewhere still matter.

The median interval between post-spawn decision snapshots was 24 seconds.
Medium nations check attacks every 55 to 70 simulation ticks, or about 5.5 to 7 seconds.
Their structure behavior also runs between attack checks.
The native target pipeline examines borders, tribes, damaged opponents, diplomacy, and weaker enemies without model inference.
This gives nations a timing and domain-policy advantage. It does not show that their general intelligence exceeds Luna's.
Native sources are `NationExecution.ts` and `utils/AiAttackBehavior.ts` under `src/core/execution/`.

The prompt revision puts autonomous strategy before the mechanics reference.
It asks agents to choose useful objectives, notice temporary openings, compare spending alternatives, and reconsider plans after actual outcomes.
It removes repeated fixed upgrade counts and attack-ratio examples that could anchor repeated batches.
Mechanics remain facts, rather than a required build order or attack quota.
Missile previews, SAM coverage, economic feedback, diplomacy, coastal port legality, and arbitrary action batches remain available.

[Official OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning-best-practices) recommends clear goals, direct prompts, and separated input sections.
It also recommends avoiding requests for private step-by-step reasoning.
The [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model) says its family guidance starts from Astra observations and needs evaluation on the chosen model.
These sources support the prompt structure. They do not establish a validated Luna game strategy.
The bounded decision probe uses frozen text snapshots and records public outputs, actions, latency, and usage.
It cannot establish win rate, visual understanding, or improvement across a complete match.

The first probe ran eight turns: two snapshots, two reasoning levels, and old/new prompts.
The old prompt requested five silo levels in every case. The first revision still requested upgrades in three of four cases.
The second revision ran four new-prompt turns with explicit historical-context wording and the new derived missile budget.
It requested zero, zero, one, and zero silo levels. Three decisions avoided further silo expansion.
All four still requested combined quoted spending above current gold. The partial guard rejected one individually unaffordable SAM.
Attack commitments remained uneven. One decision still requested a new City on a recorded upgrade site.
These failures remain in the reports. The follow-up changes both instructions and observations and does not isolate a prompt effect.

`militaryIntel.missileBudget` reports current gold-funded ready shots per weapon independently.
It uses native quoted costs and every ready silo slot, including units beyond the detail limit.
Other spending, target legality, and future cost changes can lower the actual result.
The native tests cover finite gold, ready-slot limits, unfinished silos, disabled weapons, and zero-cost modifiers.

To repeat the local probe, run `tests/agents/strategy-probe.ts --freeze` with `STRATEGY_PROBE_AUDIT` and `STRATEGY_PROBE_ROLLOUT` pointing to the saved evidence.
Then run the script without `--freeze` through `tsx` using the installed authenticated Codex runtime.
`STRATEGY_PROBE_ARMS=new` selects the four-turn follow-up. `STRATEGY_PROBE_REPORT` names its report.
The freeze step saves source hashes, match settings, and exact public inputs in `.agent-arena/strategy-probe/frozen.json`.
This optional probe consumes model usage. The native batch and military tests do not.

Changes require a sidecar reload and new player threads. Existing match threads retain their original instructions.
