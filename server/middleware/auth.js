import { validateAdminSession } from '../services/adminAuth.js'

export const authMiddleware = async (req, res, next) => {
  const authHeader = String(req.headers['authorization'] || '')
  if (!authHeader.startsWith('Bearer ')) return next()

  const token = authHeader.slice(7).trim()
  try {
    const user = await validateAdminSession(token)
    if (user) req.user = user
  } catch (err) {
    console.error('Auth middleware error:', err)
  }
  next()
}
