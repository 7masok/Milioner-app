import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseKaspiStatement, parseBccStatement } from '../src/ai-assistant.js';

function statement(summary) {
  return `Kaspi Gold
ВЫПИСКА
за период с 01.10.2026 по 08.10.2026
${summary}
Дата Сумма Операция Детали
08.10.2026 12:30 - 1 000,00 ₸ Покупка MAGNUM`;
}
function parse(summary) { return parseKaspiStatement(statement(summary), 'fixture-hash', 'fixture.pdf'); }

for (const [summary, expected] of [
  ['Доступно на 08.10.2026: 456 789,10 ₸', 456789.10],
  ['Доступно\nна 08.10.26\n456\u00a0789,10 ₸', 456789.10],
  ['Доступно: 456\u202f789,10 ₸', 456789.10],
  ['Доступно на Kaspi Gold\n456 789,10 ₸', 456789.10],
  ['Доступно на Kaspi Gold на 08.10.2026:\n456 789,10 ₸', 456789.10],
  ['Остаток на конец периода:\n456 789.10 KZT', 456789.10],
  ['Текущий остаток: −1 234,50 ₸', -1234.50],
  ['Доступно: - 1 234,50 ₸', -1234.50],
  ['Доступно на 08.10.2026: 0,00 ₸', 0],
  ['Доступно: 5 000 ₸\n123456789', 5000],
  ['Остаток на 01.10.2026: 50 000,00 ₸\nОстаток на 08.10.2026: 49 000,00 ₸', 49000],
  ['Начальный остаток: 50 000,00 ₸\nДоступно: 49 000,00 ₸', 49000],
  ['Доступно на 08.10.2026:\nПополнения: 100 000,00 ₸', null],
  ['Доступно на 08.10.2026', null],
  ['Остаток на 01.10.2026: 50 000,00 ₸', null],
  ['Входящий остаток: 50 000,00 ₸', null],
  ['', null],
]) {
  test(`Kaspi balance: ${JSON.stringify(summary)}`, () => {
    const result = parse(summary);
    assert.equal(result.statement.currentBalance, expected);
    const baseline = parse('');
    assert.deepEqual(result.transactions, baseline.transactions, 'balance parsing must preserve operations and duplicate keys');
  });
}

test('Kaspi does not treat operation details as the statement balance', () => {
  const result = parseKaspiStatement(statement('').replace('MAGNUM', 'Остаток: 999 000,00 ₸'), 'fixture-hash', 'fixture.pdf');
  assert.equal(result.statement.currentBalance, null);
  assert.equal(result.transactions.length, 1);
});

test('BCC also preserves an absent closing balance as unknown', () => {
  const result = parseBccStatement(`Банк ЦентрКредит
БИК: KCJBKZKX
Выписка по банковскому счету KZ088562204150156670
Валюта банковского счета KZT
Период выписки 08.10.2026 - 08.10.2026
2026-10-08 2026-10-08 Платёж TEST 120.00 KZT -120.00 KZT 0.00 KZT 0.00KZT`, 'bcc-fixture', 'fixture.pdf');
  assert.ok(result);
  assert.equal(result.statement.currentBalance, null);
});

const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
function source(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf('\n', start));
}
const balance = new Function(source('financeStatementBalance') + ';return financeStatementBalance;')();

test('browser distinguishes unknown balances from a genuine zero', () => {
  for (const value of [null, undefined, '', ' ', false, true, {}, NaN, Infinity]) assert.ok(Number.isNaN(balance({ currentBalance: value })));
  for (const value of [0, '0', -120.5, 456789.10]) assert.equal(balance({ currentBalance: value }), Number(value));
});

test('creating an account derives the opening balance only from a known statement balance', async () => {
  const run = new Function('currentBalance', source('financeStatementBalance') + '\nasync ' + source('financeStatementCreateAccountFromStatement') + `
    const accounts=[];
    const financeStatementDraft={statement:{bank:'Kaspi',accountName:'Kaspi Gold',currency:'KZT',currentBalance},transactions:[{type:'expense',amount:1000,bankOperationKey:'expense'}]};
    function financeVisibleAccounts(){return accounts}
    function financeAccounts(){return accounts}
    async function financeRunLocalMutation(fn){return fn()}
    async function financeStatementRememberAccount(){}
    const document={getElementById(){return null}};
    function alert(message){throw new Error(message)}
    return financeStatementCreateAccountFromStatement().then(()=>accounts[0]);
  `);
  const known = await run(49000);
  assert.equal(known.balance, 50000);
  assert.equal(known.statementExpectedBalance, 49000);
  assert.equal(known.statementOpeningBalanceCalculated, true);
  const unknown = await run(null);
  assert.equal(unknown.balance, 0);
  assert.equal(unknown.statementExpectedBalance, null);
  assert.equal(unknown.statementOpeningBalanceCalculated, false);
  const zero = await run(0);
  assert.equal(zero.balance, 1000);
  assert.equal(zero.statementExpectedBalance, 0);
});

test('preview and final reconciliation use the same unknown-balance guard', () => {
  assert.equal((source('financeStatementPreview').match(/Number\.isFinite\(financeStatementBalance\(statement\)\)/g) || []).length, 2);
  assert.match(source('financeImportStatementDraft'), /statementBalance=financeStatementBalance\(draft.statement\)/);
});
