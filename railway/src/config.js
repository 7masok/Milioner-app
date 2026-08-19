function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export const config = Object.freeze({
  port: Math.max(1, Number(process.env.PORT || 3000)),
  databaseUrl: String(process.env.DATABASE_URL || ''),
  corsOrigin: String(process.env.CORS_ORIGIN || 'https://7masok.github.io').replace(/\/$/, ''),
  writesEnabled: bool('WAREHOUSE_WRITES_ENABLED', false),
  marketSyncEnabled: bool('MARKET_SYNC_ENABLED', false),
  adminToken: String(process.env.APP_ADMIN_TOKEN || ''),
  kaspiToken: String(process.env.KASPI_TOKEN || ''),
  kaspiWorkerUrl: String(process.env.KASPI_WORKER_URL || '').replace(/\/$/, ''),
  wbToken: String(process.env.WB_TOKEN || ''),
  wbToken2: String(process.env.WB_TOKEN_2 || ''),
  wbWorkerUrl: String(process.env.WB_WORKER_URL || '').replace(/\/$/, ''),
  wbWarehouseId: String(process.env.WB_WAREHOUSE_ID || ''),
  wbWarehouseId2: String(process.env.WB_WAREHOUSE_ID_2 || '')
});

export function assertRuntimeConfig() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (!/^https:\/\//i.test(config.corsOrigin)) throw new Error('CORS_ORIGIN must be an HTTPS origin');
}

