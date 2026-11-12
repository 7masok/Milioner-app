export function trackNewPurchaseLots(previous, incoming) {
  const previousById = new Map(previous.map(row => [String(row.id), row]));
  const previousShipments = new Map(previous.map(row => [String(row.shipmentId || row.id), row.purchaseRealizationTracked === true]));
  for (const row of incoming) {
    const old = previousById.get(String(row.id));
    const shipment = String(row.shipmentId || row.id || '');
    const ordinary = shipment && !row.opening && !row.inventoryAdjustment && !row.returnAdjustment && !row.relocation;
    const tracked = old ? old.purchaseRealizationTracked === true : (previousShipments.get(shipment) ?? Boolean(ordinary));
    if (tracked && ordinary) row.purchaseRealizationTracked = true;
    else delete row.purchaseRealizationTracked;
  }
}

export function consumeTrackedPurchaseLots(purchases, productId, stock, qty) {
  if (!(qty > 0 && qty <= stock)) return [];
  const lots = purchases.filter(row => String(row.productId) === String(productId)
    && row.status === 'received' && Number(row.remainingQty) > 0);
  // The old automatic flow did not debit remainingQty. Until the physical
  // quantity matches the new lots, a sale cannot prove which lot supplied it.
  if (lots.some(row => row.purchaseRealizationTracked !== true)
    || lots.reduce((sum, row) => sum + Number(row.remainingQty), 0) !== stock) return [];
  if (lots.some(row => row.landedUnitCost == null || row.landedUnitCost === ''
    || !Number.isFinite(Number(row.landedUnitCost)) || Number(row.landedUnitCost) < 0)) return [];
  lots.sort((a, b) => Number(a.receivedAt || a.date || 0) - Number(b.receivedAt || b.date || 0)
    || String(a.id).localeCompare(String(b.id)));
  const used = [];
  for (const lot of lots) {
    const take = Math.min(qty, Number(lot.remainingQty));
    used.push({ purchaseId: String(lot.id), qty: take, unitCost: Number(lot.landedUnitCost) });
    lot.remainingQty -= take;
    qty -= take;
    if (qty === 0) break;
  }
  return used;
}

export function restoreTrackedPurchaseLots(purchases, used) {
  const lots = new Map(purchases.map(row => [String(row.id), row]));
  const changes = new Map();
  for (const part of used) {
    const lot = lots.get(String(part.purchaseId));
    const qty = Number(part.qty);
    const remaining = (changes.get(lot) ?? Number(lot?.remainingQty)) + qty;
    if (!lot?.purchaseRealizationTracked || !(qty > 0)
      || !Number.isFinite(remaining) || remaining > Number(lot.qty)) return [];
    changes.set(lot, remaining);
  }
  for (const [lot, remaining] of changes) lot.remainingQty = remaining;
  return [...changes.keys()];
}
