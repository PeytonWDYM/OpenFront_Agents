import { z } from "zod";
import { Structures, UnitType } from "../../core/game/Game";

const layers = z
  .object({
    grid: z.boolean().optional(),
    labels: z.boolean().optional(),
    units: z.boolean().optional(),
    structures: z.boolean().optional(),
    warships: z.boolean().optional(),
    transports: z.boolean().optional(),
    tradeShips: z.boolean().optional(),
    sam: z.boolean().optional(),
    tradeRoutes: z.boolean().optional(),
  })
  .strict();

export const VisionOverlaySchema = z.union([z.boolean(), layers]);
export type VisionOverlays = z.infer<typeof VisionOverlaySchema>;
export type VisionLayers = Required<z.infer<typeof layers>>;
export const VisionResolutionSchema = z.enum(["standard", "high"]);
export type VisionResolution = z.infer<typeof VisionResolutionSchema>;

/** Fixed presets bound image work while retaining the exact crop transform. */
export function imageLimit(resolution: VisionResolution, overview = false) {
  return overview
    ? resolution === "high"
      ? 1536
      : 1024
    : resolution === "high"
      ? 768
      : 512;
}

export function resolveOverlays(overlays?: VisionOverlays): VisionLayers {
  if (typeof overlays === "boolean")
    return {
      grid: overlays,
      labels: overlays,
      units: overlays,
      structures: overlays,
      warships: overlays,
      transports: overlays,
      tradeShips: overlays,
      sam: overlays,
      tradeRoutes: overlays,
    };
  return {
    grid: true,
    labels: true,
    units: true,
    structures: overlays?.units ?? true,
    warships: overlays?.units ?? true,
    transports: overlays?.units ?? true,
    tradeShips: false,
    sam: false,
    tradeRoutes: false,
    ...overlays,
  };
}

export function unitLayerVisible(
  type: UnitType,
  layers: VisionLayers,
): boolean {
  if (Structures.has(type)) return layers.structures;
  if (type === UnitType.Warship) return layers.warships;
  if (type === UnitType.TransportShip) return layers.transports;
  return type === UnitType.TradeShip && layers.tradeShips;
}

/** Include each layer in filenames so a clean image cannot overwrite a marked image. */
export const overlayKey = (layers: VisionLayers) =>
  [
    layers.grid,
    layers.labels,
    layers.units,
    layers.structures,
    layers.warships,
    layers.transports,
    layers.tradeShips,
    layers.sam,
    layers.tradeRoutes,
  ]
    .map(Number)
    .join("");
