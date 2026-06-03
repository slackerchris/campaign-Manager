import { db } from '../pool.js'

// ── Server settings ───────────────────────────────────────────────────────────

export async function getServerSetting(key) {
  const row = await db.selectFrom('server_settings')
    .where('key', '=', key)
    .select('value')
    .executeTakeFirst()
  return row ? row.value : null
}

export async function setServerSetting(key, value, updatedByUserId = null) {
  await db.insertInto('server_settings')
    .values({ key, value, updated_at: new Date(), updated_by_user_id: updatedByUserId })
    .onConflict((oc) => oc.column('key').doUpdateSet({
      value: (eb) => eb.ref('excluded.value'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
      updated_by_user_id: (eb) => eb.ref('excluded.updated_by_user_id'),
    }))
    .execute()
}

export async function getAllServerSettings() {
  const rows = await db.selectFrom('server_settings').selectAll().execute()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// ── User settings ─────────────────────────────────────────────────────────────

export async function getUserSetting(userId, key) {
  const row = await db.selectFrom('user_settings')
    .where('user_id', '=', userId)
    .where('key', '=', key)
    .select('value')
    .executeTakeFirst()
  return row ? row.value : null
}

export async function setUserSetting(userId, key, value) {
  await db.insertInto('user_settings')
    .values({ user_id: userId, key, value, updated_at: new Date() })
    .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet({
      value: (eb) => eb.ref('excluded.value'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
    }))
    .execute()
}

export async function getAllUserSettings(userId) {
  const rows = await db.selectFrom('user_settings').where('user_id', '=', userId).selectAll().execute()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}
