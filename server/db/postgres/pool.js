import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { DATABASE_URL } from '../../config.js'

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('Postgres pool error:', err)
})

export const db = new Kysely({
  dialect: new PostgresDialect({ pool }),
})

export async function checkConnection() {
  const client = await pool.connect()
  try {
    const result = await client.query('SELECT version()')
    return { ok: true, version: result.rows[0].version }
  } finally {
    client.release()
  }
}
