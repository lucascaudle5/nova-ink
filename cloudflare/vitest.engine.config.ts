import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-plugin'

export default defineConfig({
  // remoteBindings off: tests never reach the real Workers AI; transcription is tested with a fake.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.engine.jsonc' }, remoteBindings: false })],
  test: { include: ['test/engine/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
})
