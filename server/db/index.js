import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CAMPAIGN_DB_CACHE_MAX, DATA_DIR } from '../config.js'
import { ensureSqlSchema } from './migrations.js'

export function runInTx(db, fn) {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

// Jobs SQLite persistence — survives API restarts so polling clients get terminal state
const JOBS_DB_PATH = path.join(DATA_DIR, 'jobs.sqlite')
let _jobsDb = null

export function getJobsDb() {
  if (_jobsDb) return _jobsDb
  _jobsDb = new DatabaseSync(JOBS_DB_PATH)
  _jobsDb.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return _jobsDb
}

const campaignDbCache = new Map() // key → { db, lruOrder }
let _lruSeq = 0

export function dbForCampaignBase(base) {
  const dbPath = path.join(base, 'campaign.sqlite')
  if (campaignDbCache.has(dbPath)) {
    campaignDbCache.get(dbPath).lruOrder = ++_lruSeq
    return campaignDbCache.get(dbPath).db
  }
  
  // Evict least-recently-used if at capacity
  if (campaignDbCache.size >= CAMPAIGN_DB_CACHE_MAX) {
    let oldest = null
    for (const [k, v] of campaignDbCache) {
      if (!oldest || v.lruOrder < campaignDbCache.get(oldest).lruOrder) oldest = k
    }
    if (oldest) {
      try { campaignDbCache.get(oldest).db.close() } catch { /* ignore */ }
      campaignDbCache.delete(oldest)
    }
  }
  
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  campaignDbCache.set(dbPath, { db, lruOrder: ++_lruSeq })
  
  // Run schema migrations once immediately on first open.
  ensureSqlSchema(db)
  
  return db
}
