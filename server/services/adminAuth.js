import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { ADMIN_AUTH_FILE, SECRETS_DIR } from '../config.js'
import { readJson, writeJson } from '../utils.js'

const scrypt = promisify(crypto.scrypt)
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30

async function loadAdminAuth() {
  const auth = await readJson(ADMIN_AUTH_FILE, { admin: null, users: [], invites: [], sessions: [] })
  return {
    admin: auth.admin || null,
    users: Array.isArray(auth.users) ? auth.users : [],
    invites: Array.isArray(auth.invites) ? auth.invites : [],
    sessions: Array.isArray(auth.sessions) ? auth.sessions : [],
  }
}

async function saveAdminAuth(auth) {
  await fs.mkdir(SECRETS_DIR, { recursive: true })
  await writeJson(ADMIN_AUTH_FILE, {
    admin: auth.admin || null,
    users: Array.isArray(auth.users) ? auth.users : [],
    invites: Array.isArray(auth.invites) ? auth.invites : [],
    sessions: Array.isArray(auth.sessions) ? auth.sessions : [],
  })
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(String(password || ''), salt, 64)
  return { salt, passwordHash: derived.toString('hex') }
}

function timingSafeStringEqual(a, b) {
  try {
    const aBuf = Buffer.from(String(a || ''), 'hex')
    const bBuf = Buffer.from(String(b || ''), 'hex')
    return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf)
  } catch {
    return false
  }
}

