import { z } from "zod";

const layers = z
  .object({
    grid: z.boolean().optional(),
    labels: z.boolean().optional(),
    units: z.boolean().optional(),
    sam: z.boolean().optional(),
    tradeRoutes: z.boolean().optional(),
  })
  .strict();

export const VisionOverlaySchema = z.union([z.boolean(), layers]);
export type VisionOverlays = z.infer<typeof VisionOverlaySchema>;
export type VisionLayers = Required<z.infer<typeof layers>>;

export function resolveOverlays(overlays?: VisionOverlays): VisionLayers {
  if (typeof overlays === "boolean")
    return {
      grid: overlays,
      labels: overlays,
      units: overlays,
      sam: overlays,
      tradeRoutes: overlays,
    };
  return {
    grid: true,
    labels: true,
    units: true,
    sam: false,
    tradeRoutes: false,
    ...overlays,
  };
}

/** Include each layer in filenames so a clean image cannot overwrite a marked image. */
export const overlayKey = (layers: VisionLayers) =>
  [layers.grid, layers.labels, layers.units, layers.sam, layers.tradeRoutes]
    .map(Number)
    .join("");
