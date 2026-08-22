export function wbOrderIsActive(status, state) {
  const supplier = String(status || '').trim().toLowerCase();
  const wb = String(state || '').trim().toLowerCase();

  // "complete" means that the seller has already handed the parcel over.
  // It can remain in WB "waiting" for a while, but it must no longer reserve
  // physical warehouse stock.
  if (['complete', 'cancel'].includes(supplier)) return false;
  if (['sorted', 'sold', 'canceled', 'cancelled', 'canceled_by_client', 'cancelled_by_client',
    'declined_by_client', 'defect', 'ready_for_pickup', 'canceled_by_missed_call',
    'cancelled_by_missed_call'].includes(wb)) return false;
  return ['new', 'confirm'].includes(supplier) && wb === 'waiting';
}
