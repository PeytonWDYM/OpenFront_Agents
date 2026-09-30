# Agent strategy reference

The spawn briefing explains options and tradeoffs. It does not select actions, set a build order, or run a native bot policy.
The current engine remains the source for mechanics. The model chooses its targets, spending, diplomacy, and timing.

The September 28, 2026 review checked the [official help](https://openfront.io/) and the community [Combat](https://openfront.wiki/Combat/),
[Warship](https://openfront.wiki/Warship/), and [MIRV](https://openfront.wiki/MIRV/) references against this checkout.
Community formulas can describe older releases. The briefing uses this fork's current v34 combat behavior.

The review found [Ultimus Rex's recent MIRV game](https://www.youtube.com/watch?v=8gIyEb5hSBw),
[his recent Warship game](https://www.youtube.com/watch?v=zfQXh3AWwL0), and [Biffeur's diplomacy game](https://www.youtube.com/watch?v=gostZlou3FM).
Biffeur's current channel is TheBiff. These videos had no available transcripts during the review.
The briefing does not quote their commentary or claim that video titles establish a strategy.

The briefing asks agents to compare immediate threats, territory gains, investment, naval access, and victory progress.
It explains how dense defenders and small attack stacks can cause expensive stalled fronts.
It presents MIRVs as an option against dispersed territory and rising leaders, with affordability, SAMs, and alternative spending as tradeoffs.
It explains that Warships can patrol public trade routes, protect landings, and move away from their launch Ports.
Agents can save for a specific weapon. The briefing asks them to reconsider the purchase once they can afford it.

Native references:

- `src/core/configuration/Config.ts`: combat ratios, troop growth, prices, victory threshold, and overtime.
- `src/core/execution/WinCheckExecution.ts`: non-fallout land, team ownership, and timers.
- `src/core/execution/MIRVExecution.ts`: enemy-tile owner selection and dispersed warhead targets.
- `src/core/execution/NukeExecution.ts`: impacts, collateral effects, and interception.
- `src/core/execution/WarshipExecution.ts`: patrol, targets, repairs, and piracy conditions.
- `src/core/execution/TradeShipExecution.ts`: captured-trade payouts at arrival.
- `src/core/game/GameImpl.ts`: native conquest rewards.
- `src/client/hud/layers/lib/StatsColumns.ts`: public leaderboard columns.

`think` records a short strategy note. An optional observation request uses the same public and private filters as `observe_world`.
The tool does not change Luna's Low reasoning setting or add model turns by itself.
It has no fixed call allowance. Simple decisions can submit actions directly.
