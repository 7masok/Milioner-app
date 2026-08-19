import pg from 'pg';
import { config } from './config.js';

const { Pool, types } = pg;
types.setTypeParser(20, value => Number(value));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Math.max(2, Number(process.env.PGPOOL_MAX || 10)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'millioner-railway-api'
});

pool.on('error', error => console.error('postgres pool error', error));

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

