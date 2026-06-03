import { db } from '../pool.js'

export async function createServerInvite({ token, role, createdByUserId, expiresAt }) {
  return db
    .insertInto('server_invites')
    .values({
      token,
      role,
      created_by_user_id: createdByUserId || null,
      expires_at: expiresAt,
      created_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function findServerInvite(token) {
  return db.selectFrom('server_invites').selectAll().where('token', '=', token).executeTakeFirst()
}

export async function consumeServerInvite({ token, consumedByUserId }) {
  return db
    .updateTable('server_invites')
    .set({ consumed_at: new Date(), consumed_by_user_id: consumedByUserId })
    .where('token', '=', token)
    .returningAll()
    .executeTakeFirst()
}

export async function deleteServerInvite(token) {
  return db.deleteFrom('server_invites').where('token', '=', token).executeTakeFirst()
}

export async function listServerInvites() {
  return db
    .selectFrom('server_invites')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute()
}
