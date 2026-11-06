import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
const root = new URL('../assets/', import.meta.url);
mkdirSync(root, { recursive: true });
function crc32(data) { let n = 0xffffffff; for (const b of data) { n ^= b; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const tag = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, bytes]))); return Buffer.concat([len, tag, bytes, crc]); }
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = x / size, b = y / size, edge = a < .08 || a > .92 || b < .08 || b > .92;
    const mark = (Math.abs(a - (.5 - (b - .22) * .53)) < .055 || Math.abs(a - (.5 + (b - .22) * .53)) < .055) && b > .2 && b < .8 || b > .58 && b < .67 && a > .32 && a < .68;
    const color = edge ? [235, 243, 255, 255] : mark ? [255, 255, 255, 255] : [35, 91, 189, 255];
    raw.set(color, y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 24, 32, 48, 64, 128, 256], images = sizes.map(png), header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((bytes, i) => { const p = 6 + i * 16; header[p] = header[p + 1] = sizes[i] % 256; header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6); header.writeUInt32LE(bytes.length, p + 8); header.writeUInt32LE(offset, p + 12); offset += bytes.length; });
writeFileSync(new URL('icon.png', root), images.at(-1)); writeFileSync(new URL('icon.ico', root), Buffer.concat([header, ...images]));
