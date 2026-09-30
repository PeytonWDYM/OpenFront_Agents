# Agent efficiency and spectator review

The agent harness keeps game strategy with each player. It uses native actions, costs, placement checks, and cooldowns.
The first pass used Luna on low reasoning. The follow-up supports a low/medium comparison.

## First-pass findings and changes

| Finding                                                                               | Change                                                                                                                               | Verification                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Long histories repeat old observations and images during each inference.              | Keep the same thread, but configure native compaction at 24,000 tokens instead of 150,000. Resend the latest explicit strategy note. | Native configuration and memory probes.                                                 |
| Every turn attached both the world map and a tactical crop.                           | Send the tactical crop each turn. Include the overview initially, then at 60-second intervals, or on request.                        | Native simulation reports image counts and request sizes.                               |
| The prompt repeated mechanics and strategy advice.                                    | Shorten the prompt and explain bulk actions without a required attack or build order.                                                | Prompt source is about 54% smaller.                                                     |
| Construction required extra decisions because of harness action limits.               | Remove action-count, tool-call, and building-count limits. Support native bulk upgrades and batches.                                 | Five Ports complete from one batch. One Port gains five levels from one upgrade action. |
| A normal observation supplied only one fresh site per building type.                  | Add an optional building-type query for multiple spaced native sites, with a truncation flag.                                        | Native construction test checks sites, spacing, and region filters.                     |
| Crowded maps and low-detail inputs made labels hard to read.                          | Use high-detail decision images, shorter labels, selectable overlays, and exact public marker data.                                  | Saved PNGs and native vision tests.                                                     |
| Raw runtime notifications overwhelmed the transcript and moved the reader's position. | Default to decisions, actions, and errors. Preserve row identity and scroll position. Follow new entries only at the bottom.         | Browser assertions and a screenshot.                                                    |

## Economic feedback follow-up

The follow-up raises the compaction threshold to 60,000 tokens and retains the 150,000-token context window.
Each agent can use low or medium reasoning. Native player names and inspector headers show the assigned level.

Each decision receives the previous final summary and native outcome changes. The summary preserves intent without another model call.
Feedback separates net resources from gross income, troop commitments, observed construction, and lost trade ships.
It does not infer combat losses from net troop changes. Inspector reads do not consume decision feedback.

The prompt explains automatic factory links and higher payments at allied train stops.
Agents choose alliances, investments, actions, and decision delays. The repeated aggression instruction has been removed.

Self-owned nuclear destinations are rejected. Blast previews list own and friendly structures at risk using the native destruction radius.
Map images appear in the default transcript. Reserved frames prevent image loading from changing scroll position.

Focused native checks cover reasoning configuration, economic outcomes, trade captures, and nuclear targeting.
The browser check covers visible images, delayed loads, and scroll behavior. These checks do not establish full-game strategy quality or token savings.

## Evidence

Repeatable tests write local evidence under `.agent-arena/`:

- `batch-e2e.json`: native construction, upgrades, partial failures, and action schema size.
- `construction-e2e.json`: optional multiple-site query and regional results.
- `efficiency-report.json`: a Europe simulation with 100 tribes and 13 nations, current observations, image cadence, and saved strategy.
- `verification/transcript-ui/result.json` and `transcript.png`: transcript behavior and appearance.

`context-e2e.ts` verifies the installed Codex runtime configuration without inference.
`runtime-memory-e2e.ts` uses inference and manual compaction to verify that the same thread retains a chosen plan.
Its report stays in the isolated runtime directory printed by the command.

The efficiency fixture sends about 5 KB of text on routine tactical turns and about 7.7 KB with an overview refresh.
Routine turns attach one image instead of two.
These are payload measurements, not a measured reduction in billed tokens or full-game usage.
The native memory probe verifies manual compaction. It does not fill a game thread to the automatic threshold.

## Practical limits

A model still chooses its strategy. Better action access and shorter turns do not guarantee aggression or a shorter match.
Higher image detail costs more per image, but preserves small labels. Earlier compaction trades occasional summary requests for less repeated history.
The usage display separates cached input from uncached input. Total tokens alone do not describe the cost of a match.
Native game state can change between observation and action. A submission acknowledgment is not proof that construction or an attack executed.
