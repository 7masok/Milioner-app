import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWarehousePayload, snapshotSummary, parseBccStatement } from '../src/ai-assistant.js';

test('GPT context parses warehouse JSON stored as text', () => {
  const raw=JSON.stringify({products:[{id:'p1',name:'Рулетка',stock:7,min:3,kaspi:'123'}],sales:[{productId:'p1',qty:2,channel:'Kaspi',date:10}]});
  assert.equal(parseWarehousePayload(raw).products[0].name,'Рулетка');
  const context=snapshotSummary(raw,[{market:'Kaspi',order_id:'o1',product_name:'Рулетка',qty:1,creation_date:20}]);
  assert.deepEqual(context.counts,{products:1,purchases:0,sales:1,orders:1});
  assert.equal(context.products[0].stock,7);
  assert.equal(context.sales[0].market,'Kaspi');
  assert.equal(context.orders[0].name,'Рулетка');
});

test('GPT context tolerates an invalid warehouse payload', () => {
  const context=snapshotSummary('{broken');
  assert.equal(context.counts.products,0);
});


test('BCC statement parser reads posted operations and skips blocked ones', () => {
  const text = `
"Банк ЦентрКредит" АҚ
БИК: KCJBKZKX
Шот бойынша үзінді KZ088562204150156670
Валюта KZT
Карта 489993******2297
Кезеңі 20.09.2026 - 20.09.2026
2026-09- 2026-09-20 Аударым Тимур К. 45 000.00 -45 000.00 0.00 0.00
20 KZT KZT KZT KZT
2026-09- 2026-09-20 Төлем 120.00 -120.00 0.00 0.00
20 KZT KZT KZT KZT
2026-09- 2026-09-20 Аударым 7 553.21 -7 553.21 0.00 0.00
20 KZT KZT KZT KZT
Блоктағы транзакциялар
20.09.2026 күтілуде BARIK MINIMARKET 51 1 565.00 күтілуде
19:59:26 KZT
19.09.2026 күтілуде ZERDE PHARMA ЖШС 1 800.00 күтілуде
18:16:06 KZT
`;
  const result = parseBccStatement(text,'source-hash','bcc.pdf');
  assert.ok(result);
  assert.equal(result.statement.bank,'Bank CenterCredit');
  assert.equal(result.statement.currency,'KZT');
  assert.equal(result.statement.pendingCount,2);
  assert.equal(result.transactions.length,3);
  assert.equal(result.transactions.reduce((sum,x)=>sum+x.amount,0),52673.21);
  assert.equal(result.transactions[0].type,'expense');
  assert.equal(result.transactions[0].title,'Аударым Тимур К.');
});
