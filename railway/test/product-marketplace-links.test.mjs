import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const report = readFileSync(new URL('../../kaspi-report-v2.js', import.meta.url), 'utf8');

test('Products has no comparison overlay or comparison-only report loader', () => {
  assert.doesNotMatch(html, /Сравнить магазины|openProductStoreComparison|product-store-comparison-v1/);
  assert.doesNotMatch(report, /loadComparisonProductBuyouts/);
});

test('product card still shows saved links, aliases and relink requirements', () => {
  const source = html.slice(html.indexOf('function productMarketplaceLinkDetails('), html.indexOf('function syncProductStoreTabs('));
  const window = { unifiedWarehouseEnabled: true };
  const render = vm.runInNewContext(source + '\nproductMarketplaceLinkDetails', { window, esc: String });
  const product = { id: 'inferno:a', wb: 'sku', wb2RelinkRequired: { oldSku: 'old' }, kaspiAliases: ['alias'] };
  const details = render(product);
  assert.match(details, /WB2<\/span> · Нужна перепривязка/);
  assert.match(details, /WB3<\/span> · Привязан/);
  assert.match(details, /Kaspi<\/span> · Привязан/);
  assert.match(details, /Ozon<\/span> · Нет привязки/);
  window.WB3_ONLY = true;
  assert.equal(render(product), '<div><span class="muted">WB3</span> · Привязан</div>');
});
