import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { assertRuntimeConfig } from '../src/config.js';

assertRuntimeConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');
const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [730019]);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )`);
  const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(row => row.version));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2)', [file, Date.now()]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [730019]).catch(() => {});
  client.release();
  await pool.end();
}

