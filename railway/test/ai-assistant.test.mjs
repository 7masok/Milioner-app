import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWarehousePayload, snapshotSummary, parseBccStatement, parseKaspiStatement } from '../src/ai-assistant.js';

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


test('BCC statement parser includes blocked operations as spent', () => {
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
  assert.equal(result.statement.blockedImportedCount,1);
  assert.equal(result.transactions.length,4);
  assert.equal(result.transactions.reduce((sum,x)=>sum+x.amount,0),54238.21);
  assert.equal(result.transactions[0].type,'expense');
  assert.equal(result.transactions[0].title,'Аударым Тимур К.');
});


test('BCC English statement parser reads the English app language format', () => {
  const text = `
Bank CenterCredit JSC
BIC: KCJBKZKX
Account statement KZ088562204150156670
Account currency KZT
Account type #bccpay
Payment card number 489993******2297
Statement period 13.09.2026 - 20.09.2026
2026-09-20 2026-09-20 Transfer to Тимур К. 45 000.00 KZT -45 000.00 KZT 0.00 KZT 0.00KZT
2026-09-20 2026-09-20 Payment 120.00 KZT -120.00 KZT 0.00 KZT 0.00KZT
2026-09-14 2026-09-14 Transfer 77 000.00 KZT 77 000.00 KZT 0.00 KZT 0.00KZT
Transactions on hold
20.09.2026 19:59:26 pending BARIK MINIMARKET 51 1 565.00 KZT pending 0.00 KZT
19.09.2026 18:16:06 pending ZERDE PHARMA LLP 1 800.00 KZT pending 0.00 KZT
`;
  const result = parseBccStatement(text,'source-hash-en','bcc-en.pdf');
  assert.ok(result);
  assert.equal(result.statement.language,'en');
  assert.equal(result.statement.accountNumber,'KZ088562204150156670');
  assert.equal(result.statement.accountName,'BCC 489993******2297');
  assert.equal(result.statement.periodStart,'2026-09-13');
  assert.equal(result.statement.periodEnd,'2026-09-20');
  assert.equal(result.statement.pendingCount,2);
  assert.equal(result.statement.blockedImportedCount,2);
  assert.equal(result.transactions.length,5);
  assert.equal(result.transactions[0].date,'2026-09-20');
  assert.equal(result.transactions[0].note,'Перевод');
  assert.equal(result.transactions[2].type,'income');
  assert.equal(result.transactions[2].amount,77000);
});

test('BCC Russian statement parser accepts Russian headings and blocked section', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Тип счета #bccpay
Номер платежной карты 489993******2297
Период выписки 13.09.2026 - 20.09.2026
2026-09-20 2026-09-20 Перевод Тимур К. 45 000.00 KZT -45 000.00 KZT 0.00 KZT 0.00KZT
2026-09-18 2026-09-19 Покупка YANDEX.DELIVERY 1 910.00 KZT -1 910.00 KZT 0.00 KZT 19.10KZT
2026-09-14 2026-09-14 Перевод 77 000.00 KZT 77 000.00 KZT 0.00 KZT 0.00KZT
Заблокированные транзакции
20.09.2026 19:59:26 ожидает BARIK MINIMARKET 51 1 565.00 KZT
`;
  const result = parseBccStatement(text,'source-hash-ru','bcc-ru.pdf');
  assert.ok(result);
  assert.equal(result.statement.language,'ru');
  assert.equal(result.statement.pendingCount,1);
  assert.equal(result.statement.blockedImportedCount,1);
  assert.equal(result.transactions.length,4);
  assert.equal(result.transactions[1].note,'Покупка');
  assert.equal(result.transactions[2].type,'income');
});



test('BCC parser imports a 242000 payment when the PDF splits currency cells across lines', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Период выписки 21.09.2026 - 22.09.2026
2026-09-21 2026-09-21 Платеж 242 000.00 -242 000.0 0.00 KZT 0.00 KZT
 KZT 0 KZT
2026-09-21 2026-09-21 Перевод 83 208.70 KZT -83 208.70 KZT 0.00 KZT 0.00 KZT
2026-09-21 2026-09-21 Перевод 15 000.00 KZT -15 000.00 KZT 0.00 KZT 0.00 KZT
2026-09-21 2026-09-21 Платеж 120.00 KZT -120.00 KZT 0.00 KZT 0.00 KZT
`;
  const result = parseBccStatement(text,'source-hash-242k','bcc-242k.pdf');
  assert.ok(result);
  assert.equal(result.transactions.length,4);
  const payment=result.transactions.find(x=>x.amount===242000);
  assert.ok(payment);
  assert.equal(payment.type,'expense');
  assert.equal(payment.note,'Платёж');
  const total=result.transactions.reduce((sum,x)=>sum+x.amount,0);
  assert.equal(total,340328.70);
});

