// One external request per persisted slot. Reads must not be starved by writes
// or by an upload whose history no longer contains every requested product.
export function wbPriceSyncAction(state, queue, snapshot, now, slotMs) {
  if (Number(state.readOffset) > 0) return 'read';
  if (queue.some(row => row.status === 'sent' && Number(row.uploadId) > 0)) {
    return String(state.lastAction || '').startsWith('verify') ? 'read' : 'verify';
  }
  if (queue.some(row => row.status === 'checking')) return 'read';
  if (queue.some(row => row.status === 'pending')) {
    return now - Number(snapshot?.fetchedAt || 0) > slotMs ? 'read' : 'write';
  }
  return 'read';
}

export function wbPriceRetryAfterRead(queued, now, slotMs) {
  return ['sent', 'checking'].includes(queued.status) &&
    Number(queued.sentAt) > 0 && now - Number(queued.sentAt) >= 2 * slotMs;
}
