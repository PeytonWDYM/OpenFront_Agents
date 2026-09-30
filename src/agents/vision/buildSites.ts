import { Game, UnitType } from "../../core/game/Game";
import type { AgentObservation } from "../game/schemas";
import { Raster, Region } from "./raster";

export type PortSiteMarker = {
  label: string;
  tile: number;
  x: number;
  y: number;
  upgradeId: number | false;
};

/** ObservationBuilder supplies world coordinates for every returned site. */
export function portBuildSiteRegion(
  sites: AgentObservation["map"]["buildSites"],
  width: number,
  height: number,
): Region {
  const xs = sites.map((site) => site.x!);
  const ys = sites.map((site) => site.y!);
  const x = Math.max(0, Math.min(...xs) - 24);
  const y = Math.max(0, Math.min(...ys) - 24);
  return {
    x,
    y,
    width: Math.min(width, Math.max(...xs) + 25) - x,
    height: Math.min(height, Math.max(...ys) + 25) - y,
  };
}

/** Mark the observation's exact Port tiles and keep the IDs in image metadata. */
export function drawPortBuildSites(
  raster: Raster,
  game: Game,
  region: Region,
  mapPixels: Region,
  sites: AgentObservation["map"]["buildSites"],
): PortSiteMarker[] {
  const markers: PortSiteMarker[] = [];
  for (const [index, site] of sites.entries()) {
    const x = game.x(site.tile);
    const y = game.y(site.tile);
    if (
      site.type !== UnitType.Port ||
      x < region.x ||
      x >= region.x + region.width ||
      y < region.y ||
      y >= region.y + region.height
    )
      continue;
    const label = `P${index + 1}`;
    const px =
      mapPixels.x +
      Math.floor(((x - region.x) * mapPixels.width) / region.width);
    const py =
      mapPixels.y +
      Math.floor(((y - region.y) * mapPixels.height) / region.height);
    const color = [100, 255, 170] as const;
    raster.line(px - 3, py, px + 3, py, color, mapPixels);
    raster.line(px, py - 3, px, py + 3, color, mapPixels);
    raster.text(
      label,
      Math.min(px + 5, mapPixels.x + mapPixels.width - label.length * 6),
      Math.max(mapPixels.y, py - 8),
      color,
    );
    markers.push({ label, tile: site.tile, x, y, upgradeId: site.upgradeId });
  }
  raster.text(
    "GREEN P1..P12 PORT SITES - USE TILE IDS",
    8,
    raster.height - 45,
    [100, 255, 170],
  );
  return markers;
}
