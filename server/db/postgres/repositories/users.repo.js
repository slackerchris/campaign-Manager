import { db } from '../pool.js'

export async function findUserById(id) {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function findUserByUsername(username) {
  return db.selectFrom('users').selectAll().where('username', '=', username).executeTakeFirst()
}

export async function listUsers() {
  return db.selectFrom('users').selectAll().orderBy('created_at', 'asc').execute()
}

export async function createUser({ id, username, displayName, email, role, passwordHash, passwordSalt }) {
  const now = new Date()
  return db
    .insertInto('users')
    .values({
      ...(id ? { id } : {}),
      username,
      display_name: displayName,
      email: email || null,
      role,
      password_hash: passwordHash,
      password_salt: passwordSalt,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function updateUserRole({ userId, role }) {
  return db
    .updateTable('users')
    .set({ role, updated_at: new Date() })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirst()
}

export async function updateUserPassword({ userId, passwordHash, passwordSalt }) {
  return db
    .updateTable('users')
    .set({ password_hash: passwordHash, password_salt: passwordSalt, updated_at: new Date() })
    .where('id', '=', userId)
    .returningAll()
    .executeTakeFirst()
}

export async function deleteUser(userId) {
  return db.deleteFrom('users').where('id', '=', userId).executeTakeFirst()
}
