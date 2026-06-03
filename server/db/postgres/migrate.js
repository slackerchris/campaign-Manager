import { Migrator, FileMigrationProvider } from 'kysely/migration'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

function makeMigrator(db) {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: migrationsDir }),
  })
}

export async function migrateToLatest(db) {
  const migrator = makeMigrator(db)
  const { error, results } = await migrator.migrateToLatest()

  for (const result of results ?? []) {
    if (result.status === 'Success') console.log(`  ✓ ${result.migrationName}`)
    else if (result.status === 'Error') console.error(`  ✗ ${result.migrationName}`)
  }

  if (error) throw error
  return results ?? []
}

export async function getMigrationStatus(db) {
  const migrator = makeMigrator(db)
  const migrations = await migrator.getMigrations()
  const pending = migrations.filter((m) => !m.executedAt)
  const executed = migrations.filter((m) => m.executedAt)
  return { total: migrations.length, executed: executed.length, pending: pending.length, pendingNames: pending.map((m) => m.name) }
}
