#!/usr/bin/env node
// Usage: npm run backup -- [--out <folder>] [--data <folder>]
// Copies the NOVA Ink data folder into <out>/nova-ink-backup-<time>/ and verifies it. Never modifies the data folder.
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createBackup } from '../backup.mjs'
import { DEFAULT_DATA_DIR } from '../storage.mjs'

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const dataDir = option('--data') ?? DEFAULT_DATA_DIR
const outDir = option('--out') ?? path.join(os.homedir(), 'Documents', 'NOVA-Ink-Backups')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

try {
  const result = await createBackup(dataDir, outDir, { version })
  console.log(`Backup verified: ${result.canvases} canvases, ${result.fileCount} files`)
  console.log(result.dir)
} catch (error) {
  console.error(`Backup failed: ${error.message}`)
  process.exit(1)
}
