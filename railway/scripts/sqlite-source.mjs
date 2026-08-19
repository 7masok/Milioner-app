import fs from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js';

export const SOURCE_TABLE_ORDER = [
  'products', 'product_links', 'marketplace_order_lines', 'sync_runs',
  'wb_finance_rows', 'wb_ad_costs', 'wb_finance_sync_runs', 'warehouse_state',
  'stock_sync_runs', 'wb_stock_links', 'wb_stock_state', 'kaspi_price_template',
  'kaspi_sku_aliases', 'kaspi_price_feed_access', 'kaspi_report_orders',
  'kaspi_report_cache_state', 'kaspi_report_returns', 'wb_buyout_cache',
  'wb_sales_live_rows', 'wb_sales_live_state', 'wb_realized_status_tracker',
  'wb_realized_tracker_state', 'wb_dashboard_daily', 'wb_dashboard_daily_state'
];

export function quoteIdent(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

export async function openD1Export(backupPath) {
  const resolved = path.resolve(backupPath);
  const bytes = await fs.readFile(resolved);
  const SQL = await initSqlJs({
    locateFile: file => path.resolve('node_modules/sql.js/dist', file)
  });
  const db = new SQL.Database();
  // D1 exports can contain a warehouse JSON row close to 1 MB. Passing the
  // entire 20+ MB dump to one WASM call can exhaust sql.js linear memory, so
  // execute complete statements incrementally. Wrangler emits INSERT rows on
  // one line and terminates multiline DDL at the end of a line.
  let statement = '';
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!statement && (!trimmed || trimmed.startsWith('--'))) continue;
    statement += (statement ? '\n' : '') + line;
    if (!trimmed.endsWith(';')) continue;
    db.run(statement);
    statement = '';
  }
  if (statement.trim()) db.run(statement);
  return { db, resolved, bytes };
}

export function sqliteRows(db, table) {
  const stmt = db.prepare(`SELECT * FROM ${quoteIdent(table)}`);
  const rows = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

export function sqliteColumns(db, table) {
  const result = db.exec(`PRAGMA table_info(${quoteIdent(table)})`)[0];
  if (!result) return [];
  const nameIndex = result.columns.indexOf('name');
  return result.values.map(row => String(row[nameIndex]));
}
