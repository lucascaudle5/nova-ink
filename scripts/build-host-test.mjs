// Temporary development-mode build for local evaluation only; not a production license.
import { spawnSync } from 'node:child_process'
const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const outcome = spawnSync(cmd, ['run', 'build'], {
  env: { ...process.env, NODE_ENV: 'development' },
  stdio: 'inherit', shell: process.platform === 'win32',
})
if (outcome.error) { console.error(outcome.error); process.exit(1) }
process.exit(outcome.status ?? 1)
