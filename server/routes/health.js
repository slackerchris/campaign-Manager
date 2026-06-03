import { promises as fs } from 'node:fs'
import { getRuntimeConfig } from '../services/pipeline.js'
import { DATA_DIR } from '../config.js'

export function setupHealthRoutes(app) {

  // ── Basic health heartbeat (public) ─────────────────────────────────────────

  app.get('/api/health', (_req, res) => {
    const cfg = getRuntimeConfig()
    res.json({
      ok: true,
      asrProvider: cfg.asrProvider,
      whisperModel: cfg.whisperModel,
      whisperDevice: cfg.whisperDevice,
      chunkSeconds: cfg.chunkSeconds,
      groqModel: cfg.groqWhisperModel,
      hasGroqKey: cfg.hasGroqKey,
      diarizationMode: cfg.diarizationMode,
      effectiveDiarizationMode: (cfg.diarizationMode === 'pyannote' || (cfg.diarizationMode === 'auto' && cfg.hasPyannoteToken)) ? 'pyannote' : 'llm',
      hasPyannoteToken: cfg.hasPyannoteToken,
      hasGeminiKey: cfg.hasGeminiKey,
      llmProvider: cfg.llmProvider,
      llmModel: cfg.llmModel,
      pipelineChatgptOnly: cfg.pipelineChatgptOnly,
      pipelineOpenaiModel: cfg.pipelineOpenaiModel,
      pipelineOpenaiFallbackModel: cfg.pipelineOpenaiFallbackModel,
      anthropicRetryMax: cfg.anthropicRetryMax,
      anthropicRetryBaseMs: cfg.anthropicRetryBaseMs,
      anthropicMinGapMs: cfg.anthropicMinGapMs,
      ollamaBase: cfg.ollamaBase,
    })
  })

  // ── Pipeline health check (DM or admin) ──────────────────────────────────────

  app.get('/api/health/pipeline', async (req, res) => {
    if (!req.user || !['admin', 'dm'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' })
    }

    const cfg = getRuntimeConfig()

    async function probe(url) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
        return { reachable: true, httpStatus: r.status }
      } catch (err) {
        return { reachable: false, error: err?.cause?.code || err.message }
      }
    }

    async function checkDataDir() {
      const testFile = `${DATA_DIR}/.health-${Date.now()}`
      try {
        await fs.writeFile(testFile, 'ok')
        await fs.unlink(testFile)
        return { writable: true, path: DATA_DIR }
      } catch (err) {
        return { writable: false, path: DATA_DIR, error: err.message }
      }
    }

    async function checkAsr() {
      const base = { provider: cfg.asrProvider }
      if (cfg.asrProvider === 'whisper-local') {
        const endpoint = cfg.whisperLocalBase.replace(/\/+$/, '')
        const result = await probe(`${endpoint}/health`)
        return { ...base, endpoint, path: cfg.whisperLocalPath, model: cfg.whisperLocalModel, ...result }
      }
      if (cfg.asrProvider === 'groq') {
        return { ...base, endpoint: cfg.groqBase, model: cfg.groqWhisperModel, reachable: cfg.hasGroqKey, error: cfg.hasGroqKey ? undefined : 'No API key configured' }
      }
      if (cfg.asrProvider === 'openai') {
        return { ...base, endpoint: cfg.openaiBase, model: 'whisper-1', reachable: cfg.hasOpenaiKey, error: cfg.hasOpenaiKey ? undefined : 'No API key configured' }
      }
      if (cfg.asrProvider === 'remote') {
        return { ...base, model: cfg.whisperModel, reachable: null, note: 'SSH — not probed' }
      }
      if (cfg.asrProvider === 'local') {
        return { ...base, endpoint: 'container', model: cfg.whisperModel, device: cfg.whisperDevice, reachable: null, note: 'Local CLI — not probed' }
      }
      return { ...base, reachable: false, error: 'Unknown provider' }
    }

    async function checkLlm() {
      const base = { provider: cfg.llmProvider, model: cfg.llmModel }
      if (cfg.llmProvider === 'ollama') {
        const result = await probe(`${cfg.ollamaBase}/api/tags`)
        return { ...base, endpoint: cfg.ollamaBase, ...result }
      }
      if (cfg.llmProvider === 'openai') {
        return { ...base, endpoint: cfg.openaiBase, reachable: cfg.hasOpenaiKey, error: cfg.hasOpenaiKey ? undefined : 'No API key configured' }
      }
      if (cfg.llmProvider === 'anthropic') {
        return { ...base, endpoint: cfg.anthropicBase, reachable: cfg.hasAnthropicKey, error: cfg.hasAnthropicKey ? undefined : 'No API key configured' }
      }
      if (cfg.llmProvider === 'gemini') {
        return { ...base, endpoint: cfg.geminiBase, reachable: cfg.hasGeminiKey, error: cfg.hasGeminiKey ? undefined : 'No API key configured' }
      }
      return { ...base, reachable: false, error: 'Unknown provider' }
    }

    const [asr, llm, dataDir] = await Promise.all([checkAsr(), checkLlm(), checkDataDir()])
    res.json({
      ok: true,
      asr,
      llm,
      dataDir,
      uploadLimitBytes: cfg.maxUploadBytes,
      chunkSeconds: cfg.chunkSeconds,
      maxConcurrentJobs: cfg.maxConcurrentJobs,
    })
  })

}
