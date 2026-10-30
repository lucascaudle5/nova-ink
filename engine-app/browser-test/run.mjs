// Browser tests for the NOVA Ink notebook widget: a real Chromium (Edge or Chrome, headless) driving the real app
// with real pointer, touch and mouse input over the DevTools protocol. No extra dependencies.
//
//   npm run test:browser
//
// Set NOVA_BROWSER to a browser executable if it is not found; NOVA_BROWSER_SHOW=1 shows the window.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

function findBrowser() {
  const candidates = [
    process.env.NOVA_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ]
  return candidates.find(p => p && existsSync(p))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const shots = join(root, 'engine-app', 'browser-test', 'out')

// ---- start the app and a browser ----

const browserPath = findBrowser()
if (!browserPath) { console.error('No Edge or Chrome found. Set NOVA_BROWSER to its path.'); process.exit(2) }

const server = await createServer({ configFile: resolve(root, 'engine-app', 'vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 5199, strictPort: false } })
await server.listen()
const base = (server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5199/').replace(/\/$/, '')
const port = 9400 + Math.floor(Math.random() * 400)
const profile = mkdtempSync(join(tmpdir(), 'nova-browser-test-'))
const browser = spawn(browserPath, [
  ...(process.env.NOVA_BROWSER_SHOW ? [] : ['--headless=new']),
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1180,900', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' })

async function shutdown(code) {
  try { browser.kill() } catch {}
  try { await server.close() } catch {}
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(code)
}

let targets
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some(t => t.type === 'page')) break } catch {} await sleep(250) }
if (!targets) { console.error('The browser did not start.'); await shutdown(2) }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))

