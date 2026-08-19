import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { assertRuntimeConfig } from '../src/config.js';
import { SOURCE_TABLE_ORDER, openD1Export, quoteIdent, sqliteColumns, sqliteRows } from './sqlite-source.mjs';

const apply = process.argv.includes('--apply');
const backupPath = process.argv.find(arg => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]);
if (!backupPath) throw new Error('Usage: npm run db:import:d1 -- <backup.sql> [--apply]');

const { db, resolved, bytes } = await openD1Export(backupPath);
const backupSha = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const sourceCounts = Object.fromEntries(SOURCE_TABLE_ORDER.map(table => [table, sqliteRows(db, table).length]));
const totalRows = Object.values(sourceCounts).reduce((sum, count) => sum + count, 0);

console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', backup: resolved, backupSha, sourceCounts, totalRows }, null, 2));
if (!apply) {
  console.log('Dry run only. Add --apply after reviewing counts and confirming the target Postgres is empty.');
  db.close();
  await pool.end();
  process.exit(0);
}

assertRuntimeConfig();

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock($1)', [730020]);

  const existingImport = await client.query('SELECT 1 FROM migration_imports WHERE backup_sha256=$1', [backupSha]);
  if (existingImport.rowCount) throw new Error('This exact D1 backup was already imported');

  for (const table of SOURCE_TABLE_ORDER) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(table)}`);
    if (Number(result.rows[0].count) !== 0) {
      throw new Error(`Refusing import: target table ${table} is not empty`);
    }
  }

  for (const table of SOURCE_TABLE_ORDER) {
    const columns = sqliteColumns(db, table);
    const target = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [table]
    );
    const targetColumns = new Set(target.rows.map(row => row.column_name));
    const missing = columns.filter(column => !targetColumns.has(column));
    if (missing.length) throw new Error(`Target ${table} is missing columns: ${missing.join(', ')}`);

    const rows = sqliteRows(db, table);
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200);
      const values = [];
      const tuples = batch.map((row, rowIndex) => {
        const placeholders = columns.map((column, columnIndex) => {
          values.push(row[column] ?? null);
          return `$${rowIndex * columns.length + columnIndex + 1}`;
        });
        return `(${placeholders.join(',')})`;
      });
      if (batch.length) {
        await client.query(
          `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(',')}) VALUES ${tuples.join(',')}`,
          values
        );
      }
    }
    console.log(`imported ${table}: ${rows.length}`);
  }

  for (const table of ['product_links', 'marketplace_order_lines', 'sync_runs', 'wb_finance_sync_runs', 'stock_sync_runs']) {
    await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'), COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1), true)`, [table]);
  }

  const state = await client.query('SELECT payload,revision,updated_at FROM warehouse_state WHERE id=1');
  if (state.rowCount) {
    const row = state.rows[0];
    const payloadSha = crypto.createHash('sha256').update(String(row.payload)).digest('hex').toUpperCase();
    await client.query(
      'INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',
      [row.revision, row.updated_at, payloadSha, 'd1-import']
    );
  }

  await client.query(
    'INSERT INTO migration_imports(backup_sha256,imported_at,source_tables,source_rows) VALUES($1,$2,$3,$4)',
    [backupSha, Date.now(), SOURCE_TABLE_ORDER.length, totalRows]
  );
  await client.query('COMMIT');
  console.log(`D1 import committed: ${SOURCE_TABLE_ORDER.length} tables, ${totalRows} rows`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  db.close();
  await pool.end();
}
