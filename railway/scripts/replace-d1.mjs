import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/db.js';
import { assertRuntimeConfig } from '../src/config.js';
import { SOURCE_TABLE_ORDER, openD1Export, quoteIdent, sqliteColumns, sqliteRows } from './sqlite-source.mjs';

const backupPath = process.argv.find(arg => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]);
if (!backupPath || !process.argv.includes('--apply')) throw new Error('Usage: node scripts/replace-d1.mjs <backup.sql> --apply');
assertRuntimeConfig();
const { db, bytes, resolved } = await openD1Export(backupPath);
const sha = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1)', [730020]);
  await client.query(`TRUNCATE ${SOURCE_TABLE_ORDER.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`);
  for (const table of SOURCE_TABLE_ORDER) {
    const columns = sqliteColumns(db, table);
    const rows = sqliteRows(db, table);
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200), values = [];
      const tuples = batch.map((row, rowIndex) => `(${columns.map((column, columnIndex) => { values.push(row[column] ?? null); return `$${rowIndex * columns.length + columnIndex + 1}`; }).join(',')})`);
      if (tuples.length) await client.query(`INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(',')}) VALUES ${tuples.join(',')}`, values);
    }
  }
  for (const table of ['product_links','marketplace_order_lines','sync_runs','wb_finance_sync_runs','stock_sync_runs']) await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1), true)`, [table]);
  await client.query('INSERT INTO migration_imports(backup_sha256,imported_at,source_tables,source_rows) VALUES($1,$2,$3,$4) ON CONFLICT (backup_sha256) DO UPDATE SET imported_at=excluded.imported_at,source_tables=excluded.source_tables,source_rows=excluded.source_rows', [sha, Date.now(), SOURCE_TABLE_ORDER.length, SOURCE_TABLE_ORDER.reduce((sum,t) => sum + sqliteRows(db,t).length,0)]);
  await client.query('COMMIT');
  console.log(JSON.stringify({ok:true,backup:path.basename(resolved),sha},null,2));
} catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
finally { client.release(); db.close(); await pool.end(); }
