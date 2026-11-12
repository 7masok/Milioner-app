export function purchaseSaleResult(order, operations = [], promotionReady = false) {
  const qty = Number(order.qty);
  if (!(qty > 0)) return null;
  const status = String(order.status || '').toLowerCase();
  const state = String(order.state || '').toLowerCase();
  if (order.market === 'Kaspi') {
    // The stored order feed does not include settled Kaspi fees.
    const sold = status === 'completed' ? qty : 0;
    return { sold, proceeds: null };
  }
  const cancelled = ['cancel', 'cancelled', 'canceled', 'returned'].includes(status)
    || /^(cancell?ed(?:_by_.*)?|declined_by_client|defect|return.*)$/.test(state);
  const realized = operations.filter(row => row.kind === 'sale' || row.kind === 'return');
  if (!realized.length) return { sold: !cancelled && state === 'sold' ? qty : 0, proceeds: null };
  const sold = realized.reduce((sum, row) => sum + row.saleQty - row.returnQty, 0);
  if (!Number.isFinite(sold) || sold < 0 || sold > qty) return { sold: 0, proceeds: null };
  const ready = (!cancelled || sold === 0) && promotionReady && operations.every(row =>
    !row.adUnknown && row.currency === 'KZT' && Number.isFinite(row.beforeAdsAndCost)
    && (row.orderAdvertising == null || Number.isFinite(row.orderAdvertising)));
  return { sold: cancelled ? 0 : sold, proceeds: ready ? operations.reduce((sum, row) => sum + row.beforeAdsAndCost - (row.orderAdvertising ?? 0), 0) : null };
}
