import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOzonMoney, skuSpendFromCsv, skuSpendFromProductReport, skuSpendFromReport, skuSpendFromSkuStats } from '../src/ozon-performance.js';

const source=readFileSync(new URL('../src/ozon-performance.js',import.meta.url),'utf8');

test('Ozon performance money uses a comma decimal', () => {
  assert.equal(parseOzonMoney('7552,97'), 7552.97);
  assert.equal(parseOzonMoney(''), 0);
});

test('Ozon performance report spend stays on the advertised SKU', () => {
  const rows = skuSpendFromReport({
    42307860: { report: { rows: [
      { sku: '4161397839', title: 'Зёрна', moneySpent: '1000,50', orders: '1' },
      { sku: '4161397839', title: 'Зёрна', moneySpent: '10,00', orders: '0' },
      { sku: '2', title: 'Манго', moneySpent: '0,00', orders: '0' }
    ] } }
  });
  assert.deepEqual(rows, [{ sku: '4161397839', title: 'Зёрна', spent: 1010.5, orders: 1 }]);
});


test('direct Ozon SKU statistics aggregate real expense by SKU',()=>{
  const rows=skuSpendFromSkuStats({rows:[
    {sku:'100',expense:'120.50',orders:'2'},
    {sku:'100',expense:'30,25',orders:'1'},
    {sku:'200',expense:'0',orders:'0'}
  ]});
  assert.deepEqual(rows,[{sku:'100',title:'',spent:150.75,orders:3}]);
});

test('Ozon pay-per-order CSV keeps spend on the numeric SKU',()=>{
  const rows=skuSpendFromCsv([
    '; Кампания, период',
    'sku;Название товара;Расход, ₽, с НДС;Заказы',
    '4161397839;Зёрна;1000,50;2',
    'Всего;;;0'
  ].join('\n'));
  assert.deepEqual(rows,[{sku:'4161397839',title:'Зёрна',spent:1000.5,orders:2}]);
});

test('fallback Ozon product report keeps spend on SKU',()=>{
  const rows=skuSpendFromProductReport({
    report:{rows:[
      {sku:'501',name:'Товар 501',expense:'75.5',orders:'1'},
      {sku:'502',name:'Товар 502',expense:'0',orders:'0'}
    ]}
  });
  assert.deepEqual(rows,[{sku:'501',title:'Товар 501',spent:75.5,orders:1}]);
});


test('Ozon advertising requests the exact selected calendar range and product-level SKU report',()=>{
  assert.match(source,/\/api\/client\/statistic\/products\/generate\/json/);
  assert.match(source,/from: from \+ 'T00:00:00\+03:00'/);
  assert.match(source,/to: to \+ 'T23:59:59\+03:00'/);
  assert.match(source,/\/api\/client\/statistics\/products\/sku/);
  assert.match(source,/dateFrom: from/);
  assert.match(source,/dateTo: to/);
  assert.match(source,/totalSpent: rows\.reduce/);
});


test('Ozon Performance quota protection stops daily-limit retry storms for historical reports',()=>{
  assert.match(source,/error\.code = 'DAILY_LIMIT'/);
  assert.match(source,/error\.retryAt = nextMoscowReset\(\)/);
  assert.match(source,/if \(error\.code === 'DAILY_LIMIT'\) throw error/);
  assert.match(source,/performanceCooldown = \{ until: retryAt, error: message \}/);
  assert.match(source,/hit\?\.error && Number\(hit\.retryAt\) > Date\.now\(\)/);
  assert.match(source,/source: 'error'/);
});

test('Ozon direct SKU endpoint is used first for today or yesterday and falls back once to the product report',()=>{
  assert.match(source,/function directRangeAllowed\(from, to\)/);
  assert.match(source,/if \(from !== to\) return false/);
  assert.match(source,/return from === today \|\| from === yesterday/);
  assert.match(source,/if \(directRangeAllowed\(from, to\)\) \{/);
  assert.match(source,/source = 'products-sku'/);
  assert.match(source,/mergeSkuRows\(bySku, await directSkuRows\(token, from, to\)\)/);
  assert.match(source,/source = 'product-report-fallback'/);
  assert.match(source,/mergeSkuRows\(bySku, await enqueue\(\(\) => productReportRows\(token, from, to\)\)\)/);
  assert.match(source,/function campaignBatches/);
  assert.match(source,/advObjectType/);
  assert.match(source,/SEARCH_PROMO/);
  assert.match(source,/\/api\/client\/statistics\/json/);
  assert.match(source,/all_sku_promo\/' \+ kind \+ '\/generate/);
  assert.match(source,/promoReportRows\(token, from, to, 'products'\)/);
  assert.match(source,/promoReportRows\(token, from, to, 'orders'\)/);
  assert.match(source,/reportListRejected/);
  assert.match(source,/skuByPayment/);
  assert.match(source,/campaignIds: batch/);
  assert.match(source,/statisticsReportRows\(token, from, to, batch\)/);
  assert.doesNotMatch(source,/campaignIds: ids\.slice/);
  assert.match(source,/dateFrom: from/);
  assert.match(source,/dateTo: to/);
});

test('Ozon order and supply binding keeps the numeric SKU',()=>{
  const orders=readFileSync(new URL('../../ozon-fbo-v1.js',import.meta.url),'utf8');
  const supplies=readFileSync(new URL('../../ozon-supplies-v1.js',import.meta.url),'utf8');
  assert.match(orders,/const sku=String\(product\.sku\|\|''\)\.trim\(\)\|\|offerId/);
  assert.doesNotMatch(orders,/offerIdPreferred/);
  assert.match(supplies,/preferred=String\(linkContext\.item\.sku\|\|''\)\.trim\(\)\|\|ids\[0\]/);
});

test('Ozon product-report fallback polls conservatively and logs the exact safe failure',()=>{
  assert.match(source,/await new Promise\(resolve => setTimeout\(resolve, 4000\)\)/);
  assert.match(source,/await new Promise\(resolve => setTimeout\(resolve, 7000\)\)/);
  assert.match(source,/error\.code = 'REPORT_FAILED'/);
  assert.match(source,/error\.code = 'REPORT_TIMEOUT'/);
  assert.match(source,/console\.warn\('\[ozon-performance\]'/);
});
