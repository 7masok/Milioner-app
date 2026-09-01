export function kaspiOrderIsActive(status, state) {
  const orderStatus = String(status || '').trim().toUpperCase();
  const orderState = String(state || '').trim().toUpperCase();

  if (['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(orderStatus)) return false;
  if (orderStatus === 'COMPLETED') return false;
  if (['DELIVERY', 'KASPI_DELIVERY_TRANSIT', 'ARCHIVE'].includes(orderState)) return false;

  // Assembly does not mean the parcel has left the seller's warehouse. Keep
  // it reserved until Kaspi confirms transmission to delivery.
  return true;
}

export function kaspiOrderIsCollected(status, state) {
  const orderStatus = String(status || '').trim().toUpperCase();
  const orderState = String(state || '').trim().toUpperCase();
  if (['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(orderStatus)) return false;
  return orderStatus === 'COMPLETED' || ['DELIVERY', 'KASPI_DELIVERY_TRANSIT', 'ARCHIVE'].includes(orderState);
}


