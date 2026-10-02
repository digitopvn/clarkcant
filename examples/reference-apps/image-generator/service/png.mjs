/*
 * A deterministic picture for a prompt, as PNG bytes.
 *
 * The same prompt always gives the same bytes: the colours, the stripes and the disc all come from the prompt's SHA-256.
 * The fake provider in this package's tests draws its images with this, and the service draws with it itself when no
 * provider origin is declared (the `ui-with-service` template). No dependencies, so it runs in the service's container.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const IMAGE_SIZE = 192;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

/** PNG bytes of a `size`×`size` RGB picture drawn from the prompt. */
export function renderImage(prompt, size = IMAGE_SIZE) {
  const seed = createHash("sha256").update(String(prompt), "utf8").digest();
  const from = [seed[0], seed[1], seed[2]];
  const to = [seed[3], seed[4], seed[5]];
  const disc = [seed[6], seed[7], seed[8]];
  const cx = (seed[9] / 255) * size;
  const cy = (seed[10] / 255) * size;
  const radius = size * (0.18 + (seed[11] / 255) * 0.22);
  const bands = 3 + (seed[12] % 6);

  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      let colour = mix(from, to, (x + y) / (2 * (size - 1)));
      if (Math.floor(((x + y) * bands) / size) % 2 === 1) colour = colour.map((value) => Math.round(value * 0.85));
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) colour = disc;
      row.set(colour, 1 + x * 3);
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
