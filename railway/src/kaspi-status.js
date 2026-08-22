export function kaspiOrderIsActive(status, state) {
  const orderStatus = String(status || '').trim().toUpperCase();
  const orderState = String(state || '').trim().toUpperCase();

  if (['CANCELLED', 'CANCELLING', 'RETURNED', 'KASPI_DELIVERY_RETURN_REQUESTED'].includes(orderStatus)) return false;
  if (orderStatus === 'COMPLETED') return false;
  if (['DELIVERY', 'KASPI_DELIVERY_TRANSIT', 'ARCHIVE'].includes(orderState)) return false;

  // Packing/assembly still belongs to the seller. Reserve is released only
  // after Kaspi reports that the parcel was transmitted to delivery.
  return true;
}

