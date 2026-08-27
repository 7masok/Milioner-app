export function kaspiOrderIsActive(status, state) {
  const orderStatus = String(status || '').trim().toUpperCase();
  const orderState = String(state || '').trim().toUpperCase();

  if (['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(orderStatus)) return false;
  if (orderStatus === 'COMPLETED') return false;
  if (['KASPI_DELIVERY_ASSEMBLED', 'DELIVERY', 'KASPI_DELIVERY_TRANSIT', 'ARCHIVE'].includes(orderState)) return false;

  // Once assembly is confirmed the goods have left the warehouse shelf and
  // are recorded as a sale by the server reconciler.
  return true;
}


