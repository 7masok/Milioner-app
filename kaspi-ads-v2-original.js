(function () {
  if (typeof state === 'undefined') return;

  state.kaspiAdExpenses = Array.isArray(state.kaspiAdExpenses) ? state.kaspiAdExpenses : [];
  const DAY_MS = 86400000;

  function localDateRange(fromDate, toDate) {
    const from = orderDayStart(fromDate);
    const to = orderDayStart(toDate || fromDate);
    if (from === null || to === null) return [];
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const dates = [];
    for (let ts = start; ts <= end; ts += DAY_MS) {
      const date = new Date(ts);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      dates.push(`${year}-${month}-${day}`);
    }
    return dates;
  }

  function sourceKeyOf(batch) {
    const raw = batch?.sourceKey || batch?.campaignName || batch?.source || kaspiAdsSourceKey(batch?.fileName || '');
    return kaspiAdsNameKey(raw || 'kaspi marketing');
  }

  function queryBounds(days) {
    if (days === 'all') return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY };
    return { start: reportPeriodStart(days), end: reportPeriodEnd(days) };
  }

  function batchDates(batch) {
    const set = new Set(localDateRange(batch?.fromDate || '', batch?.toDate || batch?.fromDate || ''));
    for (const line of batch?.lines || []) {
      const date = kaspiAdsIsoDate(line?.date);
      if (date) set.add(date);
    }
    return [...set].sort();
  }

  function inBounds(date, start, end) {
    const ts = orderDayStart(date);
    return ts !== null && ts >= start && ts < end;
  }

  function newerCoverageForBatch(target) {
    const key = sourceKeyOf(target);
    const importedAt = Number(target?.importedAt) || 0;
    const set = new Set();
    for (const batch of state.kaspiAdExpenses || []) {
      if (batch === target) continue;
      if (sourceKeyOf(batch) !== key) continue;
      if ((Number(batch.importedAt) || 0) <= importedAt) continue;
      for (const date of batchDates(batch)) set.add(date);
    }
    return set;
  }

  function effectiveRows(days = 'all', sourceOnly = '') {
    const { start, end } = queryBounds(days);
    const coveredByCampaign = new Map();
    const rows = [];
    let replacedRows = 0;
    let replacedAmount = 0;
    let skippedLegacy = 0;
    let skippedLegacyAmount = 0;

    const batches = [...(state.kaspiAdExpenses || [])]
      .sort((a, b) => (Number(b.importedAt) || 0) - (Number(a.importedAt) || 0));

    for (const batch of batches) {
      const sourceKey = sourceKeyOf(batch);
      if (sourceOnly && sourceKey !== sourceOnly) continue;

      const covered = coveredByCampaign.get(sourceKey) || new Set();
      const dates = batchDates(batch);
      const lines = Array.isArray(batch.lines) ? batch.lines : [];

      if (lines.length) {
        const grouped = new Map();

        for (const raw of lines) {
          const date = kaspiAdsIsoDate(raw?.date);
          const amount = Math.max(0, Number(raw?.amount) || 0);
          if (!date || !(amount > 0)) continue;

          const product = kaspiAdsMatchProduct(raw);
          const sku = String(raw?.sku || '').trim().toLowerCase();
          const nameKey = kaspiAdsNameKey(raw?.name || '');
          const key = [date, product ? String(product.id) : '', sku, nameKey].join('|');
          const old = grouped.get(key);

          if (old) {
            old.amount += amount;
          } else {
            grouped.set(key, {
              ...raw,
              date,
              amount,
              sourceKey,
              campaignName: batch.campaignName || raw?.campaign || sourceKey,
              batchId: batch.id,
              productId: product?.id || raw?.productId || null
            });
          }
        }

        for (const row of grouped.values()) {
          if (!inBounds(row.date, start, end)) continue;
          if (covered.has(row.date)) {
            replacedRows += 1;
            replacedAmount += row.amount;
            continue;
          }
          rows.push(row);
        }

        // Важный принцип: новый импорт — снимок кампании за весь выбранный диапазон.
        // Даже если в новом файле нет старого товара, старая строка этой даты не должна ожить.
        for (const date of dates) covered.add(date);
        coveredByCampaign.set(sourceKey, covered);
        continue;
      }

      // Совместимость со старыми импортами без построчных дат.
      const from = orderDayStart(batch.fromDate);
      const to = orderDayStart(batch.toDate || batch.fromDate);
      if (from === null || to === null) continue;

      const batchStart = Math.min(from, to);
      const batchEnd = Math.max(from, to) + DAY_MS;
      const batchTotal = Math.max(0, Number(batch.amount) || 0);
      const overlap = Math.max(0, Math.min(end, batchEnd) - Math.max(start, batchStart));
      const anyCovered = dates.some(date => covered.has(date));
      const exactDay = batchStart + DAY_MS === batchEnd;
      const fullyRequested = start <= batchStart && end >= batchEnd;

      if (!overlap) {
        for (const date of dates) covered.add(date);
        coveredByCampaign.set(sourceKey, covered);
        continue;
      }

      if (anyCovered || (!exactDay && !fullyRequested)) {
        skippedLegacy += 1;
        skippedLegacyAmount += batchTotal;
        for (const date of dates) covered.add(date);
        coveredByCampaign.set(sourceKey, covered);
        continue;
      }

      let mapped = 0;
      for (const item of batch.perProduct || []) {
        const amount = Math.max(0, Number(item.amount) || 0);
        if (!(amount > 0)) continue;
        mapped += amount;
        const product = kaspiAdsMatchProduct(item);
        rows.push({
          ...item,
          date: batch.fromDate,
          amount,
          sourceKey,
          campaignName: batch.campaignName || sourceKey,
          batchId: batch.id,
          productId: product?.id || item.productId || null,
          legacy: true
        });
      }

      const unmatched = Math.max(
        0,
        Number.isFinite(Number(batch.unmatchedAmount)) ? Number(batch.unmatchedAmount) : batchTotal - mapped
      );
      if (unmatched > 0) {
        rows.push({
          date: batch.fromDate,
          amount: unmatched,
          sourceKey,
          campaignName: batch.campaignName || sourceKey,
          batchId: batch.id,
          productId: null,
          name: 'Без привязки',
          legacy: true
        });
      }

      for (const date of dates) covered.add(date);
      coveredByCampaign.set(sourceKey, covered);
    }

    return { rows, replacedRows, replacedAmount, skippedLegacy, skippedLegacyAmount };
  }

  function breakdown(days = reportPeriod) {
    const effective = effectiveRows(days);
    const byProduct = new Map();
    const campaignTotals = new Map();
    let total = 0;
    let unmatched = 0;

    for (const row of effective.rows) {
      const amount = Math.max(0, Number(row.amount) || 0);
      if (!(amount > 0)) continue;

      total += amount;
      campaignTotals.set(row.sourceKey, (campaignTotals.get(row.sourceKey) || 0) + amount);

      const product = kaspiAdsMatchProduct(row);
      if (product) {
        byProduct.set(String(product.id), (byProduct.get(String(product.id)) || 0) + amount);
      } else {
        unmatched += amount;
      }
    }

    return {
      total,
      byProduct,
      unmatched,
      campaignTotals,
      activeRows: effective.rows.length,
      replacedRows: effective.replacedRows,
      replacedAmount: effective.replacedAmount,
      skippedLegacy: effective.skippedLegacy,
      skippedLegacyAmount: effective.skippedLegacyAmount
    };
  }

  window.kaspiAdsBreakdown = breakdown;
  window.kaspiAdsForProduct = function (productId, days = reportPeriod) {
    return breakdown(days).byProduct.get(String(productId)) || 0;
  };

  window.renderKaspiAdsStatus = function (days = reportPeriod) {
    const badge = document.getElementById('kaspiAdsBadge');
    const status = document.getElementById('kaspiAdsStatus');
    if (!badge || !status) return;

    const data = breakdown(days);
    const count = (state.kaspiAdExpenses || []).length;
    badge.textContent = fmt(data.total);
    badge.className = 'badge ' + (data.total > 0 ? 'warn' : '');
    status.textContent = count
      ? `За выбранный период учтено ${fmt(data.total)} · импортов: ${count}` +
        (data.unmatched > 0 ? ` · без привязки ${fmt(data.unmatched)}` : '') +
        (data.replacedRows ? ` · старые пересечения заменены: ${data.replacedRows} строк` : '')
      : 'Расходов ещё нет. Импортируйте отчёт рекламы Kaspi.';
  };

  function priorCoverageDates(sourceKey) {
    const set = new Set();
    for (const batch of state.kaspiAdExpenses || []) {
      if (sourceKeyOf(batch) !== sourceKey) continue;
      for (const date of batchDates(batch)) set.add(date);
    }
    return set;
  }

  function currentCampaignStats(sourceKey, fromDate, toDate) {
    const a = orderDayStart(fromDate);
    const b = orderDayStart(toDate);
    if (a === null || b === null) return { rows: 0, amount: 0 };

    const start = Math.min(a, b);
    const end = Math.max(a, b) + DAY_MS;
    const active = effectiveRows('all', sourceKey).rows.filter(row => inBounds(row.date, start, end));

    return {
      rows: active.length,
      amount: active.reduce((sum, row) => sum + Math.max(0, Number(row.amount) || 0), 0)
    };
  }

  function findColumn(normalized, predicates) {
    for (const predicate of predicates) {
      const row = normalized.find(([, name]) => predicate(name));
      if (row) return row[0];
    }
    return '';
  }

  window.openKaspiAdsImport = function () {
    const today = localDateInputValue();
    const campaigns = [...new Set(
      (state.kaspiAdExpenses || [])
        .map(batch => String(batch.campaignName || batch.sourceKey || '').trim())
        .filter(Boolean)
    )].sort();
    const options = campaigns.map(name => `<option value="${esc(name)}"></option>`).join('');

    showSheet(
      `<h3>Реклама Kaspi</h3>` +
      `<div class="link-note"><b>Один принцип для любых периодов.</b> Новый отчёт той же кампании заменяет старые данные на пересекающихся датах. Поэтому день + неделя + месяц не задваиваются.</div>` +
      `<div class="field"><label>Название кампании</label><input id="kaspiAdsCampaign" list="kaspiAdsCampaignList" placeholder="Например: Ножи XINZUO"><datalist id="kaspiAdsCampaignList">${options}</datalist><small class="muted">Для одной кампании используйте всегда одно и то же название.</small></div>` +
      `<div class="two"><div class="field"><label>Дата от</label><input id="kaspiAdsFrom" type="date" value="${today}"></div><div class="field"><label>Дата до</label><input id="kaspiAdsTo" type="date" value="${today}"></div></div>` +
      `<div class="field"><label>Отчёт Kaspi (Excel/CSV)</label><input id="kaspiAdsFile" type="file" onchange="kaspiAdsGuessRange(this.files?.[0]?.name)" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"></div>` +
      `<div class="link-note">Если в файле есть даты по строкам — используем фактические даты. Если отчёт содержит только итог за период, текущий парсер распределит сумму по дням и отметит это в истории.</div>` +
      `<button class="btn dark full" onclick="importKaspiAdsFile()">Импортировать рекламу</button>`
    );
  };

  window.importKaspiAdsFile = async function () {
    const input = document.getElementById('kaspiAdsFile');
    const file = input?.files?.[0];
    const campaign = String(document.getElementById('kaspiAdsCampaign')?.value || '').trim();
    const fromDate = document.getElementById('kaspiAdsFrom')?.value || '';
    const toDate = document.getElementById('kaspiAdsTo')?.value || '';

    if (!campaign) return alert('Укажите название рекламной кампании');
    if (!file) return alert('Выберите отчёт Kaspi');

    const fromTs = orderDayStart(fromDate);
    const toTs = orderDayStart(toDate);
    if (fromTs === null || toTs === null) return alert('Укажите период отчёта');

    const fallbackFrom = fromTs <= toTs ? fromDate : toDate;
    const fallbackTo = fromTs <= toTs ? toDate : fromDate;
    const sourceKey = kaspiAdsNameKey(campaign);

    try {
      try {
        if (typeof kaspiAdsPendingAllocation !== 'undefined') kaspiAdsPendingAllocation = null;
      } catch (_) {}

      const parsed = await kaspiAdsParseFile(file);
      const rows = parsed.rows || [];
      const headers = parsed.headers || [];
      const normalized = parsed.normalized || [];

      const costKey = findColumn(normalized, [
        name => /^расход.*реклам|^реклам.*расход|затрат.*реклам|реклам.*затрат|стоимост.*реклам/.test(name),
        name => name === 'стоимость',
        name => /^стоимость\b/.test(name)
      ]);
      const skuKey = findColumn(normalized, [
        name => name === 'рекламируемый товар' || name === 'sku' || name === 'артикул',
        name => /рекламируем.*товар|\bsku\b|артикул|код товара/.test(name)
      ]);
      const nameKey = findColumn(normalized, [
        name => name === 'товар' || /^наименование товара$|^название товара$/.test(name),
        name => /наименован.*товар|назван.*товар/.test(name)
      ]);
      const dateKey = findColumn(normalized, [
        name => name === 'дата',
        name => /^дата\b|^день\b|^date\b/.test(name)
      ]);

      if (!costKey) {
        throw new Error(`Не найден столбец расходов на рекламу. Найдены: ${headers.slice(0, 10).join(', ') || 'нет'}`);
      }

      const detail = [];
      let usedRows = 0;

      for (const row of rows) {
        const rowText = headers.map(key => String(row[key] ?? '')).join(' ').trim();
        if (/(^|\s)(итого|всего|total)(\s|$)/i.test(rowText)) continue;

        const amount = adsMoney(row[costKey]);
        if (!(amount > 0)) continue;

        const sku = skuKey ? String(row[skuKey] ?? '').trim() : '';
        const rawName = nameKey ? String(row[nameKey] ?? '').trim() : '';
        const date = dateKey ? kaspiAdsIsoDate(row[dateKey]) : fallbackFrom;
        if (!date) continue;

        const product = kaspiAdsMatchProduct({ sku, name: rawName });
        detail.push({
          date,
          productId: product?.id || null,
          sku,
          name: product?.name || rawName || 'Без привязки',
          campaign,
          source: sourceKey,
          amount
        });
        usedRows += 1;
      }

      if (!detail.length) throw new Error('Не найдено строк с рекламным расходом');

      const grouped = new Map();
      for (const line of detail) {
        const key = [
          line.date,
          String(line.productId || ''),
          String(line.sku || '').trim().toLowerCase(),
          kaspiAdsNameKey(line.name)
        ].join('|');
        const old = grouped.get(key);
        if (old) old.amount += line.amount;
        else grouped.set(key, { ...line });
      }

      const lines = [...grouped.values()].sort((a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        String(a.sku).localeCompare(String(b.sku)) ||
        String(a.name).localeCompare(String(b.name))
      );
      const total = lines.reduce((sum, line) => sum + Number(line.amount || 0), 0);
      const dates = lines.map(line => line.date).filter(Boolean).sort();
      const actualFrom = dates[0] || fallbackFrom;
      const actualTo = dates[dates.length - 1] || fallbackTo;

      const canonical = lines.map(line => [
        line.date,
        String(line.productId || ''),
        String(line.sku || '').trim().toLowerCase(),
        kaspiAdsNameKey(line.name),
        Math.round(Number(line.amount || 0) * 100) / 100
      ]);
      const detailHash = await kaspiAdsTextHash(JSON.stringify(canonical));
      const fileHash = await kaspiAdsHash(parsed.buffer);

      const sameAlreadyImported = (state.kaspiAdExpenses || []).some(batch =>
        sourceKeyOf(batch) === sourceKey &&
        ((detailHash && batch.detailHash === detailHash) || (fileHash && batch.hash === fileHash))
      );
      if (sameAlreadyImported) {
        return alert('Этот отчёт этой кампании уже импортирован. Ничего не изменено.');
      }

      const previous = currentCampaignStats(sourceKey, actualFrom, actualTo);
      const coveredDates = priorCoverageDates(sourceKey);
      const newLines = lines.filter(line => !coveredDates.has(line.date));
      const newAmount = newLines.reduce((sum, line) => sum + Number(line.amount || 0), 0);

      const perProductMap = new Map();
      let unmatchedAmount = 0;
      for (const line of lines) {
        const product = kaspiAdsMatchProduct(line);
        if (!product) {
          unmatchedAmount += line.amount;
          continue;
        }

        line.productId = product.id;
        const old = perProductMap.get(String(product.id)) || {
          productId: product.id,
          sku: line.sku,
          name: product.name,
          amount: 0
        };
        old.amount += line.amount;
        perProductMap.set(String(product.id), old);
      }

      let allocation = null;
      try {
        if (typeof kaspiAdsPendingAllocation !== 'undefined') allocation = kaspiAdsPendingAllocation;
      } catch (_) {}

      state.kaspiAdExpenses.push({
        id: 'ads-' + id(),
        market: 'Kaspi',
        accountingVersion: 'ads-snapshot-v3',
        replacementPolicy: 'campaign-date-snapshot',
        source: 'Kaspi Marketing product report',
        sourceKey,
        campaignName: campaign,
        fileName: file.name,
        hash: fileHash,
        detailHash,
        costColumn: costKey,
        parserVersion: 'kaspi-ads-v3',
        fromDate: actualFrom,
        toDate: actualTo,
        amount: total,
        rowsCount: usedRows,
        lines,
        perProduct: [...perProductMap.values()],
        unmatchedAmount,
        newAmount,
        newRows: newLines.length,
        replacedAmount: previous.amount,
        replacedRows: previous.rows,
        duplicatesAdded: 0,
        allocationMode: allocation?.mode || '',
        allocationDays: allocation?.days || 0,
        importedAt: Date.now()
      });

      save();
      closeModal();
      renderReports();

      alert(
        `Реклама Kaspi импортирована.\n\n` +
        `Импортировано: ${fmt(total)}\n` +
        `Новых расходов: ${fmt(newAmount)}\n` +
        `Заменено ранее загруженных: ${fmt(previous.amount)}\n` +
        `Без привязки: ${fmt(unmatchedAmount)}\n` +
        `Задвоений: 0` +
        (allocation?.mode
          ? `\n\nВнимание: в исходном файле не было дат по строкам — сумма распределена по дням периода.`
          : '')
      );
    } catch (error) {
      alert('Не удалось импортировать рекламу Kaspi:\n' + String(error?.message || error));
    }
  };

  function batchActiveStats(batch) {
    const newer = newerCoverageForBatch(batch);
    const lines = Array.isArray(batch.lines) ? batch.lines : [];

    if (!lines.length) {
      return {
        activeAmount: Number(batch.amount) || 0,
        replacedAmount: 0,
        activeRows: Number(batch.rowsCount) || 0,
        replacedRows: 0,
        legacy: true
      };
    }

    let activeAmount = 0;
    let replacedAmount = 0;
    let activeRows = 0;
    let replacedRows = 0;

    for (const line of lines) {
      const amount = Math.max(0, Number(line.amount) || 0);
      const date = kaspiAdsIsoDate(line.date);
      if (date && newer.has(date)) {
        replacedAmount += amount;
        replacedRows += 1;
      } else {
        activeAmount += amount;
        activeRows += 1;
      }
    }

    return { activeAmount, replacedAmount, activeRows, replacedRows, legacy: false };
  }

  window.showKaspiAdsHistory = function () {
    const batches = [...(state.kaspiAdExpenses || [])]
      .sort((a, b) => (Number(b.importedAt) || 0) - (Number(a.importedAt) || 0));

    const body = batches.length
      ? batches.map(batch => {
          const stats = batchActiveStats(batch);
          const status = stats.replacedAmount > 0
            ? (stats.activeAmount > 0 ? 'частично заменён' : 'заменён новым импортом')
            : 'активен';
          const allocation = batch.allocationMode
            ? `<div class="muted">Распределение по дням: ${esc(batch.allocationMode)}</div>`
            : '';

          return `<div class="item" style="margin-top:8px">` +
            `<div class="row"><div class="grow">` +
            `<b>${esc(batch.campaignName || batch.sourceKey || 'Kaspi реклама')}</b>` +
            `<div class="muted">${esc(batch.fromDate || '—')} — ${esc(batch.toDate || batch.fromDate || '—')} · ${esc(batch.fileName || '')}</div>` +
            `<div class="muted">Статус: ${status} · активно ${fmt(stats.activeAmount)}${stats.replacedAmount > 0 ? ' · заменено ' + fmt(stats.replacedAmount) : ''}</div>` +
            `<div class="muted">При импорте: новых ${fmt(batch.newAmount || 0)} · заменено прежних ${fmt(batch.replacedAmount || 0)} · без привязки ${fmt(batch.unmatchedAmount || 0)}</div>` +
            allocation +
            `</div><div class="right"><b>${fmt(batch.amount)}</b>` +
            `<button class="btn danger" style="display:block;margin-top:7px" onclick="removeKaspiAdsBatch('${batch.id}')">Удалить</button>` +
            `</div></div></div>`;
        }).join('')
      : '<div class="empty">Импортов рекламы пока нет</div>';

    showSheet(
      `<h3>Реклама Kaspi · история</h3>` +
      `<div class="link-note">Новые импорты одной кампании имеют приоритет на пересекающихся датах. Удаление нового импорта автоматически вернёт предыдущие данные этих дат.</div>` +
      body +
      `<button class="btn dark full" onclick="openKaspiAdsImport()">Импортировать ещё</button>`
    );
  };

  window.showKaspiAdsBreakdown = function (days = reportPeriod) {
    const data = breakdown(days);
    const products = [...data.byProduct.entries()]
      .map(([productId, amount]) => ({ productId, amount, name: productNameById(productId, 'Товар') }))
      .sort((a, b) => b.amount - a.amount);
    const campaigns = [...data.campaignTotals.entries()]
      .map(([key, amount]) => ({
        key,
        amount,
        name: (state.kaspiAdExpenses || []).find(batch => sourceKeyOf(batch) === key)?.campaignName || key
      }))
      .sort((a, b) => b.amount - a.amount);

    const campaignHtml = campaigns.length
      ? campaigns.map(item => `<div class="item row" style="margin-top:7px"><div class="grow"><b>${esc(item.name)}</b></div><b>${fmt(item.amount)}</b></div>`).join('')
      : '<div class="empty">Нет рекламных расходов за период</div>';
    const productHtml = products.length
      ? products.map(item => `<div class="item row" style="margin-top:7px"><div class="grow"><b>${esc(item.name)}</b></div><b>${fmt(item.amount)}</b></div>`).join('')
      : '<div class="empty">Нет привязанных расходов</div>';
    const unmatchedHtml = data.unmatched > 0
      ? `<div class="item row" style="margin-top:7px"><div class="grow"><b>Без привязки</b><div class="muted">Уменьшает общую прибыль Kaspi, но не прибыль конкретного товара.</div></div><b>${fmt(data.unmatched)}</b></div>`
      : '';

    showSheet(
      `<h3>Реклама Kaspi · расходы</h3>` +
      `<div class="cards"><div class="card"><div class="label">Всего</div><div class="num">${fmt(data.total)}</div></div><div class="card"><div class="label">Без привязки</div><div class="num">${fmt(data.unmatched)}</div></div></div>` +
      `<h3 style="margin-top:18px">По кампаниям</h3>${campaignHtml}` +
      `<h3 style="margin-top:18px">По товарам</h3>${productHtml}${unmatchedHtml}` +
      `<button class="btn dark full" onclick="openKaspiAdsImport()">Импорт рекламы</button>` +
      `<button class="btn full" onclick="showKaspiAdsHistory()">История импортов</button>`
    );
  };
})();
