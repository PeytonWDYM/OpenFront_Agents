import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";

export const MODEL = "gpt-6-luna";
export const EFFORT = "low";
export const REASONING_EFFORTS = ["low", "medium"] as const;
export const VERSION = "0.158.0";
export const CONTEXT_WINDOW = 272_000;
// Leave 38,400 tokens below Luna's 95% usable window for the next turn and compaction.
export const AUTO_COMPACT_TOKEN_LIMIT = 220_000;

const cachedModel = z
  .object({
    slug: z.string(),
    supported_reasoning_levels: z.array(
      z.object({ effort: z.string(), description: z.string() }),
    ),
    context_window: z.number().positive(),
    input_modalities: z.array(z.string()),
  })
  .passthrough();

/** Resolve the npm wrapper through Node so Windows does not launch a shell. */
async function executable(): Promise<{ command: string; args: string[] }> {
  if (process.env.OPENFRONT_CODEX_EXECUTABLE) {
    return { command: process.env.OPENFRONT_CODEX_EXECUTABLE, args: [] };
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const wrapper = join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    try {
      await access(wrapper);
      return { command: process.execPath, args: [wrapper] };
    } catch {
      // PATH contains directories for many programs, not just the npm wrapper.
    }
  }
  if (process.platform !== "win32") return { command: "codex", args: [] };
  throw new Error(
    "Codex npm wrapper is missing from PATH. Install Codex CLI 0.158.0.",
  );
}

export async function runtimeConfiguration() {
  const directory = await mkdtemp(join(tmpdir(), "openfront-codex-"));
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const isolatedHome = join(directory, "home");
  await mkdir(isolatedHome);
  const catalog = z
    .object({ models: z.array(cachedModel) })
    .parse(
      JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8")),
    );
  const model = catalog.models.find((entry) => entry.slug === MODEL);
  if (
    !model ||
    !REASONING_EFFORTS.every((effort) =>
      model.supported_reasoning_levels.some((level) => level.effort === effort),
    )
  ) {
    throw new Error(
      "The Codex model catalog must contain gpt-6-luna with low and medium reasoning. Open Codex to refresh it.",
    );
  }
  if (!model.input_modalities.includes("image")) {
    throw new Error(
      "gpt-6-luna does not support map images. Text-only fallback is disabled.",
    );
  }
  const modelCatalog = join(directory, "models.json");
  await writeFile(
    modelCatalog,
    JSON.stringify({
      models: [
        {
          ...model,
          shell_type: "disabled",
          apply_patch_tool_type: null,
          experimental_supported_tools: [],
          tool_mode: "direct",
          multi_agent_version: null,
          model_messages: null,
          base_instructions: "You are an OpenFront game player.",
          include_skills_usage_instructions: false,
          include_plugin_usage_instructions: false,
          include_apps_usage_instructions: false,
        },
      ],
    }),
  );
  const options: Record<string, string> = {
    model: JSON.stringify(MODEL),
    model_reasoning_effort: JSON.stringify(EFFORT),
    model_context_window: String(CONTEXT_WINDOW),
    model_auto_compact_token_limit: String(AUTO_COMPACT_TOKEN_LIMIT),
    model_auto_compact_token_limit_scope: '"total"',
    model_catalog_json: JSON.stringify(modelCatalog),
    approval_policy: '"never"',
    sandbox_mode: '"read-only"',
    web_search: '"disabled"',
    project_doc_max_bytes: "0",
    developer_instructions: '""',
    include_environment_context: "false",
    include_permissions_instructions: "false",
    include_apps_instructions: "false",
    include_collaboration_mode_instructions: "false",
    cli_auth_credentials_store: '"file"',
    forced_login_method: '"chatgpt"',
    notify: "[]",
    "orchestrator.mcp.enabled": "false",
    "cloud.skills.enabled": "false",
    "skills.include_instructions": "false",
    "skills.bundled.enabled": "false",
    "tools.update_plan.enabled": "false",
    "tools.experimental_request_user_input.enabled": "false",
    "features.skip_host_skill_discovery": "true",
  };
  for (const feature of [
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "shell_tool",
    "view_image",
    "multi_agent",
    "multi_agent_v2",
    "goals",
    "hooks",
    "memories",
    "chronicle",
    "code_mode",
    "code_mode_host",
    "skill_search",
    "tool_suggest",
    "sleep_tool",
    "token_budget",
    "request_permissions_tool",
    "send_message_to_user_async",
    "current_time_reminder",
    "workspace_dependencies",
    "realtime_conversation",
    "deferred_executor",
  ])
    options[`features.${feature}`] = "false";
  const launch = await executable();
  // Copy the existing credential file without reading its contents.
  // Codex remains responsible for authentication and token refresh.
  await copyFile(join(codexHome, "auth.json"), join(isolatedHome, "auth.json"));
  return {
    directory,
    isolatedHome,
    command: launch.command,
    args: [
      ...launch.args,
      "app-server",
      "--stdio",
      ...Object.entries(options).flatMap(([key, value]) => [
        "-c",
        `${key}=${value}`,
      ]),
    ],
  };
}