test('BCC parser repairs a wrapped account amount from the bank PDF table', () => {
  const text = `
Bank CenterCredit JSC
BIC: KCJBKZKX
Account statement KZ088562204150156670
Account currency KZT
Statement period 13.09.2026 - 20.09.2026
2026-09-14 2026-09-14 Payment 153 000.00 -153 000.0 0.00 KZT 0.00KZT
 KZT 0 KZT
`;
  const result = parseBccStatement(text,'source-hash-wrap','bcc-wrap.pdf');
  assert.ok(result);
  assert.equal(result.transactions.length,1);
  assert.equal(result.transactions[0].amount,153000);
  assert.equal(result.transactions[0].type,'expense');
});


test('BCC blocked foreign-currency rows use an explicit rate/cashback anchor and keep original currency', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Период выписки 18.09.2026 - 20.09.2026
Транзакции в блоке
18.09.2026 ожидается 1688.com 29.20 USD 0.00 0.00 131.95 451.9
21:25:37
18.09.2026 ожидается 1688.com 5.69 USD 0.00 0.00 26.67
22:38:38
`;
  const result = parseBccStatement(text,'source-hash-usd','bcc-usd.pdf');
  assert.ok(result);
  assert.equal(result.statement.pendingCount,2);
  assert.equal(result.statement.blockedImportedCount,2);
  assert.equal(result.transactions.length,2);
  assert.equal(result.transactions[0].originalCurrency,'USD');
  assert.equal(result.transactions[0].bankStatus,'blocked');
  assert.ok(result.transactions[0].amount > 13000 && result.transactions[0].amount < 13250);
  assert.equal(result.transactions[1].amountEstimated,true);
  assert.ok(result.transactions[1].amount > 2600 && result.transactions[1].amount < 2750);
  assert.ok(result.transactions[0].bankOperationKey);
});


test('BCC blocked parser joins wrapped merchant/time rows and ignores footer text', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по банковскому счету KZ088562204150156670
Валюта банковского счета KZT
Период выписки 20.09.2026 - 20.09.2026
Транзакции в блоке
20.09.2026    ожидается         BARIK                  1 565.00     0.00         0.00          15.65
 19:59:26                       MINIMARKET 51          KZT

20.09.2026   ожидается   YANDEX.DELIVE   1 270.00     0.00   0.00   12.70
 15:40:29                RY              KZT

16.09.2026   ожидается   IP "BURKIT"     10 200.00    0.00   0.00   102.00
 13:23:35                                KZT

Вице-президент по развитию розничного бизнеса
QR-код содержит веб-ссылку
`;
  const result = parseBccStatement(text,'source-hash-wrap-block','bcc-wrap-block.pdf');
  assert.ok(result);
  assert.equal(result.statement.pendingCount,3);
  assert.equal(result.statement.blockedImportedCount,2);
  assert.equal(result.transactions.length,2);
  assert.equal(result.transactions[0].time,'19:59:26');
  assert.equal(result.transactions[0].title,'BARIK MINIMARKET 51');
  assert.equal(result.transactions[1].time,'15:40:29');
  assert.ok(result.transactions[1].title.includes('YANDEX.DELIVE'));
});


