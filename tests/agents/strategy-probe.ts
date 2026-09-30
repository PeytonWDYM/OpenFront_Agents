import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ModuleKind, transpileModule } from "typescript";
import { z } from "zod";
import {
  ObserveWorldQuerySchema,
  ThinkQuerySchema,
} from "../../src/agents/Arena";
import { MODEL } from "../../src/agents/codex/config";
import { CodexRuntime, type GameTool } from "../../src/agents/codex/index";
import { submitActions } from "../../src/agents/game/actionBatch";
import {
  agentActionToolSchema,
  AgentToolInputSchema,
} from "../../src/agents/game/schemas";
import { playerPrompt } from "../../src/agents/PlayerPrompt";

// Failure cases: changing observations, live submissions, invented preview safety,
// missing recorded inputs, leaked reasoning, unbounded turns, and missing evidence.
// Freeze before editing prompts. Run only after both prompt arms exist.
const record = z.record(z.string(), z.unknown());
const auditPath = process.env.STRATEGY_PROBE_AUDIT;
const rolloutPath = process.env.STRATEGY_PROBE_ROLLOUT;
const directory = resolve(".agent-arena/strategy-probe");
const fixturePath = resolve(directory, "frozen.json");
const reportName = z
  .string()
  .regex(/^[\w-]+\.json$/)
  .parse(process.env.STRATEGY_PROBE_REPORT ?? "report.json");
const reportPath = resolve(directory, reportName);
const arms = process.env.STRATEGY_PROBE_ARMS
  ? z
      .array(z.enum(["old", "new"]))
      .min(1)
      .max(2)
      .parse(process.env.STRATEGY_PROBE_ARMS.split(","))
  : (["old", "new"] as const);
const includeMissileBudget = process.env.STRATEGY_PROBE_MISSILE_BUDGET === "1";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const schemas = {
  observe_world: z.toJSONSchema(ObserveWorldQuerySchema),
  think: z.toJSONSchema(ThinkQuerySchema),
  act: agentActionToolSchema,
};
const worldSchema = z
  .object({
    tick: z.number(),
    self: z
      .object({ troops: z.number(), gold: z.number(), attackRatio: z.number() })
      .passthrough(),
    buildCosts: z.array(z.object({ type: z.string(), cost: z.number() })),
  })
  .passthrough();
const fixtureSchema = z.object({
  sources: record,
  settings: z.string(),
  baseline: z.object({
    prompt: z.string(),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: record,
      }),
    ),
  }),
  scenarios: z.array(
    z.object({
      decision: z.number(),
      input: z.string(),
      history: z.array(record),
    }),
  ),
});

function descriptions(source: string): GameTool[] {
  return Object.entries(schemas).map(([name, inputSchema]) => {
    const match = source.match(
      new RegExp(`name: "${name}",\\s+description:\\s+"([^"]+)"`),
    );
    assert(match, `Missing Arena description for ${name}`);
    return { name, description: match[1], inputSchema };
  });
}

