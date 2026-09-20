import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const indexPath=fileURLToPath(new URL('../../index.html',import.meta.url));
const html=await fs.readFile(indexPath,'utf8');

test('finance analytics UI state is initialized before rendering',()=>{
  assert.match(html,/let financeAnalyticsMode='expense',financeAnalyticsPeriod='year',financeAnalyticsAnchor=new Date\(\),financeHistoryPeriodOverride=null,financePeriodSwipePoint=null;/);
});

test('finance render isolates analytics and journal panels',()=>{
  assert.match(html,/financeRenderPart\('breakdown',renderFinanceBreakdown\)/);
  assert.match(html,/financeRenderPart\('transactions',renderFinanceTransactions\)/);
});

test('finance journal empty state is controlled by renderer',()=>{
  assert.match(html,/По выбранным фильтрам операций нет/);
});

test('uncategorized income and expenses still count in analytics',()=>{
  assert.match(html,/function financeCountsInIncomeExpense\(x\).*return true}/s);
  assert.match(html,/value="__uncategorized__">Без категории/);
});
