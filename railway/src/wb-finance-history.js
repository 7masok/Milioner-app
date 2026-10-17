// Runs under the same per-market advisory lock as the normal finance sync.
// Only report rows are written: this worker never reconciles warehouse sales.
export const WB_FINANCE_SLOT_MS = 12 * 60 * 60 * 1000 + 60_000;
const DAY = 86_400_000;
const dateKey = time => new Date(time + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function financePageRows(payload) {
  if (payload?.__noContent === true) return [];
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'rows', 'items', 'reports', 'result']) {
      if (payload[key] !== undefined) return financePageRows(payload[key]);
    }
  }
  throw new Error('WB finance: invalid report response');
}

export function initialFinanceHistory(now, previousRequestAt = 0) {
  return {
    archive: { dateFrom: dateKey(now - 364 * DAY), dateTo: dateKey(now), cursor: 0, rows: 0, complete: false },
    recent: null, nextKind: 'archive',
    nextAllowedAt: previousRequestAt ? previousRequestAt + WB_FINANCE_SLOT_MS : 0,
    lastError: '', updatedAt: now
  };
}

export function financeHistoryStatus(state) {
  if (!state?.archive) return { status: 'pending' };
  return { status: state.archive.complete ? 'complete' : state.lastError ? 'retry' : 'loading',
    dateFrom: state.archive.dateFrom, dateTo: state.archive.dateTo,
    rows: state.archive.rows, nextAllowedAt: state.nextAllowedAt,
    // A completed archive must not be labelled failed by a later recent refresh.
    error: state.archive.complete ? '' : state.lastError,
    scope: 'wb-financial-reports' };
}

export async function syncFinanceHistoryPage({ client, market, now = Date.now(), previousRequestAt = 0, fetchPage, saveRows }) {
  const stored = await client.query('SELECT state FROM wb_finance_history WHERE market=$1', [market]);
  const state = stored.rows[0]?.state || initialFinanceHistory(now, previousRequestAt);
  const persist = () => client.query(`INSERT INTO wb_finance_history(market,state) VALUES($1,$2::jsonb)
    ON CONFLICT(market) DO UPDATE SET state=excluded.state`, [market, JSON.stringify(state)]);
  if (now < Number(state.nextAllowedAt)) {
    if (!stored.rows.length) await persist();
    return { skipped: true, nextAt: state.nextAllowedAt, history: financeHistoryStatus(state) };
  }
  const kind = state.archive.complete ? 'recent' : state.nextKind;
  if (kind === 'recent' && !state.recent) state.recent = { dateFrom: dateKey(now - 45 * DAY), dateTo: dateKey(now), cursor: 0 };
  const job = state[kind];
  // Reserve BEFORE the network call: a restart cannot cause a duplicate burst.
  state.nextAllowedAt = now + WB_FINANCE_SLOT_MS;
  state.updatedAt = now;
  await persist();
  try {
    const page = await fetchPage({ dateFrom: job.dateFrom, dateTo: job.dateTo, rrdId: job.cursor, limit: 100000, period: 'daily' });
    if (!Array.isArray(page)) throw new Error('WB finance: invalid report response');
    let next = job.cursor, pruned = 0;
    if (page.length) {
      const ids = page.map(row => Number(row?.rrdId ?? row?.rrd_id));
      if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('WB finance: invalid row cursor');
      next = ids[ids.length - 1];
      if (next <= job.cursor) throw new Error('WB finance: report cursor did not advance');
      // Idempotent upserts, without deleting other pages or older reports.
      const saved = await saveRows(page, { prune: kind === 'recent' && job.cursor === 0 && page.length < 100000 });
      pruned = Number(saved?.pruned || 0);
    }
    job.cursor = next;
    if (kind === 'archive') {
      job.rows += page.length;
      // Even a short page is followed to an empty response before claiming a year.
      if (!page.length) job.complete = true;
      state.nextKind = 'recent';
    } else {
      if (page.length < 100000) state.recent = null;
      state.nextKind = 'archive';
    }
    state.lastError = '';
    state.updatedAt = now;
    await persist();
    return { saved: page.length, pruned, skipped: false, nextAt: state.nextAllowedAt, history: financeHistoryStatus(state) };
  } catch (error) {
    // Leave the cursor unchanged when fetching/saving failed. A repeat upsert is safe.
    state.lastError = String(error?.message || error).slice(0, 500);
    state.nextKind = kind === 'archive' ? 'recent' : 'archive';
    state.nextAllowedAt = Math.max(state.nextAllowedAt, Number(error?.retryAt) || 0);
    await persist();
    error.retryAt = state.nextAllowedAt;
    throw error;
  }
}
