# Local Codex runtime

The runtime uses Codex CLI 0.158.0 and the existing ChatGPT login. It does not parse credentials or use an API key.

Each runtime creates an empty work directory and Codex home outside the repository.
It copies the existing `auth.json` with `copyFile()`. Codex handles authentication and token refresh in that copy.
The runtime removes its copied credential file when it closes. It preserves game logs and native thread history.
It does not change the user's Codex configuration or login file.

The installed npm wrapper runs through Node. Windows does not launch a shell.
Set `OPENFRONT_CODEX_EXECUTABLE` to use an explicit Codex binary path.
The required version remains 0.158.0.

## Player sessions

`CodexRuntime` exports these operations:

| Operation                                   | Result                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `initialize()`                              | Checks ChatGPT authentication, model availability, and runtime isolation.   |
| `createPlayer(definition, onTool, onEvent)` | Creates one durable thread for a player.                                    |
| `turn(threadId, text)`                      | Resolves after completion or interruption. Rejects failed turns.            |
| `compact(threadId)`                         | Runs native Codex compaction and waits for completion.                      |
| `interrupt(threadId)`                       | Interrupts the active turn.                                                 |
| `history(threadId, includeTurns)`           | Reads native thread history.                                                |
| `close()`                                   | Closes the process, saves pending logs, and removes the copied credentials. |

Every player uses `gpt-6-luna` with `low` reasoning. The runtime disables provider model fallback.
An unavailable model causes an error. The runtime does not substitute another model.
A player retains the same thread across game decisions. Concurrent turns on that thread cause an error.

Full history requires at least one user message. Before that message, use `history(threadId, false)` for thread metadata.
Native Codex stores persistent sessions in the isolated home. The adapter does not replace native history with a summary buffer.
Native automatic compaction retains the model's context limits. Manual compaction uses `thread/compact/start`.

## Prompt and tool isolation

The player prompt goes into `thread/start.baseInstructions`. Codex treats this field as the base instruction override.
It replaces the default coder prompt. It does not grant permission to bypass model safety controls.
The thread uses empty developer instructions, no environments, no capability roots, and a read-only sandbox.
The runtime disables permission, app, collaboration, environment, and skill instruction blocks.
The thread response must confirm `gpt-6-luna`, `low`, `readOnly`, `never`, and an empty instruction source list.

The local model catalog supplies game-only tool declarations.
The runtime copies model metadata from the existing catalog and keeps its context limits.
It removes native shell, patch, clock, user-message, code mode, and multi-agent declarations.
This uses Codex's supported `model_catalog_json` setting. It does not change the remote model or provider.
All player tools use app-server `dynamicTools` with direct function exposure.
Tool arguments arrive as `unknown`. The game bridge must validate arguments against its game contracts.
Unknown tools and callback errors return failed tool results.
The adapter requires object input schemas and rejects schemas above 5,000 UTF-8 bytes before creating a thread.
This prevents Codex's tool schema compactor from silently removing the native action fields.
The exposed action schema stays below that limit. The bridge retains full native validation.

Tool input schemas need a root object with named properties.
Codex normalizes each dynamic tool schema against a 5,000-byte budget.
An oversized schema can lose definitions, nested objects, and unions before the model receives it.
The runtime rejects root unions and schemas larger than 5,000 serialized UTF-8 bytes before creating a thread.
This conservative check prevents lossy schema compaction. A wrapper cannot protect an oversized nested union.
This limit comes from the versioned [tool schema compactor](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/tools/src/json_schema/compaction.rs).

An empty Codex home prevents user plugins, MCP servers, hooks, and global `AGENTS.md` from loading.
Codex can still discover skills in `~/.agents`. The runtime disables each discovered skill in its own home.
It checks the skill catalog, MCP status, and configuration before creating players.

These decisions follow the versioned [thread processor](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/src/request_processors/thread_processor.rs),
[tool builder](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/core/src/tools/spec_plan.rs),
and [configuration schema](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/config/src/config_toml.rs).

## Events and artifacts

`onEvent` receives protocol notifications as `{ method, params }`.
It also receives a `configuration` event and cumulative token events:

```ts
{
  type: "tokens",
  totalTokens,
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  outputTokens,
  reasoningOutputTokens,
  contextWindow,
}
```

Input tokens include cached input tokens. The runtime reports Codex's totals without adding those fields together.
Codex 0.158.0 omits remote compaction usage from its legacy RPC totals.
After compaction, the runtime reads validated cumulative usage from the native rollout before each turn resolves.
It stops publishing provisional RPC totals for that thread. This prevents a later RPC correction from counting compaction twice.
Manual and automatic compaction use the same accounting path. Missing or invalid native usage records cause a runtime error.
Codex 0.158.0 exposes no per-response output token limit through this protocol.
A caller can interrupt at its token budget. Usage notifications can arrive after a response exceeds that budget.

`artifactDirectory` contains `isolation.json`, a JSON definition for each thread, and per-thread JSONL events.
The native session files remain under its `home` directory. The credential copy does not remain after `close()`.
The runtime drains stderr without copying it into game logs because diagnostics can include account details.

## Contract probe failure cases

Write and inspect these checks before runtime implementation:

- Codex is missing, or its version differs from the verified protocol.
- The account lacks ChatGPT authentication.
- The catalog lacks `gpt-6-luna` or its `low` reasoning option.
- Codex substitutes another model or reasoning effort.
- A thread loads repository or global instructions, skills, plugins, MCP servers, or native tools.
- A root union or oversized tool schema reaches thread creation.
- A tool call uses an unknown tool or invalid arguments.
- A failed turn resolves successfully, or an interrupted turn remains pending.
- The process exits while a request or turn remains pending.
- Token usage or durable history cannot be read.
- Compaction usage does not enter the cumulative budget.
- Repeated compaction notifications count the same usage twice.
- Later RPC token updates omit or duplicate a prior compaction.
- Native usage records contain invalid numeric values or refer to another thread.
- The runtime logs credentials or changes the user's Codex configuration.

Run `node node_modules/tsx/dist/cli.mjs src/agents/codex/probe.ts` for the initialization and thread configuration probe.
The default probe makes no inference request. Add `--turn` only for an authorized inference smoke check.
The probe writes a JSON artifact outside the repository.
