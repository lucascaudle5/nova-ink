/** Small, dependency-free encoders for the stroke point format. Identical in Node and browsers. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export class CodecError extends Error {}

export function zigzag(n: number): number { return n >= 0 ? n * 2 : -n * 2 - 1 }
export function unzigzag(n: number): number { return n % 2 === 0 ? n / 2 : -(n + 1) / 2 }

/** Appends an unsigned varint. Arithmetic, not bitwise, so values beyond 2^31 are safe. */
export function writeVarint(out: number[], value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CodecError(`Cannot encode ${value}`)
  while (value >= 128) { out.push((value % 128) + 128); value = Math.floor(value / 128) }
  out.push(value)
}

export class VarintReader {
  offset = 0
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean { return this.offset >= this.bytes.length }
  read(): number {
    let value = 0, scale = 1
    for (let i = 0; i < 8; i++) {
      if (this.offset >= this.bytes.length) throw new CodecError('Truncated point data')
      const byte = this.bytes[this.offset++]
      value += (byte & 127) * scale
      if (byte < 128) return value
      scale *= 128
    }
    throw new CodecError('Varint too long')
  }
}

export function toBase64(bytes: ArrayLike<number>): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '='
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new CodecError('Invalid base64 length')
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length
    const c = [0, 1, 2, 3].map(k => {
      const ch = text.charCodeAt(i + k)
      if (last && ch === 61 && k >= 4 - pad) return 0
      const v = ch < 128 ? LOOKUP[ch] : -1
      if (v < 0) throw new CodecError('Invalid base64 character')
      return v
    })
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3]
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}
