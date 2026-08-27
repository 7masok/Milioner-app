export function wbOrderIsActive(status, state) {
  const supplier = String(status || '').trim().toLowerCase();
  const wb = String(state || '').trim().toLowerCase();

  // COMPLETE means assembly is finished: the goods are no longer on the shelf
  // and the server sale reconciler consumes them from warehouse stock.
  if (supplier === 'cancel') return false;
  if (['sorted', 'sold', 'canceled', 'cancelled', 'canceled_by_client', 'cancelled_by_client',
    'declined_by_client', 'defect', 'ready_for_pickup', 'canceled_by_missed_call',
    'cancelled_by_missed_call'].includes(wb)) return false;
  return ['new', 'confirm'].includes(supplier) && wb === 'waiting';
}

