// Read-only statements use exactly the journal's account/category/type filters.
(function () {
  'use strict';
  const KEY = 'luxar-finance-history-filters-v1';
  const ids = ['financePeriodFilter', 'financeTypeFilter', 'financeAccountFilter', 'financeCategoryFilter', 'financeStatementFrom', 'financeStatementTo'];
  const el = id => document.getElementById(id);
  const value = id => el(id)?.value || '';
  const iso = d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  let restored = false;

  function date(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(0); d.setFullYear(+m[1], +m[2] - 1, +m[3]); d.setHours(0, 0, 0, 0);
    return iso(d) === s ? d : null;
  }
  function operationTime(tx) {
    let s = String(tx.dateIso || tx.date || '');
    const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (ru) s = ru[3] + '-' + ru[2] + '-' + ru[1];
    const d = date(s.slice(0, 10));
    return d ? d.getTime() : financeTransactionTime(tx);
  }
  function bounds() {
    if (value(ids[0]) !== 'custom') return financeHistoryPeriodOverride || financePeriodBounds(value(ids[0]) || 'month');
    const from = date(value(ids[4])), to = date(value(ids[5]));
    if (!from || !to) throw Error('Выбери даты начала и конца.');
    if (from > to) throw Error('Дата начала должна быть не позже даты конца.');
    const end = new Date(to); end.setDate(end.getDate() + 1);
    return {start: from.getTime(), end: end.getTime(), label: from.toLocaleDateString('ru-RU') + ' — ' + to.toLocaleDateString('ru-RU')};
  }
  function remember() {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(ids.map(id => [id, value(id)])))); } catch (_) {}
  }
  function restore() {
    if (restored || !financeHydrated) return;
    restored = true;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
    for (const id of ids) {
      const node = el(id), v = saved[id];
      if (!node || typeof v !== 'string') continue;
      if (node.tagName === 'SELECT' && !Array.from(node.options).some(o => o.value === v)) continue;
      if (node.type === 'date' && !date(v)) continue;
      node.value = v;
    }
    const now = new Date();
    if (!value(ids[4])) el(ids[4]).value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    if (!value(ids[5])) el(ids[5]).value = iso(now);
  }

  financeFilteredTransactions = function () {
    let b; try { b = bounds(); } catch (_) { return []; }
    const type = value(ids[1]) || 'all', account = value(ids[2]) || 'all', category = value(ids[3]) || 'all';
    return financeTransactions().filter(tx => {
      const raw = financeTransactionType(tx), filteredType = tx.refundOfId ? 'expense' : raw;
      const t = operationTime(tx), effective = financeEffectiveCategory(tx);
      if ((b.start || b.end !== Number.MAX_SAFE_INTEGER) && (!t || t < b.start || t >= b.end)) return false;
      if (type !== 'all' && (type === 'transit' ? !['transit_in', 'transit_out'].includes(raw) : filteredType !== type)) return false;
      if (account !== 'all' && String(tx.accountId) !== account && String(tx.toAccountId) !== account) return false;
      if (category === '__uncategorized__' && (effective.categoryId || effective.category)) return false;
      return category === 'all' || category === '__uncategorized__' || String(effective.categoryId) === category;
    }).sort((a, b) => operationTime(b) - operationTime(a) || financeTransactionTime(b) - financeTransactionTime(a));
  };

  function flows(tx, account) {
    const amount = financeTransactionAmount(tx), currency = tx.currency || 'KZT', type = financeTransactionType(tx);
    if (type === 'transfer') {
      const rows = [];
      if (account === 'all' || account === String(tx.accountId)) rows.push({incoming: 0, outgoing: amount, currency, accountId: tx.accountId, counterAccountId: tx.toAccountId});
      if (account === 'all' || account === String(tx.toAccountId)) rows.push({incoming: tx.toAmount == null ? amount : Math.abs(Number(tx.toAmount)), outgoing: 0, currency: tx.toCurrency || currency, accountId: tx.toAccountId, counterAccountId: tx.accountId});
      return rows;
    }
    const incoming = type === 'income' || type === 'transit_in' || (type === 'adjustment' && Number(tx.amount) >= 0);
    return [{incoming: incoming ? amount : 0, outgoing: incoming ? 0 : amount, currency, accountId: tx.accountId}];
  }
  function totals(rows) {
    const amounts = new Map(), account = value(ids[2]) || 'all';
    for (const tx of rows) for (const f of flows(tx, account)) {
      if (!amounts.has(f.currency)) amounts.set(f.currency, {incoming: 0, outgoing: 0});
      const total = amounts.get(f.currency); total.incoming += f.incoming; total.outgoing += f.outgoing;
    }
    return [...amounts].map(([currency, total]) => ({currency, incoming: Math.round(total.incoming * 100) / 100, outgoing: Math.round(total.outgoing * 100) / 100}));
  }
  const money = (n, c) => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(n) + ' ' + (c === 'KZT' ? '₸' : c);
  function summary(rows) {
    return 'Операций: ' + rows.length + totals(rows).map(t => ' · Поступления: ' + money(t.incoming, t.currency) + ' · Списания: ' + money(t.outgoing, t.currency)).join('');
  }
  const renderJournal = renderFinanceTransactions;
  renderFinanceTransactions = function () {
    restore();
    if (el('financeCustomPeriod')) el('financeCustomPeriod').hidden = value(ids[0]) !== 'custom';
    let error = ''; try { bounds(); } catch (e) { error = e.message; }
    renderJournal();
    const rows = financeFilteredTransactions();
    if (el('financeStatementSummary')) el('financeStatementSummary').textContent = error || summary(rows);
    if (el('financeStatementSave')) el('financeStatementSave').disabled = !!error || !rows.length || !financeHydrated;
  };
  document.addEventListener('change', event => {
    if (!ids.includes(event.target.id)) return;
    if (event.target.id === ids[0] || event.target.id === ids[4] || event.target.id === ids[5]) financeClearHistoryPeriodOverride();
    remember(); renderFinanceTransactions();
  });

  const typeNames = {income: 'Доход', expense: 'Расход', transfer: 'Перевод', transit_in: 'Транзит · пришло', transit_out: 'Транзит · ушло', adjustment: 'Корректировка'};
  function record(tx) {
    const category = financeEffectiveCategory(tx), t = operationTime(tx);
    return [t ? new Date(t).toLocaleDateString('ru-RU') : '', tx.statementTime || '', tx.refundOfId ? 'Возврат' : (typeNames[financeTransactionType(tx)] || 'Операция'), financeAccountName(tx.accountId, tx.accountName), tx.toAccountId ? financeAccountName(tx.toAccountId, tx.toAccountName) : '', category.categoryId ? financeCategoryName(category.categoryId, category.category) : category.category || '', tx.title || '', financeTransactionAmount(tx), tx.currency || 'KZT', tx.toAmount == null ? '' : tx.toAmount, tx.toAccountId ? tx.toCurrency || tx.currency || 'KZT' : '', tx.note || '', tx.affectsBalance === false || tx.balanceDetached ? 'Нет' : 'Да'];
  }
  const columns = ['Дата', 'Время', 'Тип', 'Счёт', 'На счёт', 'Категория', 'Название', 'Сумма', 'Валюта', 'Сумма зачисления перевода', 'Валюта зачисления', 'Комментарий', 'Влияет на баланс'];
  function selectionLabel() {
    return [ids[1], ids[2], ids[3]].map(id => el(id)?.selectedOptions[0]?.textContent || '').filter(Boolean).join(' · ');
  }
  function csvCell(input) {
    let s = String(input ?? '');
    // Spreadsheet formula protection applies to all textual fields, including titles/notes.
    if (typeof input !== 'number' && /^[\s\uFEFF]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csv(rows, period) {
    const lines = [['Выписка', period.label], [selectionLabel()], ['Операций', rows.length]];
    for (const t of totals(rows)) lines.push(['Поступления', t.incoming, t.currency], ['Списания', t.outgoing, t.currency]);
    lines.push([], columns, ...rows.map(record));
    return '\uFEFF' + lines.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }
  function excel(rows, period) {
    const hasNote = rows.some(tx => tx.note), hasTime = rows.some(tx => tx.statementTime), hasTransfer = rows.some(tx => financeTransactionType(tx) === 'transfer');
    const hasDetached = rows.some(tx => tx.affectsBalance === false || tx.balanceDetached);
    const columns = [{title:'Дата',width:14},{title:'Тип',width:20},{title:'Счёт',width:22},{title:'Категория',width:22},{title:'Название',width:48,wrap:true},{title:'Поступление',width:20},{title:'Списание',width:20},{title:'Валюта',width:12}];
    if (hasNote) columns.push({title:'Комментарий',width:42,wrap:true});
    if (hasTime) columns.push({title:'Время',width:14});
    if (hasTransfer) columns.push({title:'Другой счёт',width:22});
    if (hasDetached) columns.push({title:'Влияет на баланс',width:20});
    const entries = [];
    for (const tx of rows) {
      const base = record(tx);
      for (const flow of flows(tx, value(ids[2]) || 'all')) {
        const row = [base[0],base[2],financeAccountName(flow.accountId,tx.accountName),base[5],base[6],flow.incoming,flow.outgoing,flow.currency];
        if (hasNote) row.push(base[11]);
        if (hasTime) row.push(base[1]);
        if (hasTransfer) row.push(flow.counterAccountId ? financeAccountName(flow.counterAccountId) : '');
        if (hasDetached) row.push(base[12]);
        entries.push(row);
      }
    }
    return FinanceExcel.build({period:period.label,selection:selectionLabel(),count:rows.length,columns,rows:entries,totals:totals(rows)});
  }
  window.financeSaveStatement = async function () {
    const status = el('financeStatementStatus'), button = el('financeStatementSave');
    if (button) button.disabled = true;
    try {
      if (!financeHydrated) throw Error('Дождись загрузки операций.');
      const period = bounds(), rows = financeFilteredTransactions();
      if (!rows.length) throw Error('По выбранным фильтрам операций нет.');
      const isExcel = value('financeStatementFormat') !== 'csv';
      const content = isExcel ? excel(rows, period) : csv(rows, period), mime = isExcel ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
      const name = 'statement-' + (period.start ? iso(new Date(period.start)) : 'all') + '-' + (period.end === Number.MAX_SAFE_INTEGER ? iso(new Date()) : iso(new Date(period.end - 1))) + (isExcel ? '.xlsx' : '.csv');
      if (isExcel && window.AndroidFinances?.saveExcel) {
        await window.AndroidFinances.saveExcel(FinanceExcel.base64(content), name);
        if (status) status.textContent = 'Выбери папку для сохранения.';
      } else if (!isExcel && window.AndroidFinances?.saveStatement) {
        await window.AndroidFinances.saveStatement(content, name, mime);
        if (status) status.textContent = 'Выбери папку для сохранения.';
      } else {
        const url = URL.createObjectURL(new Blob([content], {type: mime}));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        if (status) status.textContent = 'Выписка подготовлена: ' + rows.length + ' операций.';
      }
    } catch (e) { if (status) status.textContent = String(e.message || e); }
    finally { renderFinanceTransactions(); }
  };
})();
