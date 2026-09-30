import { appendFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentReasoningEffort } from "../types";
import {
  AUTO_COMPACT_TOKEN_LIMIT,
  CONTEXT_WINDOW,
  EFFORT,
  MODEL,
  REASONING_EFFORTS,
  runtimeConfiguration,
  VERSION,
} from "./config";
import {
  record,
  thread,
  threadStart,
  tokenUsage,
  toolCall,
  turnState,
} from "./protocol";
import { CodexTurnError } from "./recovery";
import {
  GameImage,
  gameToolResponse,
  GameToolResult,
  serializeInspectorEvent,
} from "./toolResult";
import { validateToolSchemas } from "./toolSchema";
import { CodexTransport } from "./transport";
import { UsageAccounting } from "./usage";

export type GameTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type PlayerDefinition = {
  id: string;
  reasoningEffort?: AgentReasoningEffort;
  prompt: string;
  tools: GameTool[];
};
export type { GameImage, GameToolResult } from "./toolResult";
type Player = {
  id: string;
  definition: PlayerDefinition;
  retired: boolean;
  reasoningEffort: AgentReasoningEffort;
  tools: Set<string>;
  onTool: (
    name: string,
    args: unknown,
    isActive: () => boolean,
  ) => Promise<GameToolResult>;
  onEvent: (event: Record<string, unknown>) => void;
  log: Promise<void>;
  usage: UsageAccounting;
  hasCompaction: boolean;
  compactionNeedsFlush: boolean;
};
type ActiveTurn = {
  turnId?: string;
  started: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  error?: Record<string, unknown> & { message: string };
};

/** Local game-only Codex sessions. The app-server retains history and performs compaction. */
export class CodexRuntime {
  artifactDirectory = "";
  private transport: CodexTransport;
  private authenticated = false;
  private isolatedHome: string;
  private players = new Map<string, Player>();
  private active = new Map<string, ActiveTurn>();

