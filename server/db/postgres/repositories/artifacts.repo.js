import crypto from 'node:crypto'
import { db } from '../pool.js'

export async function recordArtifact(pgCampaignId, jobId, {
  artifactType,
  storagePath,
  sizeBytes = null,
  metadata = {},
} = {}) {
  await db.insertInto('import_artifacts')
    .values({
      id: crypto.randomUUID(),
      campaign_id: pgCampaignId,
      job_id: jobId || null,
      artifact_type: artifactType,
      storage_path: storagePath,
      size_bytes: sizeBytes != null ? BigInt(sizeBytes) : null,
      metadata,
      created_at: new Date(),
    })
    .execute()
}

export async function listArtifactsForJob(jobId) {
  return db.selectFrom('import_artifacts')
    .where('job_id', '=', jobId)
    .orderBy('created_at', 'asc')
    .selectAll()
    .execute()
}

export async function listArtifactsForCampaign(pgCampaignId) {
  return db.selectFrom('import_artifacts')
    .where('campaign_id', '=', pgCampaignId)
    .orderBy('created_at', 'desc')
    .selectAll()
    .execute()
}
