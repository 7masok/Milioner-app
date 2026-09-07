// Pure link validation. A barcode/characteristic is not permission to follow a
// renamed seller article. Only an explicit new link can establish a new identity.
export function linkFingerprint(product, field) {
  return JSON.stringify([product[field] || '', product[field + 'Aliases'] || [],
    product[field + 'Identity'] || null,
    product.wbVariant?.market === (field === 'wb2' ? 'WB2' : 'WB') ? product.wbVariant : null]);
}

export function validateWbLink(product, field, cards) {
  const sku = String(product[field] || '').trim();
  if (!sku) return null;
  const market = field === 'wb2' ? 'WB2' : 'WB';
  const identity = product[field + 'Identity'];
  const variant = product.wbVariant?.market === market ? product.wbVariant : null;
  const expected = String(identity?.vendorCode || variant?.vendorCode || '').trim();
  const chrtId = Number(identity?.chrtId || variant?.chrtId || 0);
  const byId = chrtId ? cards.find(c => c.sizes.some(s => Number(s.chrtId) === chrtId)) : null;
  const exact = cards.filter(c => c.vendorCode === sku);
  const barcode = cards.filter(c => c.sizes.some(s => (s.barcodes || []).includes(sku)));
  const card = byId || (exact.length === 1 ? exact[0] : barcode.length === 1 ? barcode[0] : null);
  if (!card || (expected && card.vendorCode !== expected)
      || (!expected && !barcode.includes(card) && card.vendorCode !== sku)) {
    return { valid: false, oldSku: sku, currentSku: card?.vendorCode || '',
      reason: card ? 'seller-article-changed' : 'seller-article-not-found' };
  }
  const size = card.sizes.find(s => Number(s.chrtId) === chrtId)
    || card.sizes.find(s => (s.barcodes || []).includes(sku))
    || (card.sizes.length === 1 ? card.sizes[0] : null);
  if (!size) return { valid: false, oldSku: sku, currentSku: card.vendorCode, reason: 'variant-needs-confirmation' };
  return { valid: true, identity: { vendorCode: card.vendorCode, nmId: card.nmId, chrtId: Number(size.chrtId) } };
}

export function applyLinkObservation(product, field, observation, now) {
  if (observation.valid) {
    if (JSON.stringify(product[field + 'Identity']) === JSON.stringify(observation.identity) && !product[field + 'RelinkRequired']) return false;
    product[field + 'Identity'] = observation.identity;
    delete product[field + 'RelinkRequired'];
    return true;
  }
  product[field + 'RelinkRequired'] = { ...observation, at: now,
    oldAliases: product[field + 'Aliases'] || [], previousVariant: product.wbVariant || null };
  product[field] = '';
  product[field + 'Aliases'] = [];
  delete product[field + 'Identity'];
  if (product.wbVariant?.market === (field === 'wb2' ? 'WB2' : 'WB')) delete product.wbVariant;
  product._syncUpdatedAt = now;
  return true;
}

export function staleWbLinkRestored(previous, next) {
  const oldById = new Map((previous.products || []).map(p => [String(p.id), p]));
  for (const product of next.products || []) {
    const old = oldById.get(String(product.id));
    for (const field of ['wb', 'wb2']) {
      const invalid = old?.[field + 'RelinkRequired'];
      if (invalid && product[field] && String(product[field]).trim() === invalid.oldSku)
        return { productId: product.id, market: field === 'wb2' ? 'WB2' : 'WB', reason: 'stale-wb-link' };
    }
  }
  return null;
}

export function preserveWbValidation(previous, next) {
  const oldById = new Map((previous.products || []).map(p => [String(p.id), p]));
  for (const p of next.products || []) {
    const old = oldById.get(String(p.id));
    for (const f of ['wb', 'wb2']) {
      if (old?.[f + 'RelinkRequired'] && !p[f]) {
        p[f + 'RelinkRequired'] = old[f + 'RelinkRequired'];
        p[f + 'Aliases'] = [];
        delete p[f + 'Identity'];
        if (p.wbVariant?.market === (f === 'wb2' ? 'WB2' : 'WB')) delete p.wbVariant;
      } else if (old?.[f + 'Identity'] && p[f] === old[f]) {
        p[f + 'Identity'] = old[f + 'Identity'];
      } else {
        // Identity belongs to the server-validated article, not a client edit.
        delete p[f + 'Identity'];
      }
    }
  }
}
