const MAX_LOGS = 300
const logs = []
let consoleCaptureInstalled = false

function safeString(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function addDiagnosticLog({ level = 'info', type = 'system', message = '', meta = {} }) {
  logs.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    level,
    type,
    message: String(message).slice(0, 2000),
    meta,
  })
  while (logs.length > MAX_LOGS) logs.shift()
}

export function installConsoleCapture() {
  if (consoleCaptureInstalled) return
  consoleCaptureInstalled = true

  const originalError = console.error.bind(console)
  const originalWarn = console.warn.bind(console)

  console.error = (...args) => {
    addDiagnosticLog({ level: 'error', type: 'console', message: args.map(safeString).join(' ') })
    originalError(...args)
  }

  console.warn = (...args) => {
    addDiagnosticLog({ level: 'warn', type: 'console', message: args.map(safeString).join(' ') })
    originalWarn(...args)
  }
}

export function requestLogMiddleware(req, res, next) {
  const startedAt = Date.now()
  res.on('finish', () => {
    if (req.path === '/admin/diagnostics') return
    addDiagnosticLog({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      type: 'request',
      message: `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
      meta: {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        userId: req.user?.id || null,
        role: req.user?.role || null,
      },
    })
  })
  next()
}

export function recentDiagnosticLogs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, MAX_LOGS))
  return logs.slice(-safeLimit).reverse()
}

export function diagnosticRuntimeSnapshot() {
  const memory = process.memoryUsage()
  return {
    uptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid,
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
    },
  }
}
