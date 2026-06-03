import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { db } from '../db/postgres/pool.js'
import * as usersRepo from '../db/postgres/repositories/users.repo.js'
import * as sessionsRepo from '../db/postgres/repositories/sessions.repo.js'
import * as invitesRepo from '../db/postgres/repositories/server-invites.repo.js'

const scrypt = promisify(crypto.scrypt)
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(String(password || ''), salt, 64)
  return { salt, passwordHash: derived.toString('hex') }
}

function timingSafeEqual(a, b) {
  try {
    const aBuf = Buffer.from(String(a || ''), 'hex')
    const bBuf = Buffer.from(String(b || ''), 'hex')
    return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf)
  } catch {
    return false
  }
}

function validateAccountInput({ username, password, defaultUsername = 'admin' }) {
  const normalizedUsername = String(username || defaultUsername).trim().toLowerCase()
  if (!/^[a-z0-9_.-]{3,40}$/.test(normalizedUsername)) {
    const err = new Error('Username must be 3-40 characters: letters, numbers, dot, dash, or underscore')
    err.statusCode = 400
    throw err
  }
  if (String(password || '').length < 8) {
    const err = new Error('Password must be at least 8 characters')
    err.statusCode = 400
    throw err
  }
  return normalizedUsername
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  }
}

function publicInvite(invite) {
  return {
    token: invite.token,
    role: invite.role,
    createdAt: invite.created_at,
    expiresAt: invite.expires_at,
    consumedAt: invite.consumed_at || null,
    consumedByUserId: invite.consumed_by_user_id || null,
  }
}

async function issueSession(user, role) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await sessionsRepo.createSession({ token, userId: user.id, role, expiresAt })
  // Non-blocking expired session cleanup
  sessionsRepo.deleteExpiredSessions().catch(() => {})
  return { token, userId: user.id, role, displayName: user.display_name, expiresAt: expiresAt.getTime() }
}

// ── Admin account ─────────────────────────────────────────────────────────────

export async function getAdminStatus() {
  const admin = await db.selectFrom('users').select('id').where('role', '=', 'admin').executeTakeFirst()
  return { hasAdmin: !!admin }
}

export async function createInitialAdmin({ username = 'admin', displayName = 'Admin', password }) {
  const existing = await db.selectFrom('users').select('id').where('role', '=', 'admin').executeTakeFirst()
  if (existing) {
    const err = new Error('Admin account already exists')
    err.statusCode = 403
    throw err
  }
  const normalizedUsername = validateAccountInput({ username, password })
  const { salt, passwordHash } = await hashPassword(password)
  const user = await usersRepo.createUser({
    username: normalizedUsername,
    displayName: String(displayName || 'Admin').trim() || 'Admin',
    role: 'admin',
    passwordHash,
    passwordSalt: salt,
  })
  return { id: user.id, username: user.username, displayName: user.display_name }
}

export async function resetAdminPassword({ password }) {
  const admin = await db.selectFrom('users').selectAll().where('role', '=', 'admin').executeTakeFirst()
  if (!admin) {
    const err = new Error('Admin account does not exist')
    err.statusCode = 404
    throw err
  }
  validateAccountInput({ username: admin.username, password })
  const { salt, passwordHash } = await hashPassword(password)
  await usersRepo.updateUserPassword({ userId: admin.id, passwordHash, passwordSalt: salt })
  await sessionsRepo.deleteSessionsByUserId(admin.id)
  return { id: admin.id, username: admin.username, displayName: admin.display_name }
}

export async function loginAdmin({ username, password }) {
  const admin = await db.selectFrom('users').selectAll().where('role', '=', 'admin').executeTakeFirst()
  if (!admin) {
    const err = new Error('Admin account has not been created')
    err.statusCode = 404
    throw err
  }
  const normalizedUsername = String(username || '').trim().toLowerCase()
  if (normalizedUsername !== admin.username) {
    const err = new Error('Invalid admin credentials')
    err.statusCode = 401
    throw err
  }
  const attempted = await hashPassword(password, admin.password_salt)
  if (!timingSafeEqual(attempted.passwordHash, admin.password_hash)) {
    const err = new Error('Invalid admin credentials')
    err.statusCode = 401
    throw err
  }
  return issueSession(admin, 'admin')
}

// ── Server users ──────────────────────────────────────────────────────────────

export async function listServerUsers() {
  const users = await usersRepo.listUsers()
  return users.map(publicUser)
}

export async function createServerUser({ username, displayName, password, role = 'dm' }) {
  const normalizedRole = String(role || 'dm').trim().toLowerCase()
  if (!['dm', 'player'].includes(normalizedRole)) {
    const err = new Error('Role must be dm or player')
    err.statusCode = 400
    throw err
  }
  const normalizedUsername = validateAccountInput({ username, password, defaultUsername: '' })
  const existing = await usersRepo.findUserByUsername(normalizedUsername)
  if (existing) {
    const err = new Error('Username already exists')
    err.statusCode = 409
    throw err
  }
  const { salt, passwordHash } = await hashPassword(password)
  const user = await usersRepo.createUser({
    username: normalizedUsername,
    displayName: String(displayName || username || '').trim() || normalizedUsername,
    role: normalizedRole,
    passwordHash,
    passwordSalt: salt,
  })
  return publicUser(user)
}

