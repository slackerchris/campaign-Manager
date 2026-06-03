import { db } from '../pool.js'

// Columns persisted to Postgres. Excludes large transient fields.
function safeJobData(job) {
  return {
    campaignSlug: job.campaignId,
    type: job.type,
    file: job.file || null,
    gameSessionTitle: job.gameSessionTitle || null,
    stage: job.stage || null,
    progressPct: job.progressPct || 0,
    transcript: job.transcript || '',
    cleanedTranscript: job.cleanedTranscript || '',
    journal: job.journal || '',
    npcUpdates: job.npcUpdates || [],
    questUpdates: job.questUpdates || [],
    quotes: job.quotes || [],
    proposalId: job.proposalId || null,
    timeline: job.timeline || [],
    sessionRecap: job.sessionRecap || '',
    runningCampaignLog: job.runningCampaignLog || [],
    checkpointPaths: job.checkpointPaths || [],
    preAiArtifactPath: job.preAiArtifactPath || null,
    preAiArtifactSavedAt: job.preAiArtifactSavedAt || null,
    diarizationArtifactPath: job.diarizationArtifactPath || null,
    diarizationFallback: job.diarizationFallback || null,
    pipelineFallback: job.pipelineFallback || null,
    llmConfig: job.llmConfig || null,
    etaSec: job.etaSec || null,
    totalChunks: job.totalChunks || null,
    doneChunks: job.doneChunks || 0,
    currentChunk: job.currentChunk || 0,
    durationSec: job.durationSec || null,
  }
}

// Reconstruct a legacy-compatible job object from a Postgres row.
function rowToJob(row) {
  const data = row.data || {}
  return {
    id: row.id,
    campaignId: data.campaignSlug || '',
    gameSessionId: row.game_session_id || null,
    gameSessionTitle: data.gameSessionTitle || null,
    sourceId: row.source_id || null,
    sourceLabel: row.source_label || null,
    type: data.type || row.job_type,
    status: row.status,
    stage: data.stage || row.status,
    progressPct: data.progressPct || 0,
    etaSec: data.etaSec || null,
    totalChunks: data.totalChunks || null,
    doneChunks: data.doneChunks || 0,
    currentChunk: data.currentChunk || 0,
    file: data.file || null,
    transcript: data.transcript || '',
    cleanedTranscript: data.cleanedTranscript || '',
    speakerTranscript: '',
    journal: data.journal || '',
    npcUpdates: data.npcUpdates || [],
    questUpdates: data.questUpdates || [],
    quotes: data.quotes || [],
    proposalId: data.proposalId || null,
    timeline: data.timeline || [],
    sessionRecap: data.sessionRecap || '',
    runningCampaignLog: data.runningCampaignLog || [],
    checkpointPaths: data.checkpointPaths || [],
    preAiArtifactPath: data.preAiArtifactPath || null,
    preAiArtifactSavedAt: data.preAiArtifactSavedAt || null,
    diarizationArtifactPath: data.diarizationArtifactPath || null,
    diarizationFallback: data.diarizationFallback || null,
    pipelineFallback: data.pipelineFallback || null,
    llmConfig: data.llmConfig || null,
    durationSec: data.durationSec || null,
    error: row.error || null,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at || 0),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Number(row.updated_at || 0),
    startedAt: row.started_at ? (row.started_at instanceof Date ? row.started_at.getTime() : Number(row.started_at)) : null,
    expiresAt: null,
    rawSegments: [],
    localPath: null,
    remoteAudioPath: null,
    stdout: null,
    stderr: null,
  }
}

// Insert a new job row (fire-and-forget from trackJob).
export async function createJob(pgCampaignId, job) {
  await db.insertInto('pipeline_jobs')
    .values({
      id: job.id,
      campaign_id: pgCampaignId,
      status: job.status || 'queued',
      job_type: job.type || 'unknown',
      source_label: job.sourceLabel || null,
      source_id: job.sourceId || null,
      game_session_id: job.gameSessionId || null,
      data: safeJobData(job),
      error: null,
      created_at: new Date(job.createdAt || Date.now()),
      updated_at: new Date(job.updatedAt || Date.now()),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
}

// Update a job at terminal state (done/error/cancelled).
export async function finishJob(jobId, job) {
  await db.updateTable('pipeline_jobs')
    .set({
      status: job.status,
      data: safeJobData(job),
      error: job.error || null,
      updated_at: new Date(job.updatedAt || Date.now()),
      started_at: job.startedAt ? new Date(job.startedAt) : null,
      finished_at: new Date(),
    })
    .where('id', '=', jobId)
    .execute()
}

// On startup: mark any non-terminal jobs as error (they were interrupted by restart).
export async function markStaleJobsErrored() {
  await db.updateTable('pipeline_jobs')
    .set({
      status: 'error',
      error: 'Server restarted while job was running',
      updated_at: new Date(),
      finished_at: new Date(),
    })
    .where('status', 'in', ['queued', 'running'])
    .execute()
}

// Load recent jobs on startup to populate the in-memory Map.
export async function loadRecentJobs(limit = 200) {
  const rows = await db.selectFrom('pipeline_jobs')
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .selectAll()
    .execute()

  return rows.map(rowToJob)
}

// Find a single job by ID (fallback when not in memory).
export async function findJob(jobId) {
  const row = await db.selectFrom('pipeline_jobs')
    .where('id', '=', jobId)
    .selectAll()
    .executeTakeFirst()

  return row ? rowToJob(row) : null
}

// Prune old terminal jobs beyond the retention limit.
export async function pruneOldJobs(keepCount = 200) {
  await db.deleteFrom('pipeline_jobs')
    .where('id', 'not in', (qb) =>
      qb.selectFrom('pipeline_jobs')
        .select('id')
        .orderBy('updated_at', 'desc')
        .limit(keepCount)
    )
    .execute()
}
