export function wbOrderIsActive(status, state) {
  const supplier = String(status || '').trim().toLowerCase();
  const wb = String(state || '').trim().toLowerCase();

  // COMPLETE means the seller finished assembly, but WB has not necessarily
  // accepted the parcel yet. While WB still reports WAITING the goods remain
  // physically on our warehouse and must stay reserved.
  if (supplier === 'cancel') return false;
  if (['sorted', 'sold', 'canceled', 'cancelled', 'canceled_by_client', 'cancelled_by_client',
    'declined_by_client', 'defect', 'ready_for_pickup', 'canceled_by_missed_call',
    'cancelled_by_missed_call'].includes(wb)) return false;
  return ['new', 'confirm', 'complete'].includes(supplier) && wb === 'waiting';
}

export function wbOrderIsCollected(status, state) {
  const supplier = String(status || '').trim().toLowerCase();
  const wb = String(state || '').trim().toLowerCase();
  if (supplier === 'cancel') return false;
  if (['canceled', 'cancelled', 'canceled_by_client', 'cancelled_by_client',
    'declined_by_client', 'defect', 'canceled_by_missed_call',
    'cancelled_by_missed_call'].includes(wb)) return false;
  return ['sorted', 'accepted_by_carrier', 'sent_to_carrier', 'ready_for_pickup', 'sold'].includes(wb);
}
