import path from 'node:path'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import { CAMPAIGNS_DIR } from './config.js'

export class InvalidCampaignIdError extends Error {
  constructor(campaignId) {
    super(`Invalid campaign id: ${campaignId}`)
    this.name = 'InvalidCampaignIdError'
    this.statusCode = 400
  }
}

export class CampaignNotFoundError extends Error {
  constructor(campaignId) {
    super(`Campaign not found: ${campaignId}`)
    this.name = 'CampaignNotFoundError'
    this.statusCode = 404
  }
}

export class DataIntegrityError extends Error {
  constructor(file, cause) {
    super(`Invalid JSON in ${file}`)
    this.name = 'DataIntegrityError'
    this.statusCode = 500
    this.cause = cause
  }
}

export function slugify(text = '') {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export function normalizeCampaignId(campaignId = '') {
  const normalized = String(campaignId || '').trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new InvalidCampaignIdError(campaignId)
  }
  return normalized
}

export function resolveCampaignBase(campaignId) {
  const normalizedId = normalizeCampaignId(campaignId)
  const base = path.resolve(CAMPAIGNS_DIR, normalizedId)
  const relative = path.relative(CAMPAIGNS_DIR, base)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InvalidCampaignIdError(campaignId)
  }
  return { campaignId: normalizedId, base }
}

const writeLocks = new Map()

export async function runExclusive(lockKey, fn) {
  const previous = writeLocks.get(lockKey) || Promise.resolve()
  let releaseCurrent
  const current = new Promise((resolve) => {
    releaseCurrent = resolve
  })
  writeLocks.set(lockKey, current)

  await previous
  try {
    return await fn()
  } finally {
    releaseCurrent()
    if (writeLocks.get(lockKey) === current) writeLocks.delete(lockKey)
  }
}

export async function runWithCampaignWriteLock(campaignId, fn) {
  return runExclusive(`campaign:${normalizeCampaignId(campaignId)}`, fn)
}

export function withStaticWriteLock(lockKey, handler) {
  return async (req, res, next) => {
    try {
      await runExclusive(lockKey, () => handler(req, res, next))
    } catch (error) {
      next(error)
    }
  }
}

export function withCampaignParamWriteLock(handler) {
  return async (req, res, next) => {
    try {
      await runWithCampaignWriteLock(req.params.id, () => handler(req, res, next))
    } catch (error) {
      next(error)
    }
  }
}

export function withCampaignBodyWriteLock(handler) {
  return async (req, res, next) => {
    try {
      await runWithCampaignWriteLock(req.body?.campaignId, () => handler(req, res, next))
    } catch (error) {
      next(error)
    }
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) throw new DataIntegrityError(file, error)
    throw error
  }
}

export async function writeJson(file, value) {
  const tempFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tempFile, JSON.stringify(value, null, 2))
  await fs.rename(tempFile, file)
}
