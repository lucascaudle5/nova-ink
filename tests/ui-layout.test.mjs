import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const ui = fs.readFileSync(path.resolve('src/main.tsx'), 'utf8')

test('tldraw keeps its native toolbar and places it in the top panel', () => {
  assert.match(ui, /Toolbar:\s*null/)
  assert.match(ui, /TopPanel:\s*\(\)\s*=>\s*<DefaultToolbar orientation="horizontal" \/>/)
  assert.match(ui, /components=\{tldrawComponents\}/)
})
