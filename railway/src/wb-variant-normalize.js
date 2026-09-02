export function normalizeWbText(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim().replace(/\s+/g, ' ');
}

export function wbCardSearchText(card) {
  return normalizeWbText([
    card?.title,
    card?.vendorCode,
    card?.nmId,
    card?.color,
    ...(Array.isArray(card?.sizes) ? card.sizes.flatMap(size => [size?.size, size?.chrtId, size?.barcode, ...(size?.barcodes || [])]) : [])
  ].join(' '));
}

function characteristicText(card, wanted) {
  const hit = (Array.isArray(card?.characteristics) ? card.characteristics : []).find(row => normalizeWbText(row?.name).includes(wanted));
  const value = hit?.value;
  return Array.isArray(value) ? value.map(String).join(', ') : String(value || '');
}

export function normalizeWbCard(card) {
  const sizes = [];
  for (const size of Array.isArray(card?.sizes) ? card.sizes : []) {
    const chrtId = Number(size?.chrtID || size?.chrtId || 0);
    const barcodes = [...new Set((Array.isArray(size?.skus) ? size.skus : []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!chrtId || !barcodes.length) continue;
    sizes.push({ size: String(size?.techSize || size?.wbSize || size?.origName || '').trim() || 'Без размера', chrtId, barcode: barcodes[0], barcodes, amount: null });
  }
  return {
    nmId: String(card?.nmID ?? card?.nmId ?? '').trim(),
    vendorCode: String(card?.vendorCode || '').trim(),
    title: String(card?.title || card?.subject || card?.object || card?.vendorCode || '').trim(),
    color: characteristicText(card, 'цвет') || String(card?.vendorCode || '').trim(),
    sizes
  };
}
