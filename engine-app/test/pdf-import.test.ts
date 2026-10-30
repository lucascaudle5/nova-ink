import assert from 'node:assert/strict'
import { test } from 'node:test'
import { importScript } from '../pdf'

const moduleText = 'export const answer = 42; export const text = "héllo ✓"'

test('a script that loads directly is not fetched', async () => {
  let fetched = 0
  const result = await importScript('https://x.test/a.mjs', async () => ({ ok: true }), async () => { fetched++; return new Response('') })
  assert.deepEqual(result, { ok: true })
  assert.equal(fetched, 0)
})

test('a host that refuses the script gets it as a data: module, text intact', async () => {
  const seen: string[] = []
  const direct = async (url: string) => { seen.push(url); if (!url.startsWith('data:')) throw new Error('blocked by the host'); return import(url) }
  const mod = await importScript('https://x.test/a.mjs', direct, async () => new Response(moduleText)) as { answer: number; text: string }
  assert.equal(mod.answer, 42)
  assert.equal(mod.text, 'héllo ✓')
  assert.equal(seen.length, 2)
  assert.ok(seen[1].startsWith('data:text/javascript;base64,'))
})

test('a large script survives the conversion', async () => {
  const big = `export const n = ${JSON.stringify('x'.repeat(300_000))}.length`
  const direct = async (url: string) => { if (!url.startsWith('data:')) throw new Error('blocked'); return import(url) }
  const mod = await importScript('https://x.test/big.mjs', direct, async () => new Response(big)) as { n: number }
  assert.equal(mod.n, 300_000)
})

test('when the fetch also fails, the first (real) error is reported', async () => {
  await assert.rejects(importScript('https://x.test/a.mjs', async () => { throw new Error('blocked by the host') }, async () => new Response('no', { status: 404 })), /blocked by the host/)
  await assert.rejects(importScript('https://x.test/a.mjs', async () => { throw new Error('blocked by the host') }, async () => { throw new Error('network') }), /blocked by the host/)
})
