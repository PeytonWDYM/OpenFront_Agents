import { readFile } from "node:fs/promises";

export type GameImage = { path: string; detail?: "low" | "high" | "auto" };
export type GameToolResult = { data: unknown; images?: readonly GameImage[] };
type ToolContent =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

/** Omit image data from inspector copies without changing native events or history. */
export function serializeInspectorEvent(
  event: Record<string, unknown>,
): string {
  return JSON.stringify(event, (_key: string, value: unknown) =>
    typeof value === "string" && /^data:image\/[^,\s]+,/i.test(value)
      ? "[image omitted from inspector event]"
      : value,
  );
}

/** Native dynamic tools accept PNG data URLs beside their JSON result. */
export async function gameToolResponse(
  result: GameToolResult,
  success = true,
): Promise<{
  success: boolean;
  contentItems: ToolContent[];
}> {
  const images = await Promise.all(
    (result.images ?? []).map(
      async ({ path }): Promise<ToolContent> => ({
        type: "inputImage",
        imageUrl: `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
      }),
    ),
  );
  return {
    success,
    contentItems: [
      { type: "inputText", text: JSON.stringify(result.data) ?? "null" },
      ...images,
    ],
  };
}
