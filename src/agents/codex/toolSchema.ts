import { z } from "zod";
import type { GameTool } from "./index";
import { record } from "./protocol";

const inputSchemaRoot = z.object({
  type: z.literal("object"),
  properties: record,
});
const TOOL_SCHEMA_BYTES = 5_000;

/** Reject schemas that Codex can silently replace during native schema compaction. */
export function validateToolSchemas(tools: GameTool[]): void {
  for (const tool of tools) {
    if (!inputSchemaRoot.safeParse(tool.inputSchema).success) {
      throw new Error(
        `Tool ${tool.name} requires a root object with properties.`,
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8");
    if (bytes > TOOL_SCHEMA_BYTES) {
      throw new Error(
        `Tool ${tool.name} exceeds the 5,000-byte schema limit (${bytes} bytes).`,
      );
    }
  }
}
