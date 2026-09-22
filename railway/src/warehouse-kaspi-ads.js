export function stripKaspiAdExpensesFromState(input) {
  const state = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  delete state.kaspiAdExpenses;
  return state;
}

export function kaspiAdExpenseKey(row) {
  return String(row?.id || row?.importId || [row?.date, row?.day, row?.productId, row?.sku, row?.amount].join('|'));
}

export function normalizedKaspiAdExpense(row) {
  const expense = row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
  const key = kaspiAdExpenseKey(expense);
  if (!key || key === '||||') return null;
  const id = String(expense.id || expense.importId || key).trim();
  if (!id) return null;
  expense.id = id;
  expense.fileName = String(expense.fileName || '');
  expense.amount = Number(expense.amount || 0) || 0;
  expense.importedAt = Number(expense.importedAt || 0) || 0;
  return expense;
}

function uniqueExpenses(rows) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : []).map(normalizedKaspiAdExpense).filter(Boolean)) map.set(kaspiAdExpenseKey(row), row);
  return [...map.values()];
}

export async function readWarehouseKaspiAdExpenses(client) {
  const result = await client.query(`SELECT payload
    FROM warehouse_kaspi_ad_expenses
    ORDER BY imported_at DESC, id DESC`);
  return result.rows.map(row => {
    const payload = row.payload;
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return normalizedKaspiAdExpense(parsed);
  }).filter(Boolean);
}

export async function hydrateKaspiAdExpenses(client, state) {
  const target = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const rows = await readWarehouseKaspiAdExpenses(client);
  if (rows.length) target.kaspiAdExpenses = rows;
  else if (!Array.isArray(target.kaspiAdExpenses)) target.kaspiAdExpenses = [];
  return target;
}

async function removeKeyDuplicates(client, rows) {
  const keys = rows.map(kaspiAdExpenseKey).filter(key => key && key !== '||||');
  if (!keys.length) return;
  await client.query(`DELETE FROM warehouse_kaspi_ad_expenses
    WHERE expense_key = ANY($1::text[])
      AND NOT (id = ANY($2::text[]))`, [keys, rows.map(row => row.id)]);
}

export async function persistKaspiAdExpenses(client, expenses, now = Date.now()) {
  const rows = uniqueExpenses(expenses);
  if (!rows.length) return 0;
  await removeKeyDuplicates(client, rows);
  await client.query(`
    INSERT INTO warehouse_kaspi_ad_expenses(
      id,expense_key,file_name,amount,imported_at,payload,created_at,updated_at
    )
    SELECT
      item->>'id',
      COALESCE(NULLIF(item->>'id',''), NULLIF(item->>'importId',''), CONCAT_WS('|', COALESCE(item->>'date',''), COALESCE(item->>'day',''), COALESCE(item->>'productId',''), COALESCE(item->>'sku',''), COALESCE(item->>'amount',''))),
      COALESCE(item->>'fileName',''),
      CASE WHEN COALESCE(item->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'amount')::double precision ELSE 0 END,
      CASE WHEN COALESCE(item->>'importedAt','') ~ '^-?[0-9]+$' THEN (item->>'importedAt')::bigint ELSE 0 END,
      item,
      CASE WHEN COALESCE(item->>'importedAt','') ~ '^-?[0-9]+$' THEN (item->>'importedAt')::bigint ELSE $2 END,
      $2
    FROM jsonb_array_elements($1::jsonb) AS item
    WHERE COALESCE(item->>'id','') <> ''
    ON CONFLICT(id) DO UPDATE SET
      expense_key=excluded.expense_key,
      file_name=excluded.file_name,
      amount=excluded.amount,
      imported_at=excluded.imported_at,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `, [JSON.stringify(rows), now]);
  return rows.length;
}

export async function deleteKaspiAdExpenses(client, keys) {
  const values = [...new Set((Array.isArray(keys) ? keys : []).map(key => String(key || '').trim()).filter(key => key && key !== '||||'))];
  if (!values.length) return 0;
  const result = await client.query(`DELETE FROM warehouse_kaspi_ad_expenses
    WHERE expense_key = ANY($1::text[]) OR id = ANY($1::text[])`, [values]);
  return result.rowCount || 0;
}

export async function replaceKaspiAdExpenses(client, expenses, now = Date.now()) {
  const rows = uniqueExpenses(expenses);
  if (rows.length) await persistKaspiAdExpenses(client, rows, now);
  const keys = rows.map(kaspiAdExpenseKey).filter(key => key && key !== '||||');
  await client.query('DELETE FROM warehouse_kaspi_ad_expenses WHERE NOT (expense_key = ANY($1::text[]))', [keys]);
  return rows.length;
}
