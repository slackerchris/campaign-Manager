import { sql } from 'kysely'

export async function up(db) {
  await sql`

    -- ── Users & auth ──────────────────────────────────────────────────────────

    CREATE TABLE users (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      username      text        NOT NULL UNIQUE,
      display_name  text        NOT NULL,
      email         text        UNIQUE,
      role          text        NOT NULL CHECK (role IN ('admin', 'dm', 'player')),
      password_hash text        NOT NULL,
      password_salt text        NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_sessions (
      token       text        PRIMARY KEY,
      user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        text        NOT NULL CHECK (role IN ('admin', 'dm', 'player')),
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL
    );
    CREATE INDEX idx_user_sessions_user_expires ON user_sessions (user_id, expires_at);

    CREATE TABLE server_invites (
      token                 text        PRIMARY KEY,
      role                  text        NOT NULL CHECK (role IN ('dm', 'player')),
      created_by_user_id    uuid        REFERENCES users(id) ON DELETE SET NULL,
      consumed_by_user_id   uuid        REFERENCES users(id) ON DELETE SET NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      expires_at            timestamptz NOT NULL,
      consumed_at           timestamptz
    );

    -- ── Campaigns ─────────────────────────────────────────────────────────────

    CREATE TABLE campaigns (
      id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      slug                text        NOT NULL UNIQUE,
      name                text        NOT NULL,
      owner_user_id       uuid        NOT NULL REFERENCES users(id),
      owner_display_name  text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      archived_at         timestamptz
    );

    CREATE TABLE campaign_members (
      campaign_id   uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name  text        NOT NULL,
      role          text        NOT NULL CHECK (role IN ('dm', 'player')),
      joined_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, user_id)
    );

    CREATE TABLE campaign_invites (
      token                 text        PRIMARY KEY,
      campaign_id           uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      target_user_id        uuid        REFERENCES users(id) ON DELETE CASCADE,
      created_by_user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role                  text        NOT NULL DEFAULT 'player',
      dm_display_name       text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      expires_at            timestamptz NOT NULL,
      consumed_at           timestamptz,
      consumed_by_user_id   uuid        REFERENCES users(id)
    );
    CREATE INDEX idx_campaign_invites_target ON campaign_invites (target_user_id, consumed_at, expires_at);

    -- ── Settings (plaintext config) ───────────────────────────────────────────

    CREATE TABLE server_settings (
      key                 text        PRIMARY KEY,
      value               jsonb       NOT NULL,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      updated_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE user_settings (
      user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key         text        NOT NULL,
      value       jsonb       NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE campaign_settings (
      campaign_id         uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      key                 text        NOT NULL,
      value               jsonb       NOT NULL,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      updated_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (campaign_id, key)
    );

    -- ── Secrets (AES-256-GCM encrypted, stored as iv:tag:ciphertext) ──────────

    CREATE TABLE server_secrets (
      key                 text        PRIMARY KEY,
      encrypted_value     text        NOT NULL,
      key_version         integer     NOT NULL DEFAULT 1,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      updated_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE user_secrets (
      user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key               text        NOT NULL,
      encrypted_value   text        NOT NULL,
      key_version       integer     NOT NULL DEFAULT 1,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, key)
    );

    -- ── Canon: lexicon ────────────────────────────────────────────────────────

    CREATE TABLE lexicon_entities (
      id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id         uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      entity_type         text        NOT NULL CHECK (entity_type IN ('npc','monster','place','quest','item','faction','term','event')),
      canonical_term      text        NOT NULL,
      notes               text        NOT NULL DEFAULT '',
      resolution_state    text        NOT NULL DEFAULT 'resolved',
      resolved_to_id      uuid        REFERENCES lexicon_entities(id) ON DELETE SET NULL,
      data                jsonb       NOT NULL DEFAULT '{}',
      ownership           jsonb       NOT NULL DEFAULT '{}',
      evidence            jsonb       NOT NULL DEFAULT '[]',
      user_id             uuid        REFERENCES users(id) ON DELETE SET NULL,
      visibility          text        NOT NULL DEFAULT 'campaign',
      created_by          text        NOT NULL DEFAULT 'import',
      last_updated_by     text        NOT NULL DEFAULT 'import',
      last_source_type    text        NOT NULL DEFAULT '',
      last_source_id      text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (campaign_id, entity_type, canonical_term)
    );
    CREATE INDEX idx_lexicon_campaign_type ON lexicon_entities (campaign_id, entity_type);
    CREATE INDEX idx_lexicon_campaign_term ON lexicon_entities (campaign_id, canonical_term);
    CREATE INDEX idx_lexicon_data_gin      ON lexicon_entities USING gin (data);

    CREATE TABLE entity_aliases (
      id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id   uuid        NOT NULL REFERENCES lexicon_entities(id) ON DELETE CASCADE,
      alias       text        NOT NULL,
      confidence  numeric     NOT NULL DEFAULT 1,
      source      text        NOT NULL DEFAULT 'import',
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (entity_id, alias)
    );
    CREATE INDEX idx_aliases_entity ON entity_aliases (entity_id);

    CREATE TABLE tracker_rows (
      id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id     uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      tracker_type    text        NOT NULL,
      entity_id       uuid        NOT NULL REFERENCES lexicon_entities(id) ON DELETE CASCADE,
      snapshot        jsonb       NOT NULL DEFAULT '{}',
      link_method     text        NOT NULL DEFAULT 'manual',
      link_confidence numeric     NOT NULL DEFAULT 1,
      user_id         uuid        REFERENCES users(id) ON DELETE SET NULL,
      visibility      text        NOT NULL DEFAULT 'campaign',
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_tracker_campaign_type    ON tracker_rows (campaign_id, tracker_type);
    CREATE INDEX idx_tracker_snapshot_gin     ON tracker_rows USING gin (snapshot);

    -- ── Canon: journal & bard tales ───────────────────────────────────────────

    CREATE TABLE journal_entries (
      id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id  uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      session_id   uuid,
      user_id      uuid        REFERENCES users(id) ON DELETE SET NULL,
      visibility   text        NOT NULL DEFAULT 'campaign',
      title        text        NOT NULL,
      body         text        NOT NULL,
      source_hash  text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_journal_campaign ON journal_entries (campaign_id, created_at DESC);

    CREATE TABLE bard_tales (
      id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id       uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      journal_entry_id  uuid        REFERENCES journal_entries(id) ON DELETE SET NULL,
      title             text        NOT NULL,
      bard_name         text,
      persona_id        text,
      faithfulness      text,
      prompt_version    text,
      source_hash       text,
      source_length     integer,
      text              text        NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    );

    -- ── Campaign documents (bridge table; migrate specific keys to real tables over time) ──

    CREATE TABLE campaign_documents (
      campaign_id  uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      doc_key      text        NOT NULL,
      content      jsonb       NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, doc_key)
    );

    -- ── Pipeline jobs & artifacts ─────────────────────────────────────────────

    CREATE TABLE pipeline_jobs (
      id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id           uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      status                text        NOT NULL,
      job_type              text        NOT NULL,
      source_label          text,
      source_id             text,
      game_session_id       uuid,
      data                  jsonb       NOT NULL DEFAULT '{}',
      error                 text,
      created_by_user_id    uuid        REFERENCES users(id),
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      started_at            timestamptz,
      finished_at           timestamptz
    );
    CREATE INDEX idx_jobs_campaign_status ON pipeline_jobs (campaign_id, status);

    CREATE TABLE import_artifacts (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id   uuid        NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      job_id        uuid        REFERENCES pipeline_jobs(id) ON DELETE SET NULL,
      artifact_type text        NOT NULL,
      storage_path  text        NOT NULL,
      sha256        text,
      size_bytes    bigint,
      metadata      jsonb       NOT NULL DEFAULT '{}',
      created_at    timestamptz NOT NULL DEFAULT now()
    );

  `.execute(db)
}

