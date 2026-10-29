// Runs the bundled Worker (dist/index.js, built by `wrangler deploy --dry-run`) in local workerd via Miniflare 4,
// with Durable Object storage persisted to a directory so a real process restart can be tested.
// (Miniflare 4 is installed as the `miniflare4` alias: the 5.x beta used by wrangler has a different, unstable options shape.)
import { Miniflare } from 'miniflare4'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function startWorker(persist) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: path.join(root, 'dist', 'index.js'),
    compatibilityDate: '2026-07-01',
    durableObjects: { CANVAS: { className: 'CanvasDO', useSQLite: true } },
    durableObjectsPersist: persist,
  })
  await mf.ready
  const call = async (op, id, body) => {
    const res = await mf.dispatchFetch(`http://spike.test/api/canvas/${id}/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}) })
    return res.json()
  }
  return { mf, call, dispose: () => mf.dispose() }
}
