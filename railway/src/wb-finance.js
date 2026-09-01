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
