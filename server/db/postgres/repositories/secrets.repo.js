import { db } from '../pool.js'
import { encrypt, decrypt } from '../../../domain/crypto/secrets.js'

// ── Server secrets ────────────────────────────────────────────────────────────

export async function getServerSecret(key) {
  const row = await db.selectFrom('server_secrets')
    .where('key', '=', key)
    .select('encrypted_value')
    .executeTakeFirst()
  if (!row) return null
  return decrypt(row.encrypted_value)
}

export async function hasServerSecret(key) {
  const row = await db.selectFrom('server_secrets')
    .where('key', '=', key)
    .select('key')
    .executeTakeFirst()
  return !!row
}

export async function setServerSecret(key, plaintext, updatedByUserId = null) {
  const encrypted_value = encrypt(plaintext)
  await db.insertInto('server_secrets')
    .values({ key, encrypted_value, updated_at: new Date(), updated_by_user_id: updatedByUserId })
    .onConflict((oc) => oc.column('key').doUpdateSet({
      encrypted_value: (eb) => eb.ref('excluded.encrypted_value'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
      updated_by_user_id: (eb) => eb.ref('excluded.updated_by_user_id'),
    }))
    .execute()
}

// ── User secrets ──────────────────────────────────────────────────────────────

export async function getUserSecret(userId, key) {
  const row = await db.selectFrom('user_secrets')
    .where('user_id', '=', userId)
    .where('key', '=', key)
    .select('encrypted_value')
    .executeTakeFirst()
  if (!row) return null
  return decrypt(row.encrypted_value)
}

export async function hasUserSecret(userId, key) {
  const row = await db.selectFrom('user_secrets')
    .where('user_id', '=', userId)
    .where('key', '=', key)
    .select('key')
    .executeTakeFirst()
  return !!row
}

export async function setUserSecret(userId, key, plaintext) {
  const encrypted_value = encrypt(plaintext)
  await db.insertInto('user_secrets')
    .values({ user_id: userId, key, encrypted_value, updated_at: new Date() })
    .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet({
      encrypted_value: (eb) => eb.ref('excluded.encrypted_value'),
      updated_at: (eb) => eb.ref('excluded.updated_at'),
    }))
    .execute()
}
