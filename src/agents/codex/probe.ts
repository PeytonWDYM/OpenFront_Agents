import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexRuntime } from "./index";

// The default probe creates a thread without requesting model inference.
const runtime = new CodexRuntime();
const events: Record<string, unknown>[] = [];
let toolCalls = 0;
try {
  const status = await runtime.initialize();
  assert.equal(status.authenticated, true, "Codex requires ChatGPT login");
  assert(
    status.models.includes("gpt-6-luna"),
    "The required model is unavailable",
  );
  await assert.rejects(
    runtime.createPlayer(
      {
        id: "invalid-root-probe",
        prompt: "Verify tool schema validation.",
        tools: [
          {
            name: "invalid_root",
            description: "Unsupported root union.",
            inputSchema: {
              oneOf: [{ type: "object", properties: {} }],
            },
          },
        ],
      },
      async () => null,
      () => {},
    ),
    /root object/,
  );
  await assert.rejects(
    runtime.createPlayer(
      {
        id: "oversized-schema-probe",
        prompt: "Verify tool schema validation.",
        tools: [
          {
            name: "oversized_schema",
            description: "Unsupported oversized schema.",
            inputSchema: {
              type: "object",
              properties: {
                text: { type: "string", description: "x".repeat(5_001) },
              },
            },
          },
        ],
      },
      async () => null,
      () => {},
    ),
    /5,000-byte/,
  );
  const threadId = await runtime.createPlayer(
    {
      id: "contract-probe",
      prompt:
        "You are an OpenFront game player. Use only the game tools. When asked to verify the connection, call game_probe once and report its result.",
      tools: [
        {
          name: "game_probe",
          description: "Verify the game connection.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
    async (name) => {
      assert.equal(name, "game_probe");
      toolCalls++;
      return { connected: true };
    },
    (event) => events.push(event),
  );
  const history = await runtime.history(threadId, false);
  assert.equal(history.id, threadId);
  const configuration = events.find((event) => event.type === "configuration");
  assert(configuration, "Missing verified thread configuration");
  assert.equal(configuration.model, "gpt-6-luna");
  assert.equal(configuration.effort, "low");
  assert.deepEqual(configuration.instructionSources, []);
  if (process.argv.includes("--turn")) {
    await runtime.turn(threadId, "Verify the connection now.");
    assert.equal(toolCalls, 1);
    assert(events.some((event) => event.type === "tokens"));
  } else {
    assert.equal(toolCalls, 0);
  }
  const artifact = {
    status,
    schemaChecks: { rootUnionRejected: true, oversizedRejected: true },
    threadId,
    configuration,
    toolCalls,
    events,
  };
  await mkdir(runtime.artifactDirectory, { recursive: true });
  const path = join(runtime.artifactDirectory, "probe.json");
  await writeFile(path, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ passed: true, artifact: path, threadId }));
} finally {
  await runtime.close();
}
