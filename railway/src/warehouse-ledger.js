function rows(value) {
  return Array.isArray(value) ? value : [];
}

function keyedMovements(value) {
  return rows(value).filter(row => String(row?.id || ''));
}

function warehouseMovementIdentity(row) {
  return JSON.stringify([row?.stockScope, row?.type, String(row?.productId || ''), Number(row?.qty),
    rows(row?.warehouseLots).map(lot => [String(lot.purchaseId || ''), Number(lot.qty), Number(lot.unitCost)])]);
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

  const movementDelta = new Map(), warehouseLots = new Map();
  const ids = new Set([...oldMovements.keys(), ...nextMovements.keys()]);
  for (const id of ids) {
    const before = oldMovements.get(id), after = nextMovements.get(id), productId = String(after?.productId || before?.productId || '');
    if (!productId) continue;
    // Warehouse-only units have not entered product.stock or received FIFO.
    // Their negative movement must match the written-off count of exact lots.
    if (before?.stockScope === 'at_warehouse' || after?.stockScope === 'at_warehouse') {
      if (before) {
        if (warehouseMovementIdentity(before) !== warehouseMovementIdentity(after)) return { reason: 'warehouse-writeoff-edited', movementId: id };
        continue;
      }
      const qty = Number(after.qty), lots = rows(after.warehouseLots);
      if (after.type !== 'списание' || !Number.isInteger(qty) || qty >= 0 || !lots.length) return { reason: 'invalid-warehouse-writeoff', movementId: id };
      let total = 0;
      for (const lot of lots) {
        const purchaseId = String(lot.purchaseId || ''), count = Number(lot.qty);
        if (!purchaseId || !Number.isInteger(count) || count <= 0) return { reason: 'invalid-warehouse-writeoff', movementId: id };
        const entry = warehouseLots.get(purchaseId) || { productId, qty: 0 };
        if (entry.productId !== productId) return { reason: 'invalid-warehouse-writeoff', movementId: id };
        entry.qty += count; warehouseLots.set(purchaseId, entry); total += count;
      }
      if (total !== -qty) return { reason: 'invalid-warehouse-writeoff', movementId: id };
      continue;
    }
    const delta = (Number(after?.qty) || 0) - (Number(before?.qty) || 0);
    movementDelta.set(productId, (movementDelta.get(productId) || 0) + delta);
  }

  const oldPurchases = new Map(rows(oldState.purchases).map(row => [String(row.id || ''), row]));
  const nextPurchases = new Map(rows(nextState.purchases).map(row => [String(row.id || ''), row]));
  for (const purchaseId of new Set([...oldPurchases.keys(), ...nextPurchases.keys(), ...warehouseLots.keys()])) {
    const before = oldPurchases.get(purchaseId), after = nextPurchases.get(purchaseId);
    const oldCount = Number(before?.warehouseWrittenOffQty || 0), count = Number(after?.warehouseWrittenOffQty || 0), expected = warehouseLots.get(purchaseId);
    if (oldCount === 0 && count === 0 && !expected) continue;
    if (!after || !Number.isInteger(count) || count < 0 || !Number.isFinite(Number(after.qty)) || count > Number(after.qty) || after.status !== 'at_warehouse'
      || count - oldCount !== (expected?.qty || 0)
      || before?.productId !== after.productId
      || expected && (expected.productId !== String(after.productId) || before?.status !== 'at_warehouse')) {
      return { reason: 'warehouse-writeoff-without-lot', purchaseId };
    }
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
