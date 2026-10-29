// Writes incompressible random-noise PNGs of known sizes for check 3 (large saves). Generated data only.
//   node scripts/make-test-images.mjs            -> %TEMP%\nova-test-images\noise-3mb.png, 6mb, 9mb, 11mb
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { deflateSync, crc32 } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0)
  return Buffer.concat([len, t, data, crc])
}

function noisePng(targetBytes) {
  // RGB 8-bit: each row = 1 filter byte + w*3. Square-ish image sized to hit the target.
  const w = Math.round(Math.sqrt(targetBytes / 3))
  const h = Math.max(1, Math.round(targetBytes / (w * 3 + 1)))
  const rowLen = w * 3 + 1
  const raw = randomBytes(rowLen * h)
  for (let y = 0; y < h; y++) raw[y * rowLen] = 0 // filter type 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit, RGB
  return {
    w, h,
    png: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 0 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  }
}

const dir = join(tmpdir(), 'nova-test-images')
mkdirSync(dir, { recursive: true })
for (const mb of [3, 6, 9, 11]) {
  const { w, h, png } = noisePng(mb * 1024 * 1024)
  const file = join(dir, `noise-${mb}mb.png`)
  writeFileSync(file, png)
  console.log(`${file}  ${w}x${h}  ${(statSync(file).size / 1048576).toFixed(2)} MiB`)
}
