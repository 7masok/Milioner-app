export function financeRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'rows', 'items', 'reports', 'result']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const nested = financeRowsFromPayload(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

export function promotionCostRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'rows', 'items', 'result']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

export function promotionCostDay(row) {
  const raw = String(row?.updTime ?? row?.upd_time ?? '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}
