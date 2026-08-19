import crypto from 'node:crypto';
import { pool } from '../src/db.js';
import { assertRuntimeConfig } from '../src/config.js';
import { SOURCE_TABLE_ORDER, openD1Export, quoteIdent, sqliteColumns, sqliteRows } from './sqlite-source.mjs';

assertRuntimeConfig();
const backupPath = process.argv.find(arg => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]);
if (!backupPath) throw new Error('Usage: npm run db:verify -- <backup.sql>');

const { db, bytes } = await openD1Export(backupPath);
const backupSha = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

function canonicalValue(value) {
  if (value == null) return 'null';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `b:${Buffer.from(value).toString('base64')}`;
  if (typeof value === 'number') return `n:${Number.isInteger(value) ? value : Number(value.toPrecision(15))}`;
  if (typeof value === 'bigint') return `n:${value}`;
  return `s:${String(value)}`;
}

function checksum(rows, columns) {
  const canonicalRows = rows.map(row => columns.map(column => canonicalValue(row[column])).join('\u001f')).sort();
  return crypto.createHash('sha256').update(canonicalRows.join('\n')).digest('hex').toUpperCase();
}

const results = [];
let ok = true;
for (const table of SOURCE_TABLE_ORDER) {
  const columns = sqliteColumns(db, table);
  const sourceRows = sqliteRows(db, table);
  const targetRows = (await pool.query(`SELECT ${columns.map(quoteIdent).join(',')} FROM ${quoteIdent(table)}`)).rows;
  const sourceSha = checksum(sourceRows, columns);
  const targetSha = checksum(targetRows, columns);
  const match = sourceRows.length === targetRows.length && sourceSha === targetSha;
  ok &&= match;
  results.push({ table, d1: sourceRows.length, postgres: targetRows.length, sourceSha, targetSha, match });
}

if (ok) {
  await pool.query('UPDATE migration_imports SET verified_at=$1 WHERE backup_sha256=$2', [Date.now(), backupSha]);
}
console.log(JSON.stringify({ ok, backupSha, tables: results }, null, 2));
db.close();
await pool.end();
if (!ok) process.exitCode = 2;

