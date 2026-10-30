import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-plugin'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.engine.jsonc' } })],
  test: { include: ['test/engine/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
})
