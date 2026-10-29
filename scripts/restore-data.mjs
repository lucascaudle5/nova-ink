#!/usr/bin/env node
// Usage: npm run restore -- <backup folder> <empty target folder>
//        npm run restore -- --verify <backup folder>
// Restores only into a missing or empty folder. It never overwrites an existing data directory.
import { restoreBackup, verifyBackup } from '../backup.mjs'

const args = process.argv.slice(2)
try {
  if (args[0] === '--verify' && args[1]) {
    const check = await verifyBackup(args[1])
    if (!check.ok) throw new Error(check.problems.join('; '))
    console.log(`Backup is intact: ${check.canvases} canvases, ${check.info.files.length} files, created ${check.info.createdAt}`)
  } else if (args.length === 2) {
    const result = await restoreBackup(args[0], args[1])
    console.log(`Restored and verified ${result.canvases} canvases into ${result.dir}`)
    console.log('To use it, stop NOVA Ink and start it with NOVA_INK_DATA_DIR set to that folder.')
  } else {
    console.error('Usage: npm run restore -- <backup folder> <empty target folder>\n       npm run restore -- --verify <backup folder>')
    process.exit(2)
  }
} catch (error) {
  console.error(`Restore failed: ${error.message}`)
  process.exit(1)
}
