const windows = new Map()

// Cleans up stale IP entries every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, timestamps] of windows) {
    const fresh = timestamps.filter((t) => now - t < 600_000)
    if (fresh.length === 0) windows.delete(key)
    else windows.set(key, fresh)
  }
}, 600_000).unref()

/**
 * Rate limiter middleware.
 * @param {number} max   - max requests allowed in the window
 * @param {number} windowMs - window size in milliseconds
 */
export function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const key = `${ip}:${req.path}`
    const now = Date.now()
    const timestamps = (windows.get(key) || []).filter((t) => now - t < windowMs)

    if (timestamps.length >= max) {
      const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000)
      res.setHeader('Retry-After', retryAfter)
      return res.status(429).json({ ok: false, error: 'Too many attempts — please wait before trying again' })
    }

    timestamps.push(now)
    windows.set(key, timestamps)
    next()
  }
}
