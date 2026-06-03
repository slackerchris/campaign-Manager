import { db } from '../pool.js'

export async function createSession({ token, userId, role, expiresAt }) {
  return db
    .insertInto('user_sessions')
    .values({ token, user_id: userId, role, created_at: new Date(), expires_at: expiresAt })
    .returningAll()
    .executeTakeFirstOrThrow()
}

// Returns session joined with user — used by auth middleware
export async function findValidSession(token) {
  return db
    .selectFrom('user_sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['u.id', 'u.role', 'u.display_name', 's.expires_at'])
    .where('s.token', '=', token)
    .where('s.expires_at', '>', new Date())
    .executeTakeFirst()
}

export async function deleteSessionsByUserId(userId) {
  return db.deleteFrom('user_sessions').where('user_id', '=', userId).executeTakeFirst()
}

export async function deleteExpiredSessions() {
  return db.deleteFrom('user_sessions').where('expires_at', '<=', new Date()).executeTakeFirst()
}
