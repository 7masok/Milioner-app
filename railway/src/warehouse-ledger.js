function rows(value) {
  return Array.isArray(value) ? value : [];
}

function keyedMovements(value) {
  return rows(value).filter(row => String(row?.id || ''));
}

function isAutomaticTailTrim(oldRows, nextRows, removedRows, oldById) {
  if (!removedRows.length || nextRows.length !== 1000) return false;
  const removedCount = removedRows.length;
  if (removedCount > oldRows.length) return false;

  const expectedKeptIds = oldRows.slice(0, oldRows.length - removedCount).map(row => String(row.id));
  const actualKeptIds = nextRows.filter(row => oldById.has(String(row.id))).map(row => String(row.id));
  if (expectedKeptIds.length !== actualKeptIds.length || expectedKeptIds.some((id, index) => id !== actualKeptIds[index])) return false;

  const expectedRemovedIds = new Set(oldRows.slice(-removedCount).map(row => String(row.id)));
  if (removedRows.some(row => !expectedRemovedIds.has(String(row.id)))) return false;

  // The client keeps the newest 1,000 ledger rows. A trim is legitimate only
  // when at least one new movement replaced rows at the oldest tail.
  return nextRows.some(row => !oldById.has(String(row.id)));
}

export function stockLedgerViolation(previous, next, now = Date.now()) {
  const oldState = previous && typeof previous === 'object' ? previous : {};
  const nextState = next && typeof next === 'object' ? next : {};
  const cutoff = now - 45 * 86_400_000;
  const oldRows = keyedMovements(oldState.movements), nextRows = keyedMovements(nextState.movements);
  const oldMovements = new Map(oldRows.map(row => [String(row.id), row]));
  const nextMovements = new Map(nextRows.map(row => [String(row.id), row]));
  const removedRows = oldRows.filter(row => !nextMovements.has(String(row.id)));
  const tailTrim = isAutomaticTailTrim(oldRows, nextRows, removedRows, oldMovements);
  const removedRecent = removedRows.filter(row => Number(row?.date || 0) >= cutoff);
  if (removedRecent.length && !tailTrim) return { reason: 'recent-movement-removed', movementIds: removedRecent.slice(0, 10).map(row => String(row.id)) };

  const movementDelta = new Map();
  const ids = new Set([...oldMovements.keys(), ...nextMovements.keys()]);
  for (const id of ids) {
    // Dropping the oldest rows is storage retention, not a reversal of the
    // stock operations those historical rows describe.
    if (tailTrim && !nextMovements.has(id)) continue;
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