test('BCC blocked transactions outside the requested statement period are not imported', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Период выписки 20.09.2026 - 20.09.2026
2026-09-20 2026-09-20 Платёж 120.00 KZT -120.00 KZT 0.00 KZT 0.00KZT
Транзакции в блоке
20.09.2026 ожидается TODAY SHOP 1 000.00 KZT 0.00 0.00 10.00
19.09.2026 ожидается YESTERDAY SHOP 2 000.00 KZT 0.00 0.00 20.00
18.09.2026 ожидается OLD SHOP 3 000.00 KZT 0.00 0.00 30.00
`;
  const result = parseBccStatement(text,'source-hash-period','bcc-period.pdf');
  assert.ok(result);
  assert.equal(result.statement.pendingCount,3);
  assert.equal(result.statement.blockedImportedCount,1);
  assert.equal(result.transactions.length,2);
  assert.equal(result.transactions[1].date,'2026-09-20');
  assert.equal(result.transactions[1].title,'TODAY SHOP');
});


test('BCC posted operations outside the statement period are also filtered out', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Период выписки 20.09.2026 - 20.09.2026
2026-09-20 2026-09-20 Платёж TODAY 120.00 KZT -120.00 KZT 0.00 KZT 0.00KZT
2026-09-19 2026-09-19 Перевод OLD 5 000.00 KZT -5 000.00 KZT 0.00 KZT 0.00KZT
`;
  const result = parseBccStatement(text,'source-hash-posted-period','bcc-posted-period.pdf');
  assert.ok(result);
  assert.equal(result.transactions.length,1);
  assert.equal(result.transactions[0].date,'2026-09-20');
  assert.equal(result.transactions[0].title,'Платёж TODAY');
});


test('BCC blocked and later posted form of the same operation keep one stable bank key', () => {
  const blockedText = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Период выписки 20.09.2026 - 20.09.2026
Транзакции в блоке
20.09.2026 ожидается BARIK MINIMARKET 51 1 565.00 KZT 0.00 0.00 15.65
19:59:26
`;
  const postedText = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по счету KZ088562204150156670
Валюта счета KZT
Период выписки 20.09.2026 - 20.09.2026
2026-09-20 2026-09-20 Покупка BARIK MINIMARKET 51 1 565.00 KZT -1 565.00 KZT 0.00 KZT 15.65KZT
`;
  const blocked=parseBccStatement(blockedText,'blocked-file-hash','blocked.pdf');
  const posted=parseBccStatement(postedText,'posted-file-hash','posted.pdf');
  assert.ok(blocked?.transactions?.length===1);
  assert.ok(posted?.transactions?.length===1);
  assert.equal(blocked.transactions[0].bankStatus,'blocked');
  assert.equal(posted.transactions[0].bankStatus,'posted');
  assert.equal(blocked.transactions[0].bankOperationKey,posted.transactions[0].bankOperationKey);
  assert.notEqual(blocked.transactions[0].statementFingerprint,posted.transactions[0].statementFingerprint);
});


test('BCC parser reads banking-account heading, spaced card and closing balance', () => {
  const text = `
Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по банковскому счету KZ088562204150156670
Валюта банковского счета KZT
Номер платежной карты 4899 93** **** 2297
Период выписки 20.09.2026 - 20.09.2026
Итоговый остаток: 1 234 567,89 KZT
2026-09-20 2026-09-20 Платёж TEST 120.00 KZT -120.00 KZT 0.00 KZT 0.00KZT
`;
  const result=parseBccStatement(text,'source-hash-requisites','bcc-requisites.pdf');
  assert.ok(result);
  assert.equal(result.statement.accountNumber,'KZ088562204150156670');
  assert.equal(result.statement.iban,'KZ088562204150156670');
  assert.equal(result.statement.cardNumber,'489993******2297');
  assert.equal(result.statement.accountName,'BCC 489993******2297');
  assert.equal(result.statement.currentBalance,1234567.89);
});


test('Kaspi parser exposes account card and balance metadata', () => {
  const text = `
Kaspi Gold
ВЫПИСКА
за период с 20.09.2026 по 20.09.2026
Номер счета: KZ1234567890123456
Номер карты: 4400 12** **** 7788
Доступно: 456 789,10 ₸
Дата Сумма Операция Детали
20.09.2026 12:30 - 1 000,00 ₸ Покупка MAGNUM
`;
  const result=parseKaspiStatement(text,'kaspi-meta','kaspi.pdf');
  assert.ok(result);
  assert.equal(result.statement.accountNumber,'KZ1234567890123456');
  assert.equal(result.statement.iban,'KZ1234567890123456');
  assert.equal(result.statement.cardNumber,'440012******7788');
  assert.equal(result.statement.currentBalance,456789.10);
});