export async function getAdminStatus() {
  const auth = await loadAdminAuth()
  return {
    hasAdmin: !!auth.admin,
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

export async function createInitialAdmin({ username = 'admin', displayName = 'Admin', password }) {
  const auth = await loadAdminAuth()
  if (auth.admin) {
    const err = new Error('Admin account already exists')
    err.statusCode = 403
    throw err
  }

  const normalizedUsername = validateAccountInput({ username, password })
  const now = Date.now()
  const passwordRecord = await hashPassword(password)
  const next = {
    admin: {
      id: 'server-admin',
      username: normalizedUsername,
      displayName: String(displayName || 'Admin').trim() || 'Admin',
      ...passwordRecord,
      createdAt: now,
      updatedAt: now,
    },
    users: [],
    invites: [],
    sessions: [],
  }
  await saveAdminAuth(next)
  return { id: next.admin.id, username: next.admin.username, displayName: next.admin.displayName }
}

export async function resetAdminPassword({ username = 'admin', displayName = 'Admin', password }) {
  const auth = await loadAdminAuth()
  const normalizedUsername = validateAccountInput({ username, password })
  const now = Date.now()
  const passwordRecord = await hashPassword(password)
  const createdAt = Number(auth.admin?.createdAt || now)

  auth.admin = {
    id: 'server-admin',
    username: normalizedUsername,
    displayName: String(displayName || auth.admin?.displayName || 'Admin').trim() || 'Admin',
    ...passwordRecord,
    createdAt,
    updatedAt: now,
  }
  auth.sessions = []
  await saveAdminAuth(auth)
  return { id: auth.admin.id, username: auth.admin.username, displayName: auth.admin.displayName }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export async function listServerUsers() {
  const auth = await loadAdminAuth()
  return [
    ...(auth.admin ? [{ id: auth.admin.id, username: auth.admin.username, displayName: auth.admin.displayName, role: 'admin', createdAt: auth.admin.createdAt, updatedAt: auth.admin.updatedAt }] : []),
    ...auth.users.map(publicUser),
  ]
}

function publicInvite(invite) {
  return {
    token: invite.token,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt || null,
    consumedByUserId: invite.consumedByUserId || null,
  }
}

export async function listServerInvites() {
  const auth = await loadAdminAuth()
  return auth.invites.map(publicInvite).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

export async function createServerInvite({ role = 'dm', createdByUserId = '' }) {
  const auth = await loadAdminAuth()
  const normalizedRole = String(role || 'dm').trim().toLowerCase()
  if (!['dm', 'player'].includes(normalizedRole)) {
    const err = new Error('Role must be dm or player')
    err.statusCode = 400
    throw err
  }

  const now = Date.now()
  const invite = {
    token: crypto.randomBytes(16).toString('hex'),
    role: normalizedRole,
    createdByUserId,
    createdAt: now,
    expiresAt: now + (1000 * 60 * 60 * 24 * 7),
  }
  auth.invites = [invite, ...auth.invites.filter((i) => !i.consumedAt && Number(i.expiresAt || 0) > now).slice(0, 49)]
  await saveAdminAuth(auth)
  return publicInvite(invite)
}

export async function createServerUser({ username, displayName, password, role = 'dm' }) {
  const auth = await loadAdminAuth()
  const normalizedRole = String(role || 'dm').trim().toLowerCase()
  if (!['dm', 'player'].includes(normalizedRole)) {
    const err = new Error('Role must be dm or player')
    err.statusCode = 400
    throw err
  }

  const normalizedUsername = validateAccountInput({ username, password, defaultUsername: '' })
  if (auth.admin?.username === normalizedUsername || auth.users.some((u) => u.username === normalizedUsername)) {
    const err = new Error('Username already exists')
    err.statusCode = 409
    throw err
  }

  const now = Date.now()
  const passwordRecord = await hashPassword(password)
  const user = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    displayName: String(displayName || username || '').trim() || normalizedUsername,
    role: normalizedRole,
    ...passwordRecord,
    createdAt: now,
    updatedAt: now,
  }
  auth.users.push(user)
  await saveAdminAuth(auth)
  return publicUser(user)
}

export async function acceptServerInvite({ inviteToken, username, displayName, password }) {
  const auth = await loadAdminAuth()
  const token = String(inviteToken || '').trim()
  const now = Date.now()
  const invite = auth.invites.find((i) => i.token === token)
  if (!invite) {
    const err = new Error('Invalid invite')
    err.statusCode = 400
    throw err
  }
  if (invite.consumedAt) {
    const err = new Error('Invite already used')
    err.statusCode = 400
    throw err
  }
  if (Number(invite.expiresAt || 0) < now) {
    const err = new Error('Invite expired')
    err.statusCode = 400
    throw err
  }

  const normalizedUsername = validateAccountInput({ username, password, defaultUsername: '' })
  if (auth.admin?.username === normalizedUsername || auth.users.some((u) => u.username === normalizedUsername)) {
    const err = new Error('Username already exists')
    err.statusCode = 409
    throw err
  }

  const passwordRecord = await hashPassword(password)
  const user = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    displayName: String(displayName || username || '').trim() || normalizedUsername,
    role: invite.role,
    ...passwordRecord,
    createdAt: now,
    updatedAt: now,
  }
  auth.users.push(user)
  invite.consumedAt = now
  invite.consumedByUserId = user.id
  return issueSession(auth, user, user.role)
}

export async function updateServerUserRole({ userId, role }) {
  const auth = await loadAdminAuth()
  const normalizedRole = String(role || '').trim().toLowerCase()
  if (!['dm', 'player'].includes(normalizedRole)) {
    const err = new Error('Role must be dm or player')
    err.statusCode = 400
    throw err
  }
  const user = auth.users.find((u) => u.id === userId)
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
  user.role = normalizedRole
  user.updatedAt = Date.now()
  auth.sessions = auth.sessions.map((session) => (
    session.userId === user.id ? { ...session, role: normalizedRole } : session
  ))
  await saveAdminAuth(auth)
  return publicUser(user)
}

export async function loginAdmin({ username = 'admin', password }) {
  const auth = await loadAdminAuth()
  const admin = auth.admin
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

  const attempted = await hashPassword(password, admin.salt)
  if (!timingSafeStringEqual(attempted.passwordHash, admin.passwordHash)) {
    const err = new Error('Invalid admin credentials')
    err.statusCode = 401
    throw err
  }

  return issueSession(auth, admin, 'admin')
}

async function issueSession(auth, account, role) {
  const now = Date.now()
  const session = {
    token: crypto.randomBytes(32).toString('hex'),
    userId: account.id,
    role,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  }
  auth.sessions = [
    session,
    ...(auth.sessions || []).filter((s) => Number(s?.expiresAt || 0) > now).slice(0, 49),
  ]
  await saveAdminAuth(auth)
  return {
    token: session.token,
    userId: account.id,
    role,
    displayName: account.displayName,
    expiresAt: session.expiresAt,
  }
}

export async function loginServerUser({ username, password }) {
  const auth = await loadAdminAuth()
  const normalizedUsername = String(username || '').trim().toLowerCase()
  const user = auth.users.find((u) => u.username === normalizedUsername)
  if (!user) {
    const err = new Error('Invalid credentials')
    err.statusCode = 401
    throw err
  }

  const attempted = await hashPassword(password, user.salt)
  if (!timingSafeStringEqual(attempted.passwordHash, user.passwordHash)) {
    const err = new Error('Invalid credentials')
    err.statusCode = 401
    throw err
  }

  return issueSession(auth, user, user.role)
}

export async function registerServerUser({ username, displayName, email, password }) {
  const auth = await loadAdminAuth()
  const normalizedUsername = validateAccountInput({ username, password, defaultUsername: '' })
  const normalizedEmail = String(email || '').trim().toLowerCase()
  if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const err = new Error('Invalid email address')
    err.statusCode = 400
    throw err
  }
  if (auth.admin?.username === normalizedUsername || auth.users.some((u) => u.username === normalizedUsername)) {
    const err = new Error('Username already taken')
    err.statusCode = 409
    throw err
  }
  if (normalizedEmail && auth.users.some((u) => u.email === normalizedEmail)) {
    const err = new Error('An account with that email already exists')
    err.statusCode = 409
    throw err
  }
  const now = Date.now()
  const passwordRecord = await hashPassword(password)
  const user = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    displayName: String(displayName || username || '').trim() || normalizedUsername,
    email: normalizedEmail || null,
    role: 'player',
    ...passwordRecord,
    createdAt: now,
    updatedAt: now,
  }
  auth.users.push(user)
  return issueSession(auth, user, 'player')
}

