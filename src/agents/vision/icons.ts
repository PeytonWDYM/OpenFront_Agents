import { UnitType } from "../../core/game/Game";
import { Color, Raster, Region } from "./raster";

// Fixed raster pictograms keep map images independent of fonts and image assets.
const icons = new Map<UnitType, readonly string[]>([
  [
    UnitType.City,
    [
      "0000001000000",
      "0000011100000",
      "0000111110000",
      "0001111111000",
      "0011111111100",
      "0010001000100",
      "0010101010100",
      "0010001000100",
      "0010101010100",
      "0010001000100",
      "0010101010100",
      "0010001000100",
      "1111111111111",
    ],
  ],
  [
    UnitType.Port,
    [
      "0000011100000",
      "0000100010000",
      "0000011100000",
      "0000001000000",
      "0000001000000",
      "0001111111000",
      "0000001000000",
      "0100001000010",
      "0100001000010",
      "0010001000100",
      "0001001001000",
      "0000111110000",
      "0000001000000",
    ],
  ],
  [
    UnitType.Factory,
    [
      "0000000001100",
      "0000000011000",
      "0000000100000",
      "0000000110000",
      "0000000110000",
      "0001000110000",
      "0011001110000",
      "0111011110000",
      "1111111111111",
      "1000000000001",
      "1010101010101",
      "1000000000001",
      "1111111111111",
    ],
  ],
  [
    UnitType.DefensePost,
    [
      "0000000000000",
      "1010100010101",
      "1111100011111",
      "1000100010001",
      "1010100010101",
      "1000111110001",
      "1000100010001",
      "1010101010101",
      "1000101010001",
      "1000100010001",
      "1000100010001",
      "1000111110001",
      "1111111111111",
    ],
  ],
  [
    UnitType.SAMLauncher,
    [
      "0000000000100",
      "0000000001110",
      "0000000011100",
      "0000000111000",
      "0000001110000",
      "0000011100000",
      "0000111000000",
      "0000110000000",
      "0000100000000",
      "0000100000000",
      "0011111111000",
      "0111111111100",
      "0011000011000",
    ],
  ],
  [
    UnitType.MissileSilo,
    [
      "0000001000000",
      "0000011100000",
      "0000111110000",
      "0000111110000",
      "0000101010000",
      "0000100010000",
      "0000100010000",
      "0001100011000",
      "0011100011100",
      "0011100011100",
      "0000011100000",
      "0000010100000",
      "1111111111111",
    ],
  ],
  [
    UnitType.Warship,
    [
      "0000000000000",
      "0000001000000",
      "0000001000000",
      "0001111110000",
      "0001000010000",
      "0001111111110",
      "0001111110000",
      "0011111111100",
      "1111111111111",
      "0111111111110",
      "0011111111100",
      "0001111111000",
      "0000000000000",
    ],
  ],
  [
    UnitType.TransportShip,
    [
      "0000000000000",
      "0000000000000",
      "0000000000000",
      "0000111110000",
      "0000100010000",
      "0000111110000",
      "0111111111110",
      "0101010101010",
      "1111111111111",
      "0111111111110",
      "0011111111100",
      "0001111111000",
      "0000000000000",
    ],
  ],
  [
    UnitType.TradeShip,
    [
      "0000000000000",
      "0000001000000",
      "0000001000000",
      "0000001000000",
      "0000011111000",
      "0000011110000",
      "0000011100000",
      "0000001000000",
      "1111111111111",
      "0111111111110",
      "0011111111100",
      "0001111111000",
      "0000000000000",
    ],
  ],
]);

/** Only the nine public map unit types have pictograms. Clip edge icons to the map. */
export function drawUnitIcon(
  raster: Raster,
  type: UnitType,
  x: number,
  y: number,
  color: Color,
  clip: Region,
  scale = 1,
) {
  const rows = icons.get(type)!;
  for (const [dy, row] of rows.entries())
    for (let dx = 0; dx < row.length; dx++) {
      if (row[dx] !== "1") continue;
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) {
          const px = x + dx * scale + sx,
            py = y + dy * scale + sy;
          if (
            px >= clip.x &&
            px < clip.x + clip.width &&
            py >= clip.y &&
            py < clip.y + clip.height
          )
            raster.pixel(px, py, color);
        }
    }
}

export function drawUnitLegend(raster: Raster, scale = 1) {
  const entries = [
    [UnitType.City, "CITY"],
    [UnitType.Port, "PORT"],
    [UnitType.Factory, "FACTORY"],
    [UnitType.DefensePost, "DEFENSE"],
    [UnitType.SAMLauncher, "SAM"],
    [UnitType.MissileSilo, "SILO"],
    [UnitType.Warship, "WARSHIP"],
    [UnitType.TransportShip, "TRANSPORT"],
    [UnitType.TradeShip, "TRADE"],
  ] as const;
  const columns = raster.width >= 900 ? 9 : 3;
  // Three rows use standard icon size to fit the footer on narrow overviews.
  const legendScale = columns === 3 ? 1 : scale;
  const slotWidth = Math.floor((raster.width - 16) / columns);
  const clip = { x: 0, y: 0, width: raster.width, height: raster.height };
  for (const [index, [type, name]] of entries.entries()) {
    const x = 8 + (index % columns) * slotWidth;
    const y =
      raster.height - 72 + Math.floor(index / columns) * 18 * legendScale;
    drawUnitIcon(raster, type, x, y, [239, 245, 250], clip, legendScale);
    raster.text(name, x + 16 * legendScale, y + 3 * legendScale);
  }
  raster.text("BADGE: LEVEL OR X COUNT", 8, raster.height - 12);
}
