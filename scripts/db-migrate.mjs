#!/usr/bin/env node
import { db } from '../server/db/postgres/pool.js'
import { migrateToLatest, getMigrationStatus } from '../server/db/postgres/migrate.js'

const command = process.argv[2] || 'up'

try {
  if (command === 'status') {
    const status = await getMigrationStatus(db)
    console.log(`Migrations: ${status.executed} executed, ${status.pending} pending`)
    if (status.pendingNames.length) console.log('Pending:', status.pendingNames.join(', '))
  } else if (command === 'up') {
    console.log('Running migrations...')
    const results = await migrateToLatest(db)
    if (results.length === 0) console.log('Already up to date.')
    else console.log(`Applied ${results.length} migration(s).`)
  } else {
    console.error(`Unknown command: ${command}. Use 'up' or 'status'.`)
    process.exit(1)
  }
} catch (err) {
  console.error('Migration failed:', err.message)
  process.exit(1)
} finally {
  await db.destroy()
}
