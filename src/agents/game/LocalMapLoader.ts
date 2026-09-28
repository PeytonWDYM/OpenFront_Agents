import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GameMapType } from "../../core/game/Game";
import { GameMapLoader, MapData } from "../../core/game/GameMapLoader";
import { MapManifest } from "../../core/game/TerrainMapLoader";

/** Loads the same map binaries as the browser without a CDN request. */
export class LocalMapLoader implements GameMapLoader {
  getMapData(map: GameMapType): MapData {
    const key = Object.keys(GameMapType).find(
      (key) => GameMapType[key as keyof typeof GameMapType] === map,
    )!;
    const directory = resolve("resources/maps", key.toLowerCase());
    const binary = async (name: string) =>
      new Uint8Array(await readFile(resolve(directory, name)));
    return {
      mapBin: () => binary("map.bin"),
      map4xBin: () => binary("map4x.bin"),
      map16xBin: () => binary("map16x.bin"),
      manifest: async () =>
        JSON.parse(
          await readFile(resolve(directory, "manifest.json"), "utf8"),
        ) as MapManifest,
      webpPath: resolve(directory, "thumbnail.webp"),
      layerPng: async () => {
        throw new Error("The agent mirror does not render map layers");
      },
    };
  }
}