export async function deleteServerInvite({ token }) {
  const auth = await loadAdminAuth()
  const t = String(token || '').trim()
  const idx = auth.invites.findIndex((i) => i.token === t)
  if (idx === -1) {
    const err = new Error('Invite not found')
    err.statusCode = 404
    throw err
  }
  auth.invites.splice(idx, 1)
  await saveAdminAuth(auth)
}

export async function deleteServerUser({ userId }) {
  const auth = await loadAdminAuth()
  const idx = auth.users.findIndex((u) => u.id === userId)
  if (idx === -1) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
  auth.users.splice(idx, 1)
  auth.sessions = auth.sessions.filter((s) => s.userId !== userId)
  await saveAdminAuth(auth)
}

export async function resetServerUserPassword({ userId, password }) {
  const auth = await loadAdminAuth()
  const user = auth.users.find((u) => u.id === userId)
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
  validateAccountInput({ username: user.username, password })
  const passwordRecord = await hashPassword(password)
  user.passwordHash = passwordRecord.passwordHash
  user.salt = passwordRecord.salt
  user.updatedAt = Date.now()
  auth.sessions = auth.sessions.filter((s) => s.userId !== userId)
  await saveAdminAuth(auth)
  return publicUser(user)
}

export async function revokeServerUserSessions({ userId }) {
  const auth = await loadAdminAuth()
  const before = auth.sessions.length
  auth.sessions = auth.sessions.filter((s) => s.userId !== userId)
  if (auth.sessions.length === before) return { revoked: 0 }
  await saveAdminAuth(auth)
  return { revoked: before - auth.sessions.length }
}

export async function loginAnyUser({ username, password }) {
  try {
    return await loginAdmin({ username, password })
  } catch (err) {
    if (![401, 404].includes(Number(err?.statusCode))) throw err
  }
  return loginServerUser({ username, password })
}

export async function validateAdminSession(token) {
  const auth = await loadAdminAuth()
  const now = Date.now()
  const session = (auth.sessions || []).find((s) => s?.token === token && Number(s?.expiresAt || 0) > now)
  if (!session) return null
  if (session.role === 'admin' && auth.admin) {
    return {
      id: auth.admin.id,
      role: 'admin',
      displayName: auth.admin.displayName,
      admin: true,
    }
  }
  const user = auth.users.find((u) => u.id === session.userId)
  if (!user) return null
  return {
    id: user.id,
    role: user.role,
    displayName: user.displayName,
    admin: false,
  }
}