export async function loginServerUser({ username, password }) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  const user = await usersRepo.findUserByUsername(normalizedUsername)
  if (!user || user.role === 'admin') {
    const err = new Error('Invalid credentials')
    err.statusCode = 401
    throw err
  }
  const attempted = await hashPassword(password, user.password_salt)
  if (!timingSafeEqual(attempted.passwordHash, user.password_hash)) {
    const err = new Error('Invalid credentials')
    err.statusCode = 401
    throw err
  }
  return issueSession(user, user.role)
}

export async function registerServerUser({ username, displayName, email, password }) {
  const normalizedUsername = validateAccountInput({ username, password, defaultUsername: '' })
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const err = new Error('Invalid email address')
    err.statusCode = 400
    throw err
  }
  const existing = await usersRepo.findUserByUsername(normalizedUsername)
  if (existing) {
    const err = new Error('Username already taken')
    err.statusCode = 409
    throw err
  }
  const { salt, passwordHash } = await hashPassword(password)
  const user = await usersRepo.createUser({
    username: normalizedUsername,
    displayName: String(displayName || username || '').trim() || normalizedUsername,
    email: normalizedEmail || null,
    role: 'player',
    passwordHash,
    passwordSalt: salt,
  })
  return issueSession(user, 'player')
}

export async function updateServerUserRole({ userId, role }) {
  const normalizedRole = String(role || '').trim().toLowerCase()
  if (!['dm', 'player'].includes(normalizedRole)) {
    const err = new Error('Role must be dm or player')
    err.statusCode = 400
    throw err
  }
  const user = await usersRepo.updateUserRole({ userId, role: normalizedRole })
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
  await sessionsRepo.deleteSessionsByUserId(userId)
  return publicUser(user)
}

export async function deleteServerUser({ userId }) {
  const result = await usersRepo.deleteUser(userId)
  if (!result?.numDeletedRows || result.numDeletedRows === 0n) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
}

export async function resetServerUserPassword({ userId, password }) {
  const user = await usersRepo.findUserById(userId)
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
  validateAccountInput({ username: user.username, password })
  const { salt, passwordHash } = await hashPassword(password)
  const updated = await usersRepo.updateUserPassword({ userId, passwordHash, passwordSalt: salt })
  await sessionsRepo.deleteSessionsByUserId(userId)
  return publicUser(updated)
}

export async function revokeServerUserSessions({ userId }) {
  const result = await sessionsRepo.deleteSessionsByUserId(userId)
  return { revoked: Number(result?.numDeletedRows ?? 0) }
}

// ── Server invites ────────────────────────────────────────────────────────────

export async function listServerInvites() {
  const invites = await invitesRepo.listServerInvites()
  return invites.map(publicInvite)
}

export async function createServerInvite({ role = 'dm', createdByUserId = null }) {
  const normalizedRole = String(role || 'dm').trim().toLowerCase()
  if (!['dm', 'player'].includes(normalizedRole)) {
    const err = new Error('Role must be dm or player')
    err.statusCode = 400
    throw err
  }
  const invite = await invitesRepo.createServerInvite({
    token: crypto.randomBytes(16).toString('hex'),
    role: normalizedRole,
    createdByUserId: createdByUserId || null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
  })
  return publicInvite(invite)
}

export async function acceptServerInvite({ inviteToken, username, displayName, password }) {
  const token = String(inviteToken || '').trim()
  const normalizedUsername = validateAccountInput({ username, password, defaultUsername: '' })

  const existing = await usersRepo.findUserByUsername(normalizedUsername)
  if (existing) {
    const err = new Error('Username already exists')
    err.statusCode = 409
    throw err
  }

  const { salt, passwordHash } = await hashPassword(password)
  let newUser = null

  await db.transaction().execute(async (trx) => {
    const invite = await trx
      .selectFrom('server_invites')
      .selectAll()
      .where('token', '=', token)
      .forUpdate()
      .executeTakeFirst()

    if (!invite) { const e = new Error('Invalid invite'); e.statusCode = 400; throw e }
    if (invite.consumed_at) { const e = new Error('Invite already used'); e.statusCode = 400; throw e }
    if (invite.expires_at < new Date()) { const e = new Error('Invite expired'); e.statusCode = 400; throw e }

    const now = new Date()
    newUser = await trx
      .insertInto('users')
      .values({
        username: normalizedUsername,
        display_name: String(displayName || username || '').trim() || normalizedUsername,
        role: invite.role,
        password_hash: passwordHash,
        password_salt: salt,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await trx
      .updateTable('server_invites')
      .set({ consumed_at: now, consumed_by_user_id: newUser.id })
      .where('token', '=', token)
      .execute()
  })

  return issueSession(newUser, newUser.role)
}

export async function deleteServerInvite({ token }) {
  const result = await invitesRepo.deleteServerInvite(String(token || '').trim())
  if (!result?.numDeletedRows || result.numDeletedRows === 0n) {
    const err = new Error('Invite not found')
    err.statusCode = 404
    throw err
  }
}

// ── Session validation (called by auth middleware on every request) ────────────

export async function validateAdminSession(token) {
  const session = await sessionsRepo.findValidSession(token)
  if (!session) return null
  return {
    id: session.id,
    role: session.role,
    displayName: session.display_name,
    admin: session.role === 'admin',
  }
}

// ── Combined login (tries admin first, then regular user) ─────────────────────

export async function loginAnyUser({ username, password }) {
  try {
    return await loginAdmin({ username, password })
  } catch (err) {
    if (![401, 404].includes(Number(err?.statusCode))) throw err
  }
  return loginServerUser({ username, password })
}
