import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { MapImages } from "../../src/agents/vision";
import { Raster } from "../../src/agents/vision/raster";
import { PlayerType } from "../../src/core/game/Game";
import { playerInfo, setup } from "../util/Setup";

// Failure cases: high narrow overviews clip the last legend row, the badge note
// overwrites a ship name, or fixing the legend changes the requested map bounds.
// Load actual resource maps into the native simulation. No server or inference runs.
const frames = [];
for (const map of ["korea", "mississippiriver", "caspiansea", "luna"]) {
  // setup() resolves map names beneath tests/testdata/maps. Use the real assets.
  const game = await setup(`../../../resources/maps/${map}`, {}, [
    playerInfo("Viewer", PlayerType.Human),
  ]);
  const image = (
    await new MapImages(`vision-narrow-${map}-e2e`).render(
      game,
      game.player("Viewer"),
    )
  ).overview;
  assert(image.width < 900);
  assert.equal(image.height, 1536);
  assert.deepEqual(image.region, {
    x: 0,
    y: 0,
    width: game.width(),
    height: game.height(),
  });
  const png = await readFile(image.path);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.subarray(at + 4, at + 8).toString() === "IDAT")
      chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const findLabel = (label: string) => {
    const glyph = new Raster(label.length * 6, 7);
    glyph.text(label, 0, 0);
    for (let y = image.height - 100; y <= image.height - 7; y++)
      for (let x = 0; x <= image.width - glyph.width; x++) {
        let matches = true;
        for (let dy = 0; dy < 7 && matches; dy++)
          for (let dx = 0; dx < glyph.width && matches; dx++)
            for (let channel = 0; channel < 3 && matches; channel++)
              matches =
                glyph.rgb[(dy * glyph.width + dx) * 3 + channel] ===
                pixels[
                  (y + dy) * (image.width * 3 + 1) + 1 + (x + dx) * 3 + channel
                ];
        if (matches) return { x, y, width: glyph.width, height: glyph.height };
      }
    return undefined;
  };
  const labels = [
    "WARSHIP",
    "TRANSPORT",
    "TRADE",
    "BADGE: LEVEL OR X COUNT",
  ].map((label) => {
    const box = findLabel(label);
    assert(box, `${map}: the complete ${label} legend text must stay visible`);
    return { label, ...box };
  });
  const badge = labels[3];
  assert(labels.slice(0, 3).every((label) => label.y + label.height < badge.y));
  frames.push({ map, image, labels });
}
const artifact = resolve(".agent-arena/vision-narrow-e2e.json");
await writeFile(
  artifact,
  JSON.stringify({ passed: true, inferenceRequests: 0, frames }, null, 2),
);
console.log(
  JSON.stringify({
    passed: true,
    artifact,
    frames: frames.map((frame) => frame.image.path),
  }),
);