let nextId = 0
const waiting = new Map()
const problems = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return }
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n').slice(0, 3).join(' | '))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '))
})
const send = (method, params = {}) => new Promise(r => { const n = ++nextId; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error('page script failed: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text))
  return r.result.result.value
}
const json = async expression => JSON.parse(await evaluate(`JSON.stringify(${expression})`))
/** Like json, for an expression that is a promise. */
const jsonAsync = async expression => JSON.parse(await evaluate(`(async () => JSON.stringify(await (${expression})))()`))

// ---- input helpers ----

const pointerInput = (type, x, y, pointerType = 'mouse') => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType, pressure: pointerType === 'pen' ? 0.5 : undefined })
async function drag(points, pointerType = 'mouse', { release = true } = {}) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points[0][0], y: points[0][1], button: 'none', buttons: 0, pointerType })
  await pointerInput('mousePressed', points[0][0], points[0][1], pointerType)
  for (const [x, y] of points.slice(1)) await pointerInput('mouseMoved', x, y, pointerType)
  if (release) await pointerInput('mouseReleased', ...points.at(-1), pointerType)
}
const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id = 1]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 0.5 })) })
async function finger(points, { release = true } = {}) {
  await touch('touchStart', [points[0]])
  for (const p of points.slice(1)) await touch('touchMove', [p])
  if (release) await touch('touchEnd', [])
}
const line = (from, to, steps = 10) => Array.from({ length: steps + 1 }, (_, k) => [from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps])
const click = async (x, y) => { await drag([[x, y], [x, y]]) }
const center = async selector => (await json(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`))
const clickSel = async selector => click(...await center(selector))

// ---- app helpers ----

async function openApp() {
  problems.length = 0
  await send('Page.navigate', { url: `${base}/notebook.html?mock` })
  await sleep(1200)
  await evaluate('localStorage.clear()')
  await send('Page.navigate', { url: `${base}/notebook.html?mock` })
  for (let i = 0; i < 60; i++) { if (await evaluate(`!!window.novaSurface && document.getElementById('status-text')?.textContent !== 'Connecting…'`).catch(() => false)) break; await sleep(150) }
  await sleep(300)
}
const surfaceBox = () => json(`(()=>{const r=document.getElementById('surface').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()`)
const camera = () => json('novaSurface.camera')
async function toScreen(x, y) { const c = await camera(), b = await surfaceBox(); return [(x - c.x) * c.z + b.left, (y - c.y) * c.z + b.top] }
const picture = () => json('novaSurface.selectedImage || novaSurface.doc.images[0] || null')
const strokeCount = () => evaluate('novaSurface.doc.strokes.length')
const state = () => json('({ tool: novaSurface.tool, strokes: novaSurface.doc.strokes.length, images: novaSurface.doc.images.map(i => [Math.round(i.x), Math.round(i.y), Math.round(i.w), Math.round(i.h), i.angle]), selected: novaSurface.selectedImage ? novaSurface.selectedImage.id : null, inking: novaSurface.input.inking })')
async function insertPicture() {
  await evaluate(`(async () => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const x = c.getContext('2d'); x.fillStyle = '#3a7'; x.fillRect(0, 0, 300, 200); x.fillStyle = '#fff'; x.fillRect(20, 20, 80, 60); const b = await new Promise(r => c.toBlob(r, 'image/png')); await novaInsertPicture(new File([b], 't.png', { type: 'image/png' })) })()`)
  for (let i = 0; i < 40; i++) { const a = await camera(); await sleep(150); const b = await camera(); if (a.x === b.x && a.y === b.y && a.z === b.z && (await evaluate('novaSurface.doc.images.length')) > 0) break }
}
async function selectTool() { await evaluate(`document.querySelector('button[data-tool="select"]').click()`); await sleep(100) }
async function penTool() { await evaluate(`document.querySelector('button[data-tool="pen"]').click()`); await sleep(100) }
async function drawStroke(y = 700, pointerType = 'pen') { await drag(line([200, y], [320, y + 20]), pointerType) }

const assert = {
  ok(value, message) { if (!value) throw new Error(message) },
  equal(actual, expected, message) { if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) },
  deepEqual(actual, expected, message) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) },
  near(actual, expected, tolerance, message) { if (!(Math.abs(actual - expected) <= tolerance)) throw new Error(`${message}: expected about ${expected}, got ${actual}`) },
}

async function test(name, fn) {
  const started = Date.now()
  try {
    await openApp()
    await fn()
    if (problems.length) throw new Error('the page reported errors:\n    ' + problems.join('\n    '))
    results.push({ name, ok: true })
    console.log(`  ok    ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL  ${name}\n    ${String(error.message ?? error).split('\n').join('\n    ')}`)
    try {
      mkdirSync(shots, { recursive: true })
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const file = join(shots, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png')
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      console.log(`    screenshot: ${file}`)
    } catch {}
  }
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
console.log(`Browser tests (${browserPath})`)

// ---- the tests ----

await test('the notebook opens and is ready to draw', async () => {
  assert.ok(await evaluate('!!document.getElementById("rail") && !document.getElementById("rail").hidden'), 'the tool rail is shown')
  assert.equal(await evaluate('novaSurface.tool'), 'pen', 'the pen is the starting tool')
  assert.equal(await evaluate('document.getElementById("selection-bar").hidden'), true, 'no selection bar before anything is selected')
})

await test('the pen draws, and undo and redo work', async () => {
  await drawStroke(500, 'pen')
  assert.equal(await strokeCount(), 1, 'a pen stroke is added')
  await drawStroke(560, 'mouse')
  assert.equal(await strokeCount(), 2, 'a mouse stroke is added')
  await clickSel('#undo'); await sleep(100)
  assert.equal(await strokeCount(), 1, 'undo removes the last stroke')
  await clickSel('#redo'); await sleep(100)
  assert.equal(await strokeCount(), 2, 'redo puts it back')
})

await test('a picture can be moved again and again, and the pen still draws afterwards', async () => {
  await insertPicture()
  await selectTool()
  {
    const first = await picture()
    await click(...await toScreen(first.x + first.w / 2, first.y + first.h / 2)); await sleep(100)
  }
  for (let round = 1; round <= 3; round++) {
    const p = await picture()
    const [cx, cy] = await toScreen(p.x + p.w / 2, p.y + p.h / 2)
    await drag(line([cx, cy], [cx + 60, cy + 30]), 'pen')
    await sleep(100)
    const moved = await picture()
    assert.near(moved.x - p.x, 60, 2, `move ${round} sideways`)
    assert.near(moved.y - p.y, 30, 2, `move ${round} down`)
    assert.equal(await evaluate('novaSurface.input.inking'), false, `input is released after move ${round}`)
  }
  await penTool()
  const before = await strokeCount()
  await drawStroke(700, 'pen')
  assert.equal(await strokeCount(), before + 1, 'the pen draws after the picture was moved')
})

await test('a picture resizes from its corner and turns freely from its round handle, snapping near 45 degrees', async () => {
  await insertPicture()
  await selectTool()
  let p = await picture()
  const [cx, cy] = await toScreen(p.x + p.w / 2, p.y + p.h / 2)
  await click(cx, cy); await sleep(100)
  p = await picture()
  const [hx, hy] = await toScreen(p.x + p.w, p.y + p.h)
  await drag(line([hx, hy], [hx + 70, hy + 70]), 'pen'); await sleep(100)
  const bigger = await picture()
  assert.ok(bigger.w > p.w + 30, `resizing from the corner made it wider (${p.w} to ${bigger.w})`)
  assert.near(bigger.w / bigger.h, p.w / p.h, 0.02, 'the shape is kept')
  // turn: the handle sits ROTATE_OFFSET above the top-middle; drag it round to about 43 degrees clockwise
  const [mx, my] = await toScreen(bigger.x + bigger.w / 2, bigger.y + bigger.h / 2)
  const [tx, ty] = await toScreen(bigger.x + bigger.w / 2, bigger.y)
  const handle = [tx, ty - 36]
  const radius = Math.hypot(handle[0] - mx, handle[1] - my)
  const aim = deg => [mx + radius * Math.sin((deg * Math.PI) / 180), my - radius * Math.cos((deg * Math.PI) / 180)]
  await drag([handle, aim(10), aim(25), aim(38), aim(43)], 'pen'); await sleep(100)
  const turned = await picture()
  assert.equal(turned.angle, 45, 'a drop at 43 degrees snaps to 45')
  assert.ok((await evaluate('document.getElementById("selection-label").textContent')).includes('45'), 'the bar shows the angle')
  // a drop well away from a snap keeps its angle
  const [ax, ay] = [mx + radius * Math.sin(Math.PI / 4), my - radius * Math.cos(Math.PI / 4)]
  await drag([[ax, ay], aim(60), aim(70)], 'pen'); await sleep(100)
  const free = await picture()
  assert.near(free.angle, 70, 1.5, 'a free angle is kept')
  await evaluate('document.getElementById("sel-turn").click()'); await sleep(100)
  assert.near((await picture()).angle, 160, 1.5, 'Turn 90 adds a quarter')
  await clickSel('#undo'); await sleep(100)
  assert.near((await picture()).angle, 70, 1.5, 'undo takes the quarter turn back')
})

await test('fingers move, resize and turn a picture; empty paper still pans', async () => {
  await insertPicture()
  await selectTool()
  let p = await picture()
  const [cx, cy] = await toScreen(p.x + p.w / 2, p.y + p.h / 2)
  await finger(line([cx, cy], [cx + 50, cy + 20])); await sleep(150)
  let moved = await picture()
  assert.near(moved.x - p.x, 50, 3, 'a finger drags the picture')
  assert.equal(await evaluate('novaSurface.input.navigating'), false, 'moving a picture is not a pan')
  p = moved
  const [hx, hy] = await toScreen(p.x + p.w, p.y + p.h)
  await finger(line([hx, hy], [hx + 60, hy + 60])); await sleep(150)
  const bigger = await picture()
  assert.ok(bigger.w > p.w + 30, `a finger resizes from the corner (${p.w} to ${bigger.w})`)
  const [mx, my] = await toScreen(bigger.x + bigger.w / 2, bigger.y + bigger.h / 2)
  const [tx, ty] = await toScreen(bigger.x + bigger.w / 2, bigger.y)
  const handle = [tx, ty - 36]
  const radius = Math.hypot(handle[0] - mx, handle[1] - my)
  const aim = deg => [mx + radius * Math.sin((deg * Math.PI) / 180), my - radius * Math.cos((deg * Math.PI) / 180)]
  await finger([handle, aim(20), aim(50), aim(88)]); await sleep(150)
  assert.equal((await picture()).angle, 90, 'a finger turns the picture, snapping to 90')
  // empty paper: a finger pans the camera
  const before = await camera()
  await finger(line([150, 650], [250, 600])); await sleep(150)
  const after = await camera()
  assert.ok(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 10, 'a finger on empty paper pans')
  assert.equal(await evaluate('novaSurface.input.inking'), false, 'input is released')
})

await test('input recovers when a pointer is lost (no pen-up, no cancel)', async () => {
  await drag(line([200, 500], [260, 520]), 'pen', { release: false })
  assert.equal(await evaluate('novaSurface.input.inking'), true, 'the stroke is under way')
  await drag(line([200, 600], [300, 620]), 'pen')
  assert.equal(await evaluate('novaSurface.input.inking'), false, 'a new pen-down recovers from the lost one')
  assert.equal(await strokeCount(), 2, 'what was drawn of the lost stroke is kept, and the new stroke is added')
  // the page losing focus mid-drag drops it
  await insertPicture()
  await selectTool()
  const p = await picture()
  const [cx, cy] = await toScreen(p.x + p.w / 2, p.y + p.h / 2)
  await click(cx, cy); await sleep(100)
  await drag(line([cx, cy], [cx + 80, cy]), 'pen', { release: false })
  await evaluate('window.dispatchEvent(new Event("blur"))'); await sleep(100)
  assert.equal(await evaluate('novaSurface.input.inking'), false, 'a blur ends the drag')
  assert.near((await picture()).x, p.x, 1, 'a dropped drag does not move the picture')
  await pointerInput('mouseReleased', cx + 80, cy, 'pen')
  await penTool()
  const before = await strokeCount()
  await drawStroke(700, 'pen')
  assert.equal(await strokeCount(), before + 1, 'drawing works again')
})

await test('Ask NOVA sends with no note, keeps the keyboard away, and sends a note when there is one', async () => {
  await drawStroke(500, 'pen')
  await clickSel('#ask-button'); await sleep(300)
  assert.equal(await evaluate('document.getElementById("sheet").hidden'), false, 'the sheet opens')
  assert.equal(await evaluate('document.activeElement && document.activeElement.tagName === "TEXTAREA"'), false, 'the note box is not focused, so no keyboard pops up')
  assert.ok((await evaluate('document.getElementById("sheet").textContent')).includes('Note (optional)'), 'the note is labelled optional')
  await evaluate('[...document.querySelectorAll("#sheet .segmented button")].find(b => /check/i.test(b.textContent)).click()')
  const send = () => evaluate('[...document.querySelectorAll("#sheet button")].find(b => b.textContent.trim() === "Send").click()')
  await send(); await sleep(800)
  let log = await json('window.novaAskLog')
  assert.equal(log.length, 1, 'one message was sent')
  const text = log[0].content.find(c => c.type === 'text').text
  assert.ok(/added no note/.test(text), 'the message says there was no note')
  assert.ok(log[0].content.some(c => c.type === 'image'), 'the screenshot is attached')
  await evaluate('(() => { const t = document.querySelector("#sheet textarea"); t.value = "Is my sketch right?"; t.dispatchEvent(new Event("input", { bubbles: true })) })()')
  await send(); await sleep(800)
  log = await json('window.novaAskLog')
  assert.equal(log.length, 2, 'a second message was sent')
  assert.ok(log[1].content.find(c => c.type === 'text').text.includes('Is my sketch right?'), 'the note is in the message')
})

await test('Ask NOVA with nothing on screen refuses instead of sending', async () => {
  await clickSel('#ask-button'); await sleep(300)
  await evaluate('[...document.querySelectorAll("#sheet button")].find(b => b.textContent.trim() === "Send").click()'); await sleep(500)
  assert.equal((await json('window.novaAskLog')).length, 0, 'nothing was sent')
  assert.ok(/no work on screen/i.test(await evaluate('document.querySelector("#sheet .ask-result").textContent')), 'the sheet says why')
})

const sheetButton = label => evaluate('[...document.querySelectorAll("#sheet button")].find(b => b.textContent.trim() === ' + JSON.stringify(label) + ').click()')
const barButton = id => evaluate('document.getElementById(' + JSON.stringify(id) + ').click()')
const selCount = () => json('novaSurface.selectionCounts()')
/** A closed loop (pen) around a screen rectangle, ending right where it began. */
const loopAround = (x0, y0, x1, y1) => [...line([x0, y0], [x1, y0], 6), ...line([x1, y0], [x1, y1], 6).slice(1), ...line([x1, y1], [x0, y1], 6).slice(1), ...line([x0, y1], [x0, y0 + 2], 6).slice(1)]

await test('choosing an area: the Ask sheet hands over its note, Whole page covers everything, an empty page refuses', async () => {
  // empty page first
  await clickSel('#ask-button'); await sleep(300)
  await sheetButton('Choose an area'); await sleep(300)
  assert.equal(await evaluate('novaSurface.tool'), 'snip', 'Choose an area starts the snip tool')
  assert.equal(await evaluate('document.getElementById("snip-bar").hidden'), false, 'the snip bar shows')
  await barButton('snip-whole'); await sleep(300)
  assert.ok(/empty/i.test(await evaluate('document.getElementById("snip-result").textContent')), 'an empty page cannot be taken whole')
  const widths = await json('[...document.querySelectorAll("#snip-bar button")].map(b => [b.textContent.trim(), Math.round(b.getBoundingClientRect().width), b.scrollWidth > b.clientWidth + 1])')
  assert.ok(widths.every(([, w, clipped]) => w >= 60 && !clipped), 'snip bar buttons are wide enough for their words: ' + JSON.stringify(widths))
  await drag(line([300, 300], [500, 450]), 'pen'); await sleep(200)
  assert.equal(await evaluate('document.getElementById("snip-result").textContent'), '', 'the old warning goes away once the rectangle changes')
  await barButton('snip-cancel'); await sleep(200)
  assert.equal(await evaluate('novaSurface.tool'), 'select', 'cancel leaves the snip tool')
  assert.equal(await evaluate('document.getElementById("snip-bar").hidden'), true, 'and hides the bar')
  // two strokes far apart, then look at only one of them
  await penTool()
  await drag(line([200, 400], [300, 450]), 'pen')
  await evaluate('novaSurface.setCamera({ x: 3000, y: 2000, z: 1 })'); await sleep(200)
  await drag(line([300, 300], [400, 360]), 'pen')
  assert.equal(await strokeCount(), 2, 'two strokes, thousands of units apart')
  await evaluate('novaSurface.setCamera({ x: 3000, y: 2000, z: 1 })'); await sleep(200)
  const before = await camera()
  await clickSel('#ask-button'); await sleep(300)
  await evaluate('(() => { const t = document.querySelector("#sheet textarea"); t.value = "Check this page"; t.dispatchEvent(new Event("input", { bubbles: true })) })()')
  await sheetButton('Choose an area'); await sleep(300)
  assert.ok((await evaluate('document.getElementById("snip-note").textContent')).includes('Check this page'), 'the note carries over to the snip bar')
  await barButton('snip-whole'); await sleep(300)
  assert.equal(await evaluate('novaSurface.snipIsWholePage'), true, 'Whole page selects the whole page')
  await barButton('snip-send'); await sleep(3000)
  const log = await json('window.novaAskLog')
  assert.equal(log.length, 1, 'one message was sent')
  const text = log[0].content.find(c => c.type === 'text').text
  assert.ok(text.includes('"scope":"page"'), 'it says it is the whole page')
  assert.ok(text.includes('Check this page'), 'the note is in the message')
  assert.ok(/"shown":\{"strokes":2,/.test(text), 'both strokes are counted, not only the one in view')
  assert.ok(log[0].content.some(c => c.type === 'image' && c.bytes > 1000), 'the picture is attached')
  assert.equal(await evaluate('novaSurface.tool'), 'snip', 'the snip bar stays open after sending')
  assert.deepEqual(await camera(), before, 'the camera did not move')
  await barButton('snip-cancel'); await sleep(200)
  const size = await jsonAsync('(async () => { const bitmap = await createImageBitmap(await novaSurface.exportPage()); return [bitmap.width, bitmap.height] })()')
  assert.ok(Math.max(...size) <= 4000 && Math.max(...size) > 1000, 'a large page fills most of the allowed size (' + size + ')')
  assert.ok(size[0] > size[1], 'the page is wider than tall, like its content')
})

await test('the snip tool on the rail: drag a rectangle round part of the page and send just that', async () => {
  const c0 = await camera()
  await drag(line([200, 400], [300, 450]), 'pen')                       // A, inside what we will snip
  await evaluate('novaSurface.setCamera({ x: ' + (c0.x + 3000) + ', y: ' + c0.y + ', z: ' + c0.z + ' })'); await sleep(200)
  await drag(line([300, 300], [400, 360]), 'pen')                       // B, far away
  await evaluate('novaSurface.setCamera({ x: ' + c0.x + ', y: ' + c0.y + ', z: ' + c0.z + ' })'); await sleep(200)
  await clickSel('button[data-tool="snip"]'); await sleep(300)
  assert.equal(await evaluate('novaSurface.tool'), 'snip', 'the rail button starts snipping')
  assert.equal(await evaluate('document.getElementById("snip-bar").hidden'), false, 'the snip bar shows')
  await drag(line([150, 350], [380, 520]), 'pen'); await sleep(200)
  const area = await json('novaSurface.snipArea')
  assert.ok(area && area.maxX - area.minX > 150 && area.maxX - area.minX < 300, 'a rectangle was chosen (' + JSON.stringify(area) + ')')
  assert.equal(await evaluate('novaSurface.snipIsWholePage'), false, 'it is not the whole page')
  await barButton('snip-send'); await sleep(3000)
  const log = await json('window.novaAskLog')
  assert.equal(log.length, 1, 'one message was sent')
  const text = log[0].content.find(c => c.type === 'text').text
  assert.ok(text.includes('"scope":"area"'), 'it says it is a chosen area (' + text.slice(0, 200) + ')')
  assert.ok(/"shown":\{"strokes":1,/.test(text), 'only the stroke inside the area is counted')
  assert.ok(log[0].content.some(c => c.type === 'image' && c.bytes > 500), 'the picture is attached')
  await barButton('snip-cancel'); await sleep(200)
})

await test('lasso: a freehand loop or a box picks what it touches; move, duplicate, recolour, delete, all undoable', async () => {
  await drawStroke(300, 'pen'); await drawStroke(340, 'pen'); await drawStroke(600, 'pen')
  assert.equal(await strokeCount(), 3, 'three strokes')
  await selectTool()
  await drag(loopAround(170, 270, 350, 390), 'pen'); await sleep(150)
  assert.deepEqual(await selCount(), { strokes: 2, images: 0 }, 'the loop picked the two strokes inside it, not the far one')
  assert.equal(await evaluate('document.getElementById("selection-bar").hidden'), false, 'the selection bar shows')
  assert.ok((await evaluate('document.getElementById("selection-label").textContent')).includes('2 strokes'), 'it says how many')
  // move: drag from inside the frame
  const frame = await json('novaSurface.selectionBox')
  const [fx, fy] = await toScreen(frame.x + frame.w / 2, frame.y + frame.h / 2)
  await drag(line([fx, fy], [fx + 100, fy + 20]), 'pen'); await sleep(150)
  const moved = await json('novaSurface.selectionBox')
  assert.near(moved.x - frame.x, 100, 3, 'the selection moved sideways')
  assert.equal(await strokeCount(), 3, 'moving does not add strokes')
  await clickSel('#undo'); await sleep(100)
  await drag(loopAround(170, 270, 350, 390), 'pen'); await sleep(150)
  assert.near((await json('novaSurface.selectionBox')).x, frame.x, 1, 'undo put the whole selection back in one step')
  // a finger can move the selection too
  const [gx, gy] = await toScreen(frame.x + frame.w / 2, frame.y + frame.h / 2)
  await finger(line([gx, gy], [gx - 40, gy + 30])); await sleep(150)
  assert.near((await json('novaSurface.selectionBox')).x - frame.x, -40, 3, 'a finger moves the selection')
  await clickSel('#undo'); await sleep(100)
  await drag(loopAround(170, 270, 350, 390), 'pen'); await sleep(150)
  // duplicate, then delete the copies
  await barButton('sel-duplicate'); await sleep(150)
  assert.equal(await strokeCount(), 5, 'copy adds two strokes')
  assert.deepEqual(await selCount(), { strokes: 2, images: 0 }, 'the copies are selected')
  await barButton('sel-delete'); await sleep(150)
  assert.equal(await strokeCount(), 3, 'delete removes the selection')
  await clickSel('#undo'); await sleep(100)
  assert.equal(await strokeCount(), 5, 'undo brings the copies back')
  await clickSel('#undo'); await sleep(100)
  assert.equal(await strokeCount(), 3, 'undo takes the copy away again')
  // recolour
  await drag(loopAround(170, 270, 350, 390), 'pen'); await sleep(150)
  assert.equal((await selCount()).strokes, 2, 'selected again')
  await clickSel('#sel-style'); await sleep(250)
  const swatch = await json('(() => { const b = document.querySelectorAll("#preset-editor .palette button")[3]; return b ? b.dataset.color : null })()')
  assert.ok(swatch, 'the color popover shows swatches')
  await clickSel('#preset-editor .palette button:nth-child(4)'); await sleep(150)
  assert.equal(await evaluate('novaSurface.selectionStyle && novaSurface.selectionStyle.color'), swatch, 'the selected ink changed color')
  // box mode
  await click(900, 650); await sleep(100)
  await clickSel('button[data-tool="select"]'); await sleep(250)
  assert.equal(await evaluate('document.getElementById("select-flyout").hidden'), false, 'tapping select again offers loop or box')
  await clickSel('#shape-box'); await sleep(150)
  assert.equal(await evaluate('novaSurface.lassoShape'), 'box', 'box mode is on')
  await drag(line([150, 560], [400, 680]), 'pen'); await sleep(150)
  assert.deepEqual(await selCount(), { strokes: 1, images: 0 }, 'a box picks the far stroke')
  await clickSel('#sel-done'); await sleep(150)
  assert.equal(await evaluate('novaSurface.tool'), 'pen', 'Done returns to the pen')
  assert.equal((await selCount()).strokes, 0, 'and clears the selection')
})

await test('lasso over writing on a picture picks the writing, not the picture; Ask NOVA about the selection', async () => {
  await insertPicture()
  await penTool()
  const p = await picture()
  const [px, py] = await toScreen(p.x, p.y)
  await drag(line([px + 15, py + 15], [px + 60, py + 30]), 'pen')       // writing near the picture's corner
  assert.equal(await strokeCount(), 1, 'a stroke on the picture')
  await selectTool()
  await drag(loopAround(px + 4, py + 4, px + 80, py + 50), 'pen'); await sleep(150)
  assert.deepEqual(await selCount(), { strokes: 1, images: 0 }, 'only the writing is picked')
  const after = await picture()
  assert.near(after.x, p.x, 0.5, 'the picture did not move')
  await barButton('sel-ask'); await sleep(300)
  await evaluate('[...document.querySelectorAll("#sheet .segmented button")].find(b => /check/i.test(b.textContent)).click()')
  assert.ok((await evaluate('document.getElementById("sheet").textContent')).includes('Your selection'), 'the sheet offers the selection')
  await sheetButton('Send'); await sleep(2500)
  const log = await json('window.novaAskLog')
  assert.equal(log.length, 1, 'one message was sent')
  const text = log[0].content.find(c => c.type === 'text').text
  assert.ok(text.includes('"scope":"selection"') && /"shown":\{"strokes":1,"pictures":0/.test(text), 'it is about the selection only (' + text.slice(0, 220) + ')')
  assert.ok(log[0].content.some(c => c.type === 'image'), 'the picture is attached')
})

await test('the tool rail: second tap opens the pen options, hide and show persist', async () => {
  await clickSel('button[data-tool="pen"]'); await sleep(250)
  assert.equal(await evaluate('document.getElementById("pen-flyout").hidden'), false, 'tapping the pen again opens width and colour')
  await clickSel('#width-slots button:nth-child(3)'); await sleep(150)
  await click(900, 650); await sleep(250)
  assert.equal(await evaluate('document.getElementById("pen-flyout").hidden'), true, 'tapping the paper closes it')
  await clickSel('#rail-collapse'); await sleep(250)
  assert.equal(await evaluate('document.getElementById("rail").hidden'), true, 'the rail hides')
  assert.equal(await evaluate('document.getElementById("rail-handle").hidden'), false, 'a handle is left to bring it back')
  await send('Page.reload'); await sleep(2500)
  assert.equal(await evaluate('document.getElementById("rail").hidden'), true, 'it stays hidden after a reload')
  await clickSel('#rail-expand'); await sleep(250)
  assert.equal(await evaluate('document.getElementById("rail").hidden'), false, 'it comes back')
  const boxes = await json(`['#rail', '.corner', '.status'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, r.left, r.top, r.right, r.bottom] })`)
  const rail = boxes[0], corner = boxes[1]
  assert.ok(rail[3] <= corner[1] || rail[4] <= corner[2] || corner[3] <= rail[1] || corner[4] <= rail[2], 'the rail and the top-right buttons do not overlap')
})

// ---- report ----

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
await shutdown(failed.length ? 1 : 0)
