#!/usr/bin/env node
/**
 * One-time migration: campaign directories → Postgres campaigns/members/campaign_invites
 *
 * Reads each data/campaigns/<slug>/meta.json and campaign.sqlite.
 * Maps campaign SQLite users (via server_user_id) to Postgres users.
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { db } from '../server/db/postgres/pool.js'

const DATA_DIR = process.env.DATA_DIR || './data'
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns')

async function run() {
  const entries = await fs.readdir(CAMPAIGNS_DIR, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory() && !/\.pre-sync-\d+$|^backup-clear-\d+$/.test(e.name))

  console.log(`Found ${dirs.length} campaign director${dirs.length === 1 ? 'y' : 'ies'}.`)

  for (const dir of dirs) {
    const slug = dir.name
    const base = path.join(CAMPAIGNS_DIR, slug)
    const metaPath = path.join(base, 'meta.json')

    let meta
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    } catch {
      console.warn(`  ⚠ Skipping ${slug} — no readable meta.json`)
      continue
    }

    if (!meta.name) {
      console.warn(`  ⚠ Skipping ${slug} — meta.json missing name`)
      continue
    }

    // Resolve owner to a Postgres user UUID
    const ownerRow = meta.ownerUserId
      ? await db.selectFrom('users').select('id').where('id', '=', meta.ownerUserId).executeTakeFirst()
      : null

    if (!ownerRow) {
      console.warn(`  ⚠ Skipping ${slug} — owner user ${meta.ownerUserId} not found in Postgres (run auth migration first)`)
      continue
    }

    // Insert campaign
    const [campaign] = await db
      .insertInto('campaigns')
      .values({
        slug,
        name: meta.name,
        owner_user_id: ownerRow.id,
        owner_display_name: meta.ownerDisplayName || 'DM',
        created_at: meta.createdAt ? new Date(meta.createdAt) : new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: meta.name, updated_at: new Date() }))
      .returningAll()
      .execute()

    console.log(`  ✓ Campaign: ${slug} (${campaign.id})`)

    // Add DM as member
    await db
      .insertInto('campaign_members')
      .values({ campaign_id: campaign.id, user_id: ownerRow.id, display_name: meta.ownerDisplayName || 'DM', role: 'dm', joined_at: new Date() })
      .onConflict((oc) => oc.columns(['campaign_id', 'user_id']).doNothing())
      .execute()

    // Read campaign SQLite and migrate members
    const sqlitePath = path.join(base, 'campaign.sqlite')
    let sqliteDb
    try {
      sqliteDb = new DatabaseSync(sqlitePath)
    } catch {
      console.log(`    (no campaign.sqlite — skipping member migration)`)
      continue
    }

    // Migrate users who have a server_user_id (i.e. linked server accounts)
    let members
    try {
      members = sqliteDb.prepare('SELECT * FROM users WHERE server_user_id IS NOT NULL').all()
    } catch {
      members = []
    }

    for (const m of members) {
      const pgUser = await db.selectFrom('users').select('id').where('id', '=', m.server_user_id).executeTakeFirst()
      if (!pgUser) {
        console.warn(`    ⚠ Member ${m.display_name} (server_user_id=${m.server_user_id}) not in Postgres — skipping`)
        continue
      }
      await db
        .insertInto('campaign_members')
        .values({ campaign_id: campaign.id, user_id: pgUser.id, display_name: m.display_name || 'Player', role: m.role || 'player', joined_at: new Date() })
        .onConflict((oc) => oc.columns(['campaign_id', 'user_id']).doNothing())
        .execute()
      console.log(`    ✓ Member: ${m.display_name} (${m.role})`)
    }

    sqliteDb.close()
  }

  console.log('\nDone. Campaign directories and meta.json files have not been deleted.')
  console.log('Verify the app works, then you can clean them up in a later PR.')
}

run()
  .catch((err) => { console.error('Migration failed:', err.message); process.exit(1) })
  .finally(() => db.destroy())
