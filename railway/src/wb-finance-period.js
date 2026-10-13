// API from/to encode the selected calendar dates in Almaty. Financial WB events
// belong to the Moscow calendar; shifting by 2h preserves those existing date labels.
const MOSCOW_TO_ALMATY_DAY_SHIFT = 2 * 3600000;
const eventKinds = new Set(['продажа', 'возврат', 'логистика']);
export function wbFinancePeriodDate(row) {
  let raw = row.raw_json || {};
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  const operation = String(row.operation || row.doc_type || '').trim().toLocaleLowerCase('ru-RU');
  const sale = String(raw.saleDt || raw.sale_dt || '');
  return eventKinds.has(operation) && /^20\d{2}-\d{2}-\d{2}/.test(sale) && Number(row.sale_date) > 0
    ? Number(row.sale_date) - MOSCOW_TO_ALMATY_DAY_SHIFT : Number(row.rr_date) || 0;
}
export function wbFinancePeriodSql(alias = '') {
  const p = alias ? alias + '.' : '';
  return `CASE WHEN lower(COALESCE(NULLIF(btrim(${p}operation),''),btrim(${p}doc_type))) IN ('продажа','возврат','логистика')
    AND COALESCE(NULLIF(${p}raw_json::jsonb->>'saleDt',''),NULLIF(${p}raw_json::jsonb->>'sale_dt',''),'') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}'
    AND ${p}sale_date>0 THEN ${p}sale_date-${MOSCOW_TO_ALMATY_DAY_SHIFT} ELSE ${p}rr_date END`;
}
