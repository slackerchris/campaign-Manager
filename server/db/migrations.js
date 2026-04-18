// Track which DB connections have already had ensureSqlSchema applied so it
// runs exactly once per connection rather than on every read/write.
const _schemaMigratedDbs = new WeakSet()

export function ensureSqlSchema(db) {
  // Guard: only run migrations once per connection instance.
  if (_schemaMigratedDbs.has(db)) return
  _schemaMigratedDbs.add(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lexicon_entities (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      canonical_term TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      resolution_state TEXT NOT NULL DEFAULT 'resolved',
      resolved_to_lexicon_id TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      ownership_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL DEFAULT 'import',
      last_updated_by TEXT NOT NULL DEFAULT 'import',
      last_source_type TEXT NOT NULL DEFAULT '',
      last_source_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(campaign_id, entity_type, canonical_term)
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'import',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(entity_id) REFERENCES lexicon_entities(id) ON DELETE CASCADE,
      UNIQUE(entity_id, alias)
    );

    CREATE TABLE IF NOT EXISTS tracker_rows (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      tracker_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      link_method TEXT NOT NULL DEFAULT 'manual',
      link_confidence REAL NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(entity_id) REFERENCES lexicon_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bard_tales (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      journal_entry_id TEXT,
      title TEXT NOT NULL,
      bard_name TEXT,
      persona_id TEXT,
      faithfulness TEXT,
      prompt_version TEXT,
      source_hash TEXT,
      source_length INTEGER,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_documents (
      campaign_id TEXT NOT NULL,
      doc_key TEXT NOT NULL,
      content_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (campaign_id, doc_key)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'player',
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by_user_id TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(consumed_by_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions_auth (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lexicon_entities_campaign_type ON lexicon_entities(campaign_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_lexicon_entities_campaign_term ON lexicon_entities(campaign_id, canonical_term);
    CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_campaign_type ON tracker_rows(campaign_id, tracker_type);
    CREATE INDEX IF NOT EXISTS idx_campaign_documents_campaign ON campaign_documents(campaign_id, doc_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions_auth(user_id);
  `)

  try {
    db.exec('ALTER TABLE bard_tales ADD COLUMN campaign_id TEXT')
  } catch {
    // column already exists or table shape already updated
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_bard_tales_campaign ON bard_tales(campaign_id, created_at)')
  } catch {
    // ignore
  }

  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN resolved_to_lexicon_id TEXT") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN data_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN ownership_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'") } catch {}

  // Phase 3: Player Visibility and Ownership
  try { db.exec("ALTER TABLE journal_entries ADD COLUMN user_id TEXT") } catch {}
  try { db.exec("ALTER TABLE journal_entries ADD COLUMN visibility TEXT NOT NULL DEFAULT 'campaign'") } catch {}

  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN user_id TEXT") } catch {}
  try { db.exec("ALTER TABLE lexicon_entities ADD COLUMN visibility TEXT NOT NULL DEFAULT 'campaign'") } catch {}

  try { db.exec("ALTER TABLE tracker_rows ADD COLUMN user_id TEXT") } catch {}
  try { db.exec("ALTER TABLE tracker_rows ADD COLUMN visibility TEXT NOT NULL DEFAULT 'campaign'") } catch {}
}
