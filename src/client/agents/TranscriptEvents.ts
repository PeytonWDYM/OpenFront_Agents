import type { PlayerEvent } from "../../agents/types";
import type { Intent } from "../../core/Schemas";
import { UnitType } from "../../core/game/Game";
import { translateText } from "../Utils";

export interface TranscriptEntry {
  key: string;
  event: PlayerEvent;
  preview: string;
  label: string;
}

function decisionPreview(event: PlayerEvent): string | undefined {
  if (event.image) return translateText("agents.vision_image");
  if (event.type === "action") {
    const intent = JSON.parse(event.text.slice("Submitted ".length)) as Intent;
    switch (intent.type) {
      case "build_unit":
        return translateText("agents.action_build", {
          unit: unitName(intent.unit),
          tile: intent.tile,
        });
      case "upgrade_structure":
        return translateText("agents.action_upgrade", {
          unit: unitName(intent.unit),
          id: intent.unitId,
          amount: intent.amount ?? 1,
        });
      case "attack":
        return translateText("agents.action_attack", {
          target: intent.targetID ?? translateText("agents.neutral_land"),
        });
      case "boat":
        return translateText("agents.action_boat", { tile: intent.dst });
      case "spawn":
        return translateText("agents.action_spawn", { tile: intent.tile });
      case "move_warship":
        return translateText("agents.action_move_ship", { tile: intent.tile });
      default:
        return translateText("agents.action_summary", { action: intent.type });
    }
  }
  if (
    event.type === "think" ||
    event.type === "error" ||
    event.type === "tool_error"
  )
    return event.text;
  if (event.type === "item/completed") {
    const notification = JSON.parse(event.text) as {
      params: { item: { type: string; text?: string } };
    };
    if (notification.params.item.type === "agentMessage")
      return notification.params.item.text;
  }
  return undefined;
}

function unitName(unit: UnitType): string {
  const key =
    unit === UnitType.TransportShip
      ? "boat"
      : unit.toLowerCase().replace(/ /g, "_");
  return translateText(`unit_type.${key}`);
}

/** Use stable row keys so polling and history trimming keep expanded details. */
export function transcriptEntries(
  events: PlayerEvent[],
  diagnostics: boolean,
): TranscriptEntry[] {
  const duplicates = new Map<string, number>();
  return events.flatMap((event) => {
    const preview = decisionPreview(event);
    if (!diagnostics && preview === undefined) return [];
    const identity = JSON.stringify([event.time, event.type, event.text]);
    const occurrence = duplicates.get(identity) ?? 0;
    duplicates.set(identity, occurrence + 1);
    const raw = event.text.trimStart();
    return [
      {
        key: `${identity}:${occurrence}`,
        event,
        preview:
          preview ??
          (raw.startsWith("{") || raw.startsWith("[")
            ? translateText("agents.structured_event")
            : event.text),
        label: diagnostics
          ? event.type
          : translateText(
              event.type === "action"
                ? "agents.event_action"
                : event.image
                  ? "agents.event_vision"
                  : event.type === "error" || event.type === "tool_error"
                    ? "agents.event_error"
                    : "agents.event_decision",
            ),
      },
    ];
  });
}
