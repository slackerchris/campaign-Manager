#!/usr/bin/env node
/**
 * One-time migration: admin-auth.json → Postgres users/sessions/server_invites
 *
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING.
 * Does NOT migrate sessions (everyone re-logs in after migration).
 * Admin gets a new UUID; campaign-level server_user_id links are updated in PR 3.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db } from '../server/db/postgres/pool.js'

const DATA_DIR = process.env.DATA_DIR || './data'
const AUTH_FILE = path.join(DATA_DIR, 'secrets', 'admin-auth.json')

async function readAuthFile() {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function run() {
  const auth = await readAuthFile()
  if (!auth) {
    console.log('No admin-auth.json found — nothing to migrate.')
    return
  }

  let migrated = { users: 0, invites: 0 }

  // ── Admin user ──────────────────────────────────────────────────────────────
  if (auth.admin) {
    const a = auth.admin
    const now = new Date()
    await db
      .insertInto('users')
      .values({
        username: a.username,
        display_name: a.displayName || 'Admin',
        role: 'admin',
        password_hash: a.passwordHash,
        password_salt: a.salt,
        created_at: a.createdAt ? new Date(a.createdAt) : now,
        updated_at: a.updatedAt ? new Date(a.updatedAt) : now,
      })
      .onConflict((oc) => oc.column('username').doNothing())
      .execute()
    migrated.users++
    console.log(`  ✓ Admin user: ${a.username}`)
  }

  // ── Regular users ───────────────────────────────────────────────────────────
  for (const u of auth.users ?? []) {
    const now = new Date()
    await db
      .insertInto('users')
      .values({
        id: isUUID(u.id) ? u.id : undefined,
        username: u.username,
        display_name: u.displayName || u.username,
        email: u.email || null,
        role: u.role || 'player',
        password_hash: u.passwordHash,
        password_salt: u.salt,
        created_at: u.createdAt ? new Date(u.createdAt) : now,
        updated_at: u.updatedAt ? new Date(u.updatedAt) : now,
      })
      .onConflict((oc) => oc.column('username').doNothing())
      .execute()
    migrated.users++
    console.log(`  ✓ User: ${u.username} (${u.role})`)
  }

  // ── Server invites (unconsumed only) ────────────────────────────────────────
  for (const i of auth.invites ?? []) {
    if (i.consumedAt) continue
    if (Number(i.expiresAt || 0) < Date.now()) continue
    await db
      .insertInto('server_invites')
      .values({
        token: i.token,
        role: i.role || 'dm',
        created_at: i.createdAt ? new Date(i.createdAt) : new Date(),
        expires_at: new Date(i.expiresAt),
      })
      .onConflict((oc) => oc.column('token').doNothing())
      .execute()
    migrated.invites++
    console.log(`  ✓ Invite: ${i.token.slice(0, 8)}… (${i.role})`)
  }

  console.log(`\nDone. Migrated ${migrated.users} user(s), ${migrated.invites} invite(s).`)
  console.log('Sessions were not migrated — all users will need to log in again.')
  console.log(`\nThe original ${AUTH_FILE} has not been deleted.`)
  console.log('Once you have verified login works, you can remove it.')
}

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
}

run()
  .catch((err) => { console.error('Migration failed:', err.message); process.exit(1) })
  .finally(() => db.destroy())