async function freeze() {
  assert(
    auditPath && rolloutPath,
    "Set STRATEGY_PROBE_AUDIT and STRATEGY_PROBE_ROLLOUT for --freeze.",
  );
  assert(
    (await stat(rolloutPath)).size < 32 * 1024 * 1024,
    "Recorded rollout exceeds the bounded read limit.",
  );
  const auditText = await readFile(auditPath, "utf8");
  const audit = z
    .object({ rows: z.array(record) })
    .parse(JSON.parse(auditText));
  const source = execFileSync(
    "git",
    ["show", "origin/main:src/agents/PlayerPrompt.ts"],
    { encoding: "utf8" },
  );
  const arenaSource = execFileSync(
    "git",
    ["show", "origin/main:src/agents/Arena.ts"],
    { encoding: "utf8" },
  );
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext },
  }).outputText;
  const baselineModule: { playerPrompt: (name: string) => string } =
    await import(
      `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
    );
  const entries = (await readFile(rolloutPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      z.object({ type: z.string(), payload: record }).parse(JSON.parse(line)),
    );
  const userMessages = entries
    .filter(
      (entry) =>
        entry.type === "response_item" &&
        entry.payload.type === "message" &&
        entry.payload.role === "user",
    )
    .map((entry) => {
      const message = z
        .object({
          content: z.array(
            z
              .object({ type: z.string(), text: z.string().optional() })
              .passthrough(),
          ),
        })
        .parse(entry.payload);
      return message.content
        .filter(
          (item) =>
            item.type === "input_text" &&
            item.text?.startsWith("Current game state"),
        )
        .map((item) => item.text!);
    })
    .flat();
  const session = entries.find((entry) => entry.type === "session_meta");
  assert(session, "Missing recorded session metadata.");
  const threadId = z.object({ id: z.string() }).parse(session.payload).id;
  const configPath = resolve(
    dirname(rolloutPath),
    "../../../../../",
    `${threadId}.json`,
  );
  const nativeConfig = z
    .object({ prompt: z.string() })
    .parse(JSON.parse(await readFile(configPath, "utf8")));
  const settings = nativeConfig.prompt.slice(
    0,
    nativeConfig.prompt.indexOf("You are "),
  );
  assert(
    settings.startsWith("MATCH SETTINGS"),
    "Missing recorded match settings.",
  );
  const scenarios = [32, 43].map((decision) => {
    const row = audit.rows.find((item) => item.decision === decision);
    assert(row, `Missing audit decision ${decision}`);
    const input = userMessages.find(
      (text) =>
        z
          .object({ tick: z.number() })
          .parse(JSON.parse(text.slice(text.indexOf("{")))).tick === row.tick,
    );
    assert(input, `Missing recorded user input for decision ${decision}`);
    const world = worldSchema.parse(
      JSON.parse(input.slice(input.indexOf("{"))),
    );
    assert.equal(world.self.gold, row.gold);
    const history = audit.rows
      .filter(
        (item) =>
          typeof item.decision === "number" &&
          item.decision >= decision - 3 &&
          item.decision < decision,
      )
      .map((item) => ({
        decision: item.decision,
        tick: item.tick,
        feedback: item.feedback,
        submittedToolCalls: item.toolCalls,
        publicSummary: item.summary,
      }));
    return { decision, input, history };
  });
  await mkdir(directory, { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        sources: {
          auditPath,
          auditSha256: digest(auditText),
          rolloutPath,
          baselineRef: execFileSync("git", ["rev-parse", "origin/main"], {
            encoding: "utf8",
          }).trim(),
          baselineSourceSha256: digest(source),
        },
        settings,
        baseline: {
          prompt: baselineModule.playerPrompt("Agent 17 - medium"),
          tools: descriptions(arenaSource),
        },
        scenarios,
      },
      null,
      2,
    ),
  );
  console.log(
    `Frozen two public scenarios and origin/main prompt: ${fixturePath}`,
  );
}

async function run() {
  const fixture = fixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  );
  const current = {
    prompt: playerPrompt("Agent 17 - medium"),
    tools: descriptions(await readFile("src/agents/Arena.ts", "utf8")),
  };
  assert.notEqual(
    current.prompt,
    fixture.baseline.prompt,
    "Apply the new prompt before running A/B.",
  );
  const results: Record<string, unknown>[] = [];
  const settingsLine = fixture.settings.split("\n")[1];
  const { disabledUnits } = z
    .object({ disabledUnits: z.array(z.string()) })
    .parse(JSON.parse(settingsLine.slice(settingsLine.indexOf("{"))));
  const scenarios = fixture.scenarios.map((scenario) => {
    if (!includeMissileBudget) return scenario;
    const start = scenario.input.indexOf("{");
    const world = worldSchema.parse(JSON.parse(scenario.input.slice(start)));
    const militaryIntel = record.parse(world.militaryIntel);
    const { readySlots } = z
      .object({ readySlots: z.number() })
      .parse(militaryIntel.siloReadiness);
    militaryIntel.missileBudget = {
      basis:
        "Upper bounds from current gold and ready slots, per weapon independently. No other spending or target legality included.",
      options: world.buildCosts
        .filter(
          ({ type }) =>
            ["Atom Bomb", "Hydrogen Bomb", "MIRV"].includes(type) &&
            !disabledUnits.includes(type),
        )
        .map(({ type, cost }) => ({
          type,
          cost,
          fundedReadyShots:
            cost === 0
              ? readySlots
              : Math.min(readySlots, Math.floor(world.self.gold / cost)),
        })),
    };
    const input =
      scenario.input.slice(0, start) +
      JSON.stringify({ ...world, militaryIntel });
    return { ...scenario, input };
  });
  const report = {
    startedAt: new Date().toISOString(),
    error: undefined as string | undefined,
    model: MODEL,
    timeoutMs: 90_000,
    sources: fixture.sources,
    promptSha256: {
      old: digest(fixture.baseline.prompt),
      new: digest(current.prompt),
    },
    arms,
    scenarios: fixture.scenarios,
    decisionInputs: scenarios.map(({ decision, input }) => ({
      decision,
      input,
      sha256: digest(input),
    })),
    inputAugmentation: includeMissileBudget
      ? "Derived militaryIntel.missileBudget from recorded current gold, costs, disabledUnits, and siloReadiness.readySlots. Formula per type: min(readySlots,floor(gold/cost)); zero cost uses readySlots; disabled types omitted. Field matches native militaryIntel.ts. Revised prompt and datum are combined, not an isolated prompt comparison."
      : "None",
    prompts: { old: fixture.baseline, new: current },
    settings: fixture.settings,
    limitations:
      "Four single-turn text-only decisions per arm. Three prior public submissions/summaries supply abbreviated history. Images, terrain details, nuclear previews, and unseen observations are unavailable. Frozen actions validate native schema and individual quoted affordability only. Combined budgets, placement, target legality, and native execution are not simulated. Known individually unaffordable actions are rejected. Accepted requests are capture-only pending submissions, not verified native legality. No outcome scoring, full match, win-rate claim, or private reasoning appears in this report. Costs are quoted observations, not guaranteed charge totals. One sample per arm/effort/scenario cannot establish statistical improvement.",
    results,
  };
  const runtime = new CodexRuntime();
  try {
    const initialized = await runtime.initialize();
    assert(
      initialized.authenticated,
      "Native Codex authentication is unavailable.",
    );
    for (const scenario of scenarios)
      for (const effort of ["low", "medium"] as const)
        for (const arm of arms) {
          const world = worldSchema.parse(
            JSON.parse(scenario.input.slice(scenario.input.indexOf("{"))),
          );
          const calls: Record<string, unknown>[] = [];
          const actions: Record<string, unknown>[] = [];
          const notes: string[] = [];
          const finals: string[] = [];
          let usage: Record<string, unknown> = {};
          let ratio = world.self.attackRatio;
          let timedOut = false;
          const unavailable =
            "This frozen text-only probe has no images, terrain detail, new regions, leaderboard expansion, build-site search, or nuclear preview. Risk is unknown. No action executes.";
          const observe = (args: unknown) => {
            const query = ObserveWorldQuerySchema.parse(args);
            calls.push({ tool: "observe_world", arguments: query });
            return { ...world, frozenProbe: true, unavailable };
          };
          const started = Date.now();
          const thread = await runtime.createPlayer(
            {
              id: `${scenario.decision}-${effort}-${arm}`,
              reasoningEffort: effort,
              prompt: fixture.settings + report.prompts[arm].prompt,
              tools: report.prompts[arm].tools,
            },
            async (name, args) => {
              if (name === "observe_world") return { data: observe(args) };
              if (name === "think") {
                const query = ThinkQuerySchema.parse(args);
                calls.push({ tool: name, arguments: query });
                notes.push(query.note);
                return {
                  data: query.observe
                    ? observe(query.observe)
                    : { recorded: true },
                };
              }
              assert.equal(name, "act");
              const request = AgentToolInputSchema.parse(args);
              const call = {
                tool: name,
                arguments: request,
                result: undefined as unknown,
              };
              calls.push(call);
              const result = await submitActions(
                request,
                async (intent, attackRatio) => {
                  const requestedRatio = attackRatio ?? ratio;
                  const army =
                    intent.type === "attack" || intent.type === "boat";
                  const cost =
                    intent.type === "build_unit" ||
                    intent.type === "upgrade_structure"
                      ? world.buildCosts.find(
                          (entry) => entry.type === intent.unit,
                        )?.cost
                      : undefined;
                  actions.push({
                    intent,
                    persistentAttackRatio: requestedRatio,
                    accepted: cost === undefined || cost <= world.self.gold,
                    status:
                      cost !== undefined && cost > world.self.gold
                        ? "rejected"
                        : "submitted",
                    validation:
                      "Schema and individual quoted affordability only. Other native legality is unknown.",
                    ...(army
                      ? {
                          requestedTroops:
                            attackRatio !== undefined || intent.troops === null
                              ? Math.floor(world.self.troops * requestedRatio)
                              : intent.troops,
                        }
                      : {}),
                    ...(cost !== undefined
                      ? {
                          quotedUnitCost: cost,
                          quotedBaseCostProduct:
                            cost *
                            (intent.type === "upgrade_structure"
                              ? (intent.amount ?? 1)
                              : 1),
                        }
                      : {}),
                  });
                  if (cost !== undefined && cost > world.self.gold)
                    throw new Error(
                      `Insufficient gold. Required: ${cost}. Available: ${world.self.gold}. Other native legality is unavailable in this frozen probe.`,
                    );
                  ratio = requestedRatio;
                  return {
                    accepted: true,
                    status: "submitted",
                    execution: "pending execution",
                    tick: world.tick,
                    attackRatio: ratio,
                    intent,
                  };
                },
                () => {},
              );
              call.result = result;
              return {
                data: {
                  ...result,
                  frozenProbe: true,
                  validation:
                    "Native schema and individual quoted affordability only. Full native legality and execution are unavailable.",
                },
              };
            },
            (event) => {
              if (event.type === "tokens") usage = event;
              if (event.method !== "item/completed") return;
              const params = record.parse(event.params);
              const item = record.parse(params.item);
              if (item.type === "agentMessage" && typeof item.text === "string")
                finals.push(item.text);
            },
          );
          let error: string | undefined;
          const timeout = setTimeout(() => {
            timedOut = true;
            void runtime.interrupt(thread).catch(() => {});
          }, 90_000);
          try {
            await runtime.turn(
              thread,
              `Frozen public history: ${JSON.stringify(scenario.history)}\n${scenario.input}\nProbe conditions: ${unavailable}`,
            );
          } catch (failure) {
            error =
              failure instanceof Error ? failure.message : String(failure);
          } finally {
            clearTimeout(timeout);
          }
          results.push({
            decision: scenario.decision,
            effort,
            arm,
            latencyMs: Date.now() - started,
            timedOut,
            error,
            calls,
            actions,
            notes,
            finals,
            usage,
          });
          await writeFile(reportPath, JSON.stringify(report, null, 2));
          console.log(
            JSON.stringify({
              decision: scenario.decision,
              effort,
              arm,
              actions: actions.length,
              latencyMs: Date.now() - started,
              timedOut,
              error,
            }),
          );
          if (error || timedOut)
            throw new Error(
              "The bounded probe stopped after a failed or timed-out turn. Partial report saved.",
            );
        }
  } catch (failure) {
    report.error = failure instanceof Error ? failure.message : String(failure);
    throw failure;
  } finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await runtime.close();
  }
  console.log(`Observable A/B report: ${reportPath}`);
}

if (process.argv.includes("--freeze")) await freeze();
else await run();
