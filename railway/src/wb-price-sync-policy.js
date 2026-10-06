// One external request per persisted slot. Reads must not be starved by writes
// or by an upload whose history no longer contains every requested product.
export function wbPriceSyncAction(state, queue, snapshot, now, slotMs) {
  if (Number(state.readOffset) > 0) return 'read';
  if (queue.some(row => row.status === 'sent' && Number(row.uploadId) > 0)) {
    return String(state.lastAction || '').startsWith('verify') ? 'read' : 'verify';
  }
  if (queue.some(row => row.status === 'checking')) return 'read';
  if (queue.some(row => row.status === 'pending')) {
    // A completed read is followed by a write in the NEXT permitted slot.
    // Its snapshot is necessarily older than one slot by then (timer jitter).
    // After a failed read, verification, or long downtime, refresh first.
    const fetchedAt = Number(snapshot?.fetchedAt || 0);
    const completedRead = state.lastAction === 'read';
    const age = now - fetchedAt;
    return completedRead && fetchedAt > 0 && age >= 0 && age <= 2 * slotMs ? 'write' : 'read';
  }
  return 'read';
}

export function wbPriceRetryAfterRead(queued, now, slotMs) {
  return ['sent', 'checking'].includes(queued.status) &&
    Number(queued.sentAt) > 0 && now - Number(queued.sentAt) >= 2 * slotMs;
}