export async function down(db) {
  await sql`
    DROP TABLE IF EXISTS import_artifacts       CASCADE;
    DROP TABLE IF EXISTS pipeline_jobs          CASCADE;
    DROP TABLE IF EXISTS campaign_documents     CASCADE;
    DROP TABLE IF EXISTS bard_tales             CASCADE;
    DROP TABLE IF EXISTS journal_entries        CASCADE;
    DROP TABLE IF EXISTS tracker_rows           CASCADE;
    DROP TABLE IF EXISTS entity_aliases         CASCADE;
    DROP TABLE IF EXISTS lexicon_entities       CASCADE;
    DROP TABLE IF EXISTS user_secrets           CASCADE;
    DROP TABLE IF EXISTS server_secrets         CASCADE;
    DROP TABLE IF EXISTS campaign_settings      CASCADE;
    DROP TABLE IF EXISTS user_settings          CASCADE;
    DROP TABLE IF EXISTS server_settings        CASCADE;
    DROP TABLE IF EXISTS campaign_invites       CASCADE;
    DROP TABLE IF EXISTS campaign_members       CASCADE;
    DROP TABLE IF EXISTS campaigns              CASCADE;
    DROP TABLE IF EXISTS server_invites         CASCADE;
    DROP TABLE IF EXISTS user_sessions          CASCADE;
    DROP TABLE IF EXISTS users                  CASCADE;
  `.execute(db)
}
