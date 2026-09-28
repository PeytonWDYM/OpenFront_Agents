import { promisify } from "node:util";
import { deflate } from "node:zlib";

const compress = promisify(deflate);
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++)
    byte = byte & 1 ? 0xedb88320 ^ (byte >>> 1) : byte >>> 1;
  return byte >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, result.length - 4))
    crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

/** Encode bounded RGB frames without native canvas or a new dependency. */
export async function encodePng(
  width: number,
  height: number,
  rgb: Uint8Array,
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++)
    scanlines.set(
      rgb.subarray(y * width * 3, (y + 1) * width * 3),
      y * (width * 3 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", await compress(scanlines, { level: 3 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
