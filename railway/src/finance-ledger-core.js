const BALANCE_TYPES = new Set(['income','expense','transit_in','transit_out','transfer','adjustment']);

export function financeTransactionType(value) {
  return String(value?.type || value?.kind || '').trim();
}

export function financeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function financePositive(value) {
  return Math.abs(financeNumber(value, 0));
}

export function financeTransactionEffects(transaction) {
  const tx = transaction && typeof transaction === 'object' ? transaction : {};
  if (tx.affectsBalance === false) return [];
  const type = financeTransactionType(tx);
  if (!BALANCE_TYPES.has(type)) throw Object.assign(new Error('Unsupported finance transaction type'), { status: 400 });

  const accountId = String(tx.accountId || '').trim();
  const toAccountId = String(tx.toAccountId || '').trim();
  const amount = financePositive(tx.amount);
  if (!accountId) throw Object.assign(new Error('Finance transaction account is required'), { status: 400 });

  if (type === 'adjustment') {
    const signed = financeNumber(tx.amount, NaN);
    if (!Number.isFinite(signed) || Math.abs(signed) < 0.0000001) throw Object.assign(new Error('Adjustment amount must be non-zero'), { status: 400 });
    const rawDefault = financeNumber(tx.defaultAmount, NaN);
    const defaultDelta = Number.isFinite(rawDefault) ? Math.abs(rawDefault) * Math.sign(signed) : NaN;
    return [{ accountId, delta: signed, defaultDelta }];
  }

  if (!(amount > 0)) throw Object.assign(new Error('Finance transaction amount must be greater than zero'), { status: 400 });

  const defaultAmount = financePositive(tx.defaultAmount);
  if (type === 'income' || type === 'transit_in') return [{ accountId, delta: amount, defaultDelta: defaultAmount || NaN }];
  if (type === 'expense' || type === 'transit_out') return [{ accountId, delta: -amount, defaultDelta: defaultAmount ? -defaultAmount : NaN }];

  if (!toAccountId || toAccountId === accountId) throw Object.assign(new Error('Transfer requires a different destination account'), { status: 400 });
  const toAmount = financePositive(tx.toAmount) || amount;
  const toDefaultAmount = financePositive(tx.toDefaultAmount);
  return [
    { accountId, delta: -amount, defaultDelta: defaultAmount ? -defaultAmount : NaN },
    { accountId: toAccountId, delta: toAmount, defaultDelta: toDefaultAmount || (defaultAmount && toAmount === amount ? defaultAmount : NaN) }
  ];
}

export function financeMergeEffects(effects = []) {
  const out = new Map();
  for (const effect of effects) {
    const id = String(effect?.accountId || '').trim();
    if (!id) continue;
    const prev = out.get(id) || { accountId:id, delta:0, defaultDelta:0, hasDefault:false };
    prev.delta += financeNumber(effect.delta, 0);
    if (Number.isFinite(Number(effect.defaultDelta))) {
      prev.defaultDelta += Number(effect.defaultDelta);
      prev.hasDefault = true;
    }
    out.set(id, prev);
  }
  return [...out.values()];
}
