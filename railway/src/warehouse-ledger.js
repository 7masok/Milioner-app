function rows(value) {
  return Array.isArray(value) ? value : [];
}

function keyedMovements(value) {
  return rows(value).filter(row => String(row?.id || ''));
}

export function stockLedgerViolation(previous, next, now = Date.now()) {
  const oldState = previous && typeof previous === 'object' ? previous : {};
  const nextState = next && typeof next === 'object' ? next : {};
  const oldRows = keyedMovements(oldState.movements), nextRows = keyedMovements(nextState.movements);
  const oldMovements = new Map(oldRows.map(row => [String(row.id), row]));
  const nextMovements = new Map(nextRows.map(row => [String(row.id), row]));
  const removedRows = oldRows.filter(row => !nextMovements.has(String(row.id)));

  // Movement history is a permanent stock audit trail. Normal writes may append
  // new rows or edit an existing adjustment, but must never silently discard an
  // older movement. This also catches stale clients that still trim at 1,000 rows.
  if (removedRows.length) {
    return {
      reason: 'movement-history-removed',
      movementIds: removedRows.slice(0, 10).map(row => String(row.id)),
      removedCount: removedRows.length
    };
  }

  const movementDelta = new Map();
  const ids = new Set([...oldMovements.keys(), ...nextMovements.keys()]);
  for (const id of ids) {
    const before = oldMovements.get(id), after = nextMovements.get(id), productId = String(after?.productId || before?.productId || '');
    if (!productId) continue;
    const delta = (Number(after?.qty) || 0) - (Number(before?.qty) || 0);
    movementDelta.set(productId, (movementDelta.get(productId) || 0) + delta);
  }

  const oldProducts = new Map(rows(oldState.products).map(row => [String(row?.id || ''), row]).filter(([id]) => id));
  for (const product of rows(nextState.products)) {
    const id = String(product?.id || ''), before = oldProducts.get(id);
    if (!id || !before) continue;
    const stockDelta = (Number(product?.stock) || 0) - (Number(before?.stock) || 0), loggedDelta = movementDelta.get(id) || 0;
    if (Math.abs(stockDelta - loggedDelta) > 0.000001) return { reason: 'stock-change-without-movement', productId: id, stockDelta, loggedDelta };
  }
  return null;
}
