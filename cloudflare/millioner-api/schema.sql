-- Millioner server database (Cloudflare D1)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  min_stock INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  total_profit REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS product_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('Kaspi','WB','Ozon')),
  sku TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE (market, sku)
);
CREATE INDEX IF NOT EXISTS idx_product_links_product ON product_links(product_id);

CREATE TABLE IF NOT EXISTS marketplace_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL CHECK (market IN ('Kaspi','WB','Ozon')),
  order_id TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  creation_date INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (market, order_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_order_lines_market_date ON marketplace_order_lines(market, creation_date DESC);
CREATE INDEX IF NOT EXISTS idx_order_lines_market_sku ON marketplace_order_lines(market, sku);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_market_started ON sync_runs(market, started_at DESC);
