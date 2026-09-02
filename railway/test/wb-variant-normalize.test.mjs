import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWbCard, wbCardSearchText } from '../src/wb-variant-normalize.js';

test('WB variant card can be found by a size barcode', () => {
  const card = normalizeWbCard({
    nmID: 123,
    vendorCode: 'Кольцо голубое',
    title: 'Кольцо с камнем',
    sizes: [
      { techSize: '17', chrtID: 701, skus: ['2040000000011'] },
      { techSize: '18', chrtID: 702, skus: ['2040000000028'] }
    ]
  });
  assert.match(wbCardSearchText(card), /2040000000028/);
  assert.match(wbCardSearchText(card), /18/);
});

test('manual WB linking creates a separate warehouse child for a size', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../wb-variants-v1.js', import.meta.url), 'utf8'));
  assert.match(source, /variantGroupId:group\.id/);
  assert.match(source, /choosePendingWbVariant/);
  assert.match(source, /attachMarketplaceSku\(product,market,link\.sku\|\|size\.barcode/);
});
