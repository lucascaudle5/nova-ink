/**
 * Z-order keys for storing strokes as separate rows: sorting rows by key gives the page's stroke order.
 *
 * A key is an 8-character base-36 counter followed by a fraction that never ends in '0'. Appending
 * bumps the counter (keys stay short however many strokes are drawn); inserting between two keys
 * (partial-erase pieces, undo restoring a stroke in place) extends the fraction, so there is always
 * room and existing keys never change.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const HEAD = 8
export const MAX_KEY_LENGTH = 64
export const ORDER_KEY = /^[0-9a-z]{8}[0-9a-z]*[1-9a-z]$/

export function isOrderKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= MAX_KEY_LENGTH && ORDER_KEY.test(key)
}

/** A key strictly between `a` and `b`; null means the start or end of the page. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isOrderKey(a)) throw new Error(`Invalid order key ${a}`)
  if (b !== null && !isOrderKey(b)) throw new Error(`Invalid order key ${b}`)
  if (a !== null && b !== null && a >= b) throw new Error(`Order keys out of order: ${a} >= ${b}`)
  if (b === null) return counter(a === null ? 1 : parseInt(a.slice(0, HEAD), 36) + 1) + 'i'
  const head = b.slice(0, HEAD)
  if (a === null) return head + midpoint('', b.slice(HEAD))
  if (a.slice(0, HEAD) === head) return head + midpoint(a.slice(HEAD), b.slice(HEAD))
  return a.slice(0, HEAD) + midpoint(a.slice(HEAD), null)
}

function counter(n: number): string {
  const text = n.toString(36)
  if (text.length > HEAD) throw new Error('Order key counter exhausted')
  return text.padStart(HEAD, '0')
}

/** Fraction strictly between a and b (b null = 1). Neither input nor the result ends in '0'. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}