  async initialize(): Promise<{ authenticated: boolean; models: string[] }> {
    try {
      return await this.connect();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async connect(): Promise<{
    authenticated: boolean;
    models: string[];
  }> {
    if (this.transport)
      throw new Error("Codex runtime is already initialized.");
    const configuration = await runtimeConfiguration();
    this.artifactDirectory = configuration.directory;
    this.isolatedHome = configuration.isolatedHome;
    this.transport = new CodexTransport(
      configuration.command,
      configuration.args,
      configuration.directory,
      configuration.isolatedHome,
      (method, params, id) => this.onMessage(method, params, id),
      (error) => this.fail(error),
    );
    const initialized = z.object({ userAgent: z.string() }).parse(
      await this.transport.request("initialize", {
        clientInfo: { name: "openfront_agents", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
    );
    if (!initialized.userAgent.includes(`/${VERSION}`)) {
      throw new Error(
        `Codex CLI ${VERSION} is required. Found ${initialized.userAgent}.`,
      );
    }
    this.transport.notify("initialized");
    await this.verifyIsolation();
    const account = z
      .object({ account: z.object({ type: z.string() }).nullable() })
      .parse(
        await this.transport.request("account/read", { refreshToken: false }),
      );
    this.authenticated = account.account?.type === "chatgpt";
    const models: string[] = [];
    let cursor: string | null = null;
    do {
      const page = z
        .object({
          data: z.array(
            z.object({
              model: z.string(),
              supportedReasoningEfforts: z.array(
                z.object({ reasoningEffort: z.string() }),
              ),
            }),
          ),
          nextCursor: z.string().nullable(),
        })
        .parse(
          await this.transport.request("model/list", {
            cursor,
            includeHidden: true,
          }),
        );
      models.push(...page.data.map((model) => model.model));
      const selected = page.data.find((model) => model.model === MODEL);
      if (
        selected &&
        !REASONING_EFFORTS.every((effort) =>
          selected.supportedReasoningEfforts.some(
            (level) => level.reasoningEffort === effort,
          ),
        )
      ) {
        throw new Error(
          "gpt-6-luna does not support low and medium reasoning.",
        );
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (!models.includes(MODEL))
      throw new Error("gpt-6-luna is unavailable. Model fallback is disabled.");
    return { authenticated: this.authenticated, models };
  }

  private async verifyIsolation() {
    const [configuration, skills, mcp] = await Promise.all([
      this.transport.request("config/read", {
        includeLayers: false,
        cwd: this.artifactDirectory,
      }),
      this.transport.request("skills/list", {
        cwds: [this.artifactDirectory],
        forceReload: true,
      }),
      this.transport.request("mcpServerStatus/list", {}),
    ]);
    const config = z.object({ config: record }).parse(configuration).config;
    const context = z
      .object({
        model_context_window: z.literal(CONTEXT_WINDOW),
        model_auto_compact_token_limit: z.literal(AUTO_COMPACT_TOKEN_LIMIT),
        model_auto_compact_token_limit_scope: z.literal("total"),
      })
      .parse(config);
    const skillCatalog = z.object({
      data: z.array(
        z.object({
          skills: z.array(
            z.object({
              name: z.string(),
              path: z.string(),
              enabled: z.boolean(),
            }),
          ),
          errors: z.array(record),
        }),
      ),
    });
    let catalog = skillCatalog.parse(skills);
    // Codex can discover ~/.agents skills outside CODEX_HOME. Disable them in this home only.
    for (const entry of catalog.data) {
      for (const skill of entry.skills) {
        if (skill.enabled)
          await this.transport.request("skills/config/write", {
            path: skill.path,
            enabled: false,
          });
      }
    }
    catalog = skillCatalog.parse(
      await this.transport.request("skills/list", {
        cwds: [this.artifactDirectory],
        forceReload: true,
      }),
    );
    const servers = z.object({ data: z.array(record) }).parse(mcp);
    const mcpNames = Object.keys(record.parse(config.mcp_servers ?? {}));
    const pluginNames = Object.keys(record.parse(config.plugins ?? {}));
    if (
      servers.data.length ||
      mcpNames.length ||
      pluginNames.length ||
      catalog.data.some(
        (entry) =>
          entry.skills.some((skill) => skill.enabled) || entry.errors.length,
      )
    ) {
      throw new Error(
        `Codex game isolation failed: ${JSON.stringify({ servers: servers.data.length, mcpNames, pluginNames, skills: catalog.data.map((entry) => entry.skills.map((skill) => skill.name)), skillErrors: catalog.data.map((entry) => entry.errors) })}`,
      );
    }
    await writeFile(
      join(this.artifactDirectory, "isolation.json"),
      JSON.stringify(
        {
          instructionFiles: [],
          skills: [],
          mcpServers: [],
          plugins: [],
          disabledDiscoveredSkills: catalog.data.flatMap((entry) =>
            entry.skills.map((skill) => skill.name),
          ),
          model: MODEL,
          effort: EFFORT,
          supportedReasoningEfforts: REASONING_EFFORTS,
          contextWindow: context.model_context_window,
          autoCompactTokenLimit: context.model_auto_compact_token_limit,
          autoCompactTokenLimitScope:
            context.model_auto_compact_token_limit_scope,
          sandbox: config.sandbox_mode,
          approvalPolicy: config.approval_policy,
          webSearch: config.web_search,
          nativeToolCatalog: "disabled",
          environments: [],
        },
        null,
        2,
      ),
    );
  }

  async createPlayer(
    definition: PlayerDefinition,
    onTool: Player["onTool"],
    onEvent: Player["onEvent"],
  ): Promise<string> {
    validateToolSchemas(definition.tools);
    const reasoningEffort = definition.reasoningEffort ?? EFFORT;
    if (!this.authenticated)
      throw new Error(
        "Log into Codex with ChatGPT before starting game players.",
      );
    if (
      [...this.players.values()].some(
        (player) => player.id === definition.id && !player.retired,
      )
    )
      throw new Error("The player already has a Codex thread.");
    const result = threadStart.parse(
      await this.transport.request("thread/start", {
        model: MODEL,
        modelProvider: "openai",
        allowProviderModelFallback: false,
        cwd: this.artifactDirectory,
        runtimeWorkspaceRoots: [],
        environments: [],
        selectedCapabilityRoots: [],
        approvalPolicy: "never",
        sandbox: "read-only",
        config: {
          model_reasoning_effort: reasoningEffort,
          model_context_window: CONTEXT_WINDOW,
          model_auto_compact_token_limit: AUTO_COMPACT_TOKEN_LIMIT,
          model_auto_compact_token_limit_scope: "total",
        },
        baseInstructions: definition.prompt,
        developerInstructions: "",
        ephemeral: false,
        historyMode: "legacy",
        dynamicTools: definition.tools.map((tool) => ({
          type: "function",
          ...tool,
          deferLoading: false,
        })),
      }),
    );
    if (
      result.model !== MODEL ||
      result.reasoningEffort !== reasoningEffort ||
      result.instructionSources.length ||
      result.sandbox.type !== "readOnly" ||
      result.approvalPolicy !== "never"
    ) {
      throw new Error(
        `Codex did not honor the game thread configuration: ${JSON.stringify({ model: result.model, effort: result.reasoningEffort, sources: result.instructionSources, sandbox: result.sandbox.type, approval: result.approvalPolicy })}`,
      );
    }
    this.players.set(result.thread.id, {
      id: definition.id,
      definition,
      retired: false,
      reasoningEffort,
      tools: new Set(definition.tools.map((tool) => tool.name)),
      onTool,
      onEvent,
      log: Promise.resolve(),
      usage: new UsageAccounting(),
      hasCompaction: false,
      compactionNeedsFlush: false,
    });
    await writeFile(
      join(this.artifactDirectory, `${result.thread.id}.json`),
      JSON.stringify(
        {
          playerId: definition.id,
          threadId: result.thread.id,
          model: MODEL,
          effort: reasoningEffort,
          contextWindow: CONTEXT_WINDOW,
          autoCompactTokenLimit: AUTO_COMPACT_TOKEN_LIMIT,
          autoCompactTokenLimitScope: "total",
          prompt: definition.prompt,
          tools: definition.tools,
        },
        null,
        2,
      ),
    );
    this.emit(result.thread.id, {
      type: "configuration",
      model: result.model,
      effort: result.reasoningEffort,
      contextWindow: CONTEXT_WINDOW,
      autoCompactTokenLimit: AUTO_COMPACT_TOKEN_LIMIT,
      autoCompactTokenLimitScope: "total",
      instructionSources: result.instructionSources,
      sandbox: result.sandbox.type,
      tools: definition.tools.map((tool) => tool.name),
    });
    return result.thread.id;
  }

  /** Replace an exhausted session while retaining its native game seat and artifacts. */
  async replacePlayer(threadId: string): Promise<string> {
    const player = this.player(threadId);
    if (this.active.has(threadId))
      throw new Error("Wait for the active turn before replacing its thread.");
    player.retired = true;
    return this.createPlayer(player.definition, player.onTool, player.onEvent);
  }

  turn(
    threadId: string,
    text: string,
    images: readonly GameImage[] = [],
  ): Promise<void> {
    return this.start(threadId, "turn/start", {
      threadId,
      model: MODEL,
      effort: this.player(threadId).reasoningEffort,
      environments: [],
      input: [
        { type: "text", text, text_elements: [] },
        ...images.map(({ path, detail }) => ({
          type: "localImage",
          path,
          detail: detail ?? "high",
        })),
      ],
    });
  }

  compact(threadId: string): Promise<void> {
    return this.start(threadId, "thread/compact/start", { threadId });
  }

  private start(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (this.player(threadId).retired)
      return Promise.reject(new Error("This Codex game thread has retired."));
    if (this.active.has(threadId))
      return Promise.reject(
        new Error("The Codex thread already has an active turn."),
      );
    return new Promise((resolve, reject) => {
      const active: ActiveTurn = {
        resolve,
        reject,
        started: Promise.resolve(),
      };
      this.active.set(threadId, active);
      active.started = this.transport
        .request(method, params)
        .then((response) => {
          if (method === "turn/start")
            active.turnId = z
              .object({ turn: turnState })
              .parse(response).turn.id;
        })
        .catch((error: unknown) => {
          this.active.delete(threadId);
          reject(error);
        });
    });
  }

  async interrupt(threadId: string): Promise<void> {
    this.player(threadId);
    const active = this.active.get(threadId);
    if (!active) return;
    await active.started;
    if (!this.active.has(threadId)) return;
    if (!active.turnId)
      throw new Error("Codex has not started the compaction turn yet.");
    await this.transport.request("turn/interrupt", {
      threadId,
      turnId: active.turnId,
    });
  }

  async history(
    threadId: string,
    includeTurns = true,
  ): Promise<Record<string, unknown>> {
    this.player(threadId);
    return z
      .object({ thread })
      .parse(
        await this.transport.request("thread/read", { threadId, includeTurns }),
      ).thread;
  }

  async close(): Promise<void> {
    try {
      if (this.transport) await this.transport.close();
      await Promise.all([...this.players.values()].map((player) => player.log));
    } finally {
      if (this.isolatedHome) {
        await unlink(join(this.isolatedHome, "auth.json"));
        this.isolatedHome = "";
      }
    }
  }

  private player(threadId: string): Player {
    const player = this.players.get(threadId);
    if (!player) throw new Error(`Unknown Codex game thread: ${threadId}`);
    return player;
  }

  private fail(error: Error) {
    for (const turn of this.active.values()) turn.reject(error);
    this.active.clear();
    for (const [threadId, player] of this.players) {
      if (!player.retired)
        this.emit(threadId, { type: "runtime_error", message: error.message });
    }
  }

  private emit(threadId: string, event: Record<string, unknown>) {
    const player = this.player(threadId);
    const serialized = serializeInspectorEvent(event);
    player.log = player.log.then(() =>
      appendFile(
        join(this.artifactDirectory, `${threadId}.jsonl`),
        `${serialized}\n`,
      ),
    );
    player.onEvent({ ...record.parse(JSON.parse(serialized)), threadId });
  }

  private async onMessage(
    method: string,
    params: Record<string, unknown>,
    id?: string | number,
  ) {
    if (id !== undefined) {
      if (method !== "item/tool/call") {
        this.transport.reject(
          id,
          `The game runtime does not support ${method}.`,
        );
        return;
      }
      const call = toolCall.parse(params);
      let response: Awaited<ReturnType<typeof gameToolResponse>>;
      try {
        const player = this.players.get(call.threadId);
        const active = this.active.get(call.threadId);
        if (
          !player ||
          player.retired ||
          !active ||
          active.turnId !== call.turnId
        )
          throw new Error("This tool call belongs to an inactive game turn.");
        if (!player.tools.has(call.tool))
          throw new Error(`Unknown game tool: ${call.tool}`);
        response = await gameToolResponse(
          await player.onTool(
            call.tool,
            call.arguments,
            () =>
              !player.retired &&
              this.active.get(call.threadId) === active &&
              active.turnId === call.turnId,
          ),
        );
      } catch (error) {
        response = await gameToolResponse(
          {
            data: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
          false,
        );
      }
      this.transport.respond(id, response);
      return;
    }
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    if (
      !threadId ||
      !this.players.has(threadId) ||
      this.player(threadId).retired
    )
      return;
    this.emit(threadId, { method, params: record.parse(params) });
    if (method === "thread/tokenUsage/updated") {
      const usage = tokenUsage.parse(params).tokenUsage;
      const event = this.player(threadId).usage.update(
        usage.total,
        usage.modelContextWindow,
      );
      if (event) this.emit(threadId, event);
    }
    if (
      method === "item/completed" &&
      record.parse(params.item).type === "contextCompaction"
    ) {
      const player = this.player(threadId);
      player.hasCompaction = true;
      player.compactionNeedsFlush = true;
    }
    if (method === "turn/started") {
      const started = z.object({ turn: turnState }).parse(params).turn;
      const active = this.active.get(threadId);
      if (active) active.turnId = started.id;
    }
    if (method === "error") {
      const failure = z
        .object({ error: z.object({ message: z.string() }).passthrough() })
        .parse(params).error;
      const active = this.active.get(threadId);
      // Provider retries remain part of this turn. Classify only its eventual failed completion.
      if (active) active.error = failure;
    }
    if (method === "turn/completed") {
      const completed = z.object({ turn: turnState }).parse(params).turn;
      const active = this.active.get(threadId);
      if (!active || (active.turnId && active.turnId !== completed.id)) return;
      const player = this.player(threadId);
      if (player.hasCompaction) {
        // Reading native history flushes the compaction checkpoint before the local ledger read.
        const metadata = await this.history(
          threadId,
          player.compactionNeedsFlush,
        );
        const path = z.object({ path: z.string() }).parse(metadata).path;
        this.emit(threadId, await player.usage.reconcile(path, threadId));
        player.compactionNeedsFlush = false;
      }
      this.active.delete(threadId);
      if (completed.status === "failed")
        active.reject(
          new CodexTurnError({
            ...active.error,
            ...completed.error,
            message:
              completed.error?.message ??
              active.error?.message ??
              "Codex turn failed.",
          }),
        );
      else active.resolve();
    }
  }
}
