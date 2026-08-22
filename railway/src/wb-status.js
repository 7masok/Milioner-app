export function wbOrderIsActive(status, state) {
  const supplier = String(status || '').trim().toLowerCase();
  const wb = String(state || '').trim().toLowerCase();

  // While WB still says "waiting", supplier status "complete" only means
  // assembly is complete. The parcel has not entered WB delivery yet and must
  // remain reserved in the seller warehouse.
  if (supplier === 'cancel') return false;
  if (['sorted', 'sold', 'canceled', 'cancelled', 'canceled_by_client', 'cancelled_by_client',
    'declined_by_client', 'defect', 'ready_for_pickup', 'canceled_by_missed_call',
    'cancelled_by_missed_call'].includes(wb)) return false;
  return ['new', 'confirm', 'complete'].includes(supplier) && wb === 'waiting';
}
