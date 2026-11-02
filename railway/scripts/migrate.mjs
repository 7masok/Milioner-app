import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { assertRuntimeConfig, config } from '../src/config.js';
import { instanceMigrationSql } from '../src/instance-migrations.js';

assertRuntimeConfig();

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');
const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [730019]);
  client.on('notice', (notice) => console.log(notice.message));
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at BIGINT NOT NULL
  )`);
  const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(row => row.version));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = instanceMigrationSql(file,await fs.readFile(path.join(migrationsDir, file), 'utf8'),config.storeProfile);
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
  if(config.storeProfile==='WB3')await client.query(`INSERT INTO warehouse_state(id,payload,revision,updated_at) VALUES(1,$1,0,$2) ON CONFLICT(id) DO NOTHING`,[JSON.stringify({products:[],purchases:[],sales:[],movements:[],reservations:[],settings:{name:'WB 3',selectedOrderMarket:'WB',selectedWbAccount:'WB'}}),Date.now()]);

} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [730019]).catch(() => {});
  client.release();
  await pool.end();
}

