import { Game, UnitType } from "../../core/game/Game";
import type { TradeHeatmap } from "../game/tradeHeatmap";
import { drawUnitIcon } from "./icons";
import { Color, Raster, Region } from "./raster";

/** Draw before labels and unit markers. Reserve 36 footer pixels for the legend. */
export function drawTradeHeatmap(
  raster: Raster,
  game: Game,
  region: Region,
  mapPixels: Region,
  heatmap: TradeHeatmap,
  legendY: number,
  showWarships: boolean = true,
) {
  const point = (x: number, y: number) => ({
    pixelX:
      mapPixels.x +
      Math.floor(((x - region.x) * mapPixels.width) / region.width),
    pixelY:
      mapPixels.y +
      Math.floor(((y - region.y) * mapPixels.height) / region.height),
  });
  const inside = (x: number, y: number) =>
    x >= region.x &&
    x < region.x + region.width &&
    y >= region.y &&
    y < region.y + region.height;
  const maximum = Math.max(1, ...heatmap.bins.map((bin) => bin.total));
  for (const bin of heatmap.bins) {
    const left = Math.max(
      mapPixels.x,
      mapPixels.x +
        Math.floor(((bin.x - region.x) * mapPixels.width) / region.width),
    );
    const top = Math.max(
      mapPixels.y,
      mapPixels.y +
        Math.floor(((bin.y - region.y) * mapPixels.height) / region.height),
    );
    const right = Math.min(
      mapPixels.x + mapPixels.width,
      mapPixels.x +
        Math.ceil(
          ((bin.x + bin.width - region.x) * mapPixels.width) / region.width,
        ),
    );
    const bottom = Math.min(
      mapPixels.y + mapPixels.height,
      mapPixels.y +
        Math.ceil(
          ((bin.y + bin.height - region.y) * mapPixels.height) / region.height,
        ),
    );
    const strength =
      0.25 + (0.55 * Math.log1p(bin.total)) / Math.log1p(maximum);
    const fraction = bin.eligible / bin.total;
    const color: Color = [
      40 + 215 * fraction,
      160 + 35 * fraction,
      225 - 155 * fraction,
    ];
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        const tile = game.ref(
          region.x +
            Math.floor(
              ((x - mapPixels.x + 0.5) * region.width) / mapPixels.width,
            ),
          region.y +
            Math.floor(
              ((y - mapPixels.y + 0.5) * region.height) / mapPixels.height,
            ),
        );
        if (!game.isWater(tile)) continue;
        const at = (y * raster.width + x) * 3;
        raster.pixel(x, y, [
          raster.rgb[at] * (1 - strength) + color[0] * strength,
          raster.rgb[at + 1] * (1 - strength) + color[1] * strength,
          raster.rgb[at + 2] * (1 - strength) + color[2] * strength,
        ]);
      }
  }
  for (const ship of showWarships ? heatmap.warships : []) {
    const color: Color =
      ship.affiliation === "self"
        ? [114, 244, 154]
        : ship.affiliation === "other"
          ? [255, 104, 111]
          : [100, 223, 246];
    if (ship.patrol) {
      const center = point(ship.patrol.x, ship.patrol.y);
      raster.ellipse(
        center.pixelX,
        center.pixelY,
        (ship.patrol.radius * mapPixels.width) / region.width,
        (ship.patrol.radius * mapPixels.height) / region.height,
        color,
        mapPixels,
      );
      raster.line(
        center.pixelX - 3,
        center.pixelY,
        center.pixelX + 3,
        center.pixelY,
        color,
        mapPixels,
      );
      raster.line(
        center.pixelX,
        center.pixelY - 3,
        center.pixelX,
        center.pixelY + 3,
        color,
        mapPixels,
      );
    }
    if (inside(ship.x, ship.y)) {
      const marker = point(ship.x, ship.y);
      drawUnitIcon(
        raster,
        UnitType.Warship,
        marker.pixelX - 6,
        marker.pixelY - 6,
        color,
        mapPixels,
      );
    }
  }
  const hotspots = heatmap.hotspots
    .filter((spot) => inside(spot.x, spot.y))
    .map((spot) => ({ ...spot, ...point(spot.x, spot.y) }));
  for (const spot of hotspots) {
    const color: Color = spot.launch ? [255, 217, 89] : [156, 186, 202];
    raster.line(
      spot.pixelX - 4,
      spot.pixelY - 4,
      spot.pixelX + 4,
      spot.pixelY + 4,
      color,
      mapPixels,
    );
    raster.line(
      spot.pixelX - 4,
      spot.pixelY + 4,
      spot.pixelX + 4,
      spot.pixelY - 4,
      color,
      mapPixels,
    );
  }
  const legend = { x: 8, y: legendY, width: raster.width - 16, height: 36 };
  raster.text(
    `TRADE NOW ${heatmap.traffic.total} ELIGIBLE ${heatmap.traffic.eligible} TICK ${heatmap.tick}`,
    legend.x,
    legend.y,
  );
  raster.text("BLUE ALL TRAFFIC / AMBER ELIGIBLE", legend.x, legend.y + 9);
  raster.text(
    "RING PATROL 100 / DETECTION 130 FROM SHIP",
    legend.x,
    legend.y + 18,
  );
  raster.text("GREEN OWN / RED OTHER / GOLD X BUILD", legend.x, legend.y + 27);
  return { hotspots, legend, maximumBinTraffic: maximum };
}
