(function () {
  'use strict';

  const DAY = 86400000;
  const OFFSET = 5 * 3600000;
  const LIMIT = 15000;
  const countKeys = ['views', 'clicks', 'carts', 'orders'];
  const actions = {
    lower: 'Снизить ставку', raise: 'Можно поднять', price: 'Тест цены',
    margin: 'Проверить маржу', watch: 'Мало данных', keep: 'Оставить', unknown: '', test: 'В тесте', card: 'Проверить карточку', unadvertised: '',
  };
  const iso = at => new Date(at + OFFSET).toISOString().slice(0, 10);
  const dayStart = day => Date.parse(day + 'T00:00:00+05:00');
  const number = x => x != null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
  const sum = (rows, key) => rows.every(row => number(row[key]) !== null)
    ? rows.reduce((total, row) => total + Number(row[key]), 0) : null;
  const format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const compactFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits:1 });
  const value = (x, suffix = '') => x == null ? '—' : format.format(x) + suffix;
  const cash = x => value(x, ' ₸');
  const compact = x => x == null ? '—' : Math.abs(x) >= 1e6 ? compactFormat.format(x/1e6)+'млн' : Math.abs(x) >= 1000 ? compactFormat.format(x/1000)+'к' : compactFormat.format(x);
  const hasActivity = line => Number(line.amount) > 0 || countKeys.some(key => Number(line[key]) > 0);
  const kaspiSkus = item => [item.kaspi,...(Array.isArray(item.kaspiAliases)?item.kaspiAliases:[])];
  const testEnd = t => Math.min((t.weekly ? Math.ceil((t.startedAt+OFFSET)/DAY)*DAY-OFFSET : t.startedAt)
    + t.days * DAY, t.stoppedAt || Infinity);
  const active = (t, at) => !!t && at >= t.startedAt && at < testEnd(t);
  const baselineStart = t => t.startedAt - Math.ceil(t.days / 7) * 7 * DAY;

  function coverageIncludes(data, from, to) {
    const c = data?.historyCoverage?.find(row => row.market === 'Kaspi');
    return !!c && Number(c.from) > 0 && c.from <= from && c.to >= to
      && ![...(c.gaps || []), ...(c.repairs || [])].some(g => g.from < to && g.to > from);
  }

  function experiment(t, snapshot, at) {
    const end = Math.min(testEnd(t), at);
    const baseline = baselineStart(t);
    const baselineEnd = baseline + end - t.startedAt;
    const before = new Set(), after = new Set();
    for (const row of snapshot?.orders || []) {
      if (row.market !== 'Kaspi' || String(row.orderedProductId || row.productId || '') !== t.productId) continue;
      const when = Number(row.creationDate);
      const key = String(row.orderId || row.code || '');
      if (!key) continue;
      if (when >= baseline && when < baselineEnd) before.add(key);
      if (when >= t.startedAt && when < end) after.add(key);
    }
    const compare = snapshot?.orders?.length < LIMIT
      && coverageIncludes(snapshot, baseline, baselineEnd);
    const complete = compare && coverageIncludes(snapshot, t.startedAt, end);
    return {
      before: compare ? before.size : null,
      after: complete || compare && after.size > 0 ? after.size : null,
      observedAfter: after.size || null,
      percent: compare && (complete || after.size > 0) && before.size > 0 ? Math.round((after.size / before.size - 1) * 100) : null,
      day: Math.max(1, Math.min(t.days, Math.floor((Math.max(t.startedAt, end - 1) - t.startedAt) / DAY) + 1)),
    };
  }

  function campaignRows(batches, from, to, match, confirmed = '') {
    const campaigns = new Map(), snapshots = new Set(), nativeBySource = new Map();
    const ordered = [...batches].sort((a, b) => Number(b.importedAt) - Number(a.importedAt));
    let latestReport = confirmed;
    for (const batch of ordered) {
      const match = /^kaspi-auto-(\d+)-(\d+)-\d{4}-\d{2}-\d{2}$/.exec(String(batch.id));
      if ((match || batch.campaignId) && batch.fromDate <= to && batch.fromDate > latestReport) latestReport = batch.fromDate;
      if (!match || !batch.sourceKey) continue;
      const native = nativeBySource.get(batch.sourceKey) || new Set();
      native.add(match[1] + ':' + match[2]);
      nativeBySource.set(batch.sourceKey, native);
    }
    for (const batch of ordered) {
      const [, account, nativeId] = /^kaspi-auto-(\d+)-(\d+)-\d{4}-\d{2}-\d{2}$/.exec(String(batch.id)) || [];
      const campaignId = batch.campaignId || nativeId;
      const manual = !campaignId;
      const mapped = nativeBySource.get(batch.sourceKey);
      const key = manual ? (mapped?.size === 1 ? [...mapped][0] : 'manual:' + (batch.sourceKey || batch.campaignName || batch.fileName || batch.id))
        : String(batch.accountId || account || '') + ':' + campaignId;
      if (!campaigns.has(key)) campaigns.set(key, {
        key, manual: true, name: batch.campaignName || batch.fileName || 'Кампания Kaspi', products: new Map(), spend: 0, hasDay: false, latest: false,
      });
      const campaign = campaigns.get(key);
      if (!manual) {
        if (campaign.manual) campaign.name = batch.campaignName || campaign.name;
        campaign.manual = false;
      }
      const covered = new Set();
      for (const line of batch.lines || []) {
        const day = line.date || batch.fromDate;
        if (!(day >= from && day <= to)) continue;
        const id = JSON.stringify([key, day]);
        if (snapshots.has(id)) continue;
        if (!manual && day === latestReport && hasActivity(line)) campaign.latest = true;
        const sku = String(line.sku || '').trim();
        const product = match(line, batch.id);
        const linkKey = kaspiAdLinkKey(line, batch.id);
        const productId = product ? String(product.id) : '';
        const productKey = linkKey || (productId ? 'product:' + productId : 'name:' + (line.name || 'Неизвестный товар'));
        let row = campaign.products.get(productKey);
        if (!row) {
          row = { productId, sku, linkKey, name: product?.name || 'Нет привязки · '+(sku || 'без артикула'), sourceName:line.name || '', lines: [], last: null };
          campaign.products.set(productKey, row);
        }
        if (day >= from && day <= to) {
          const dated = {...line, day};
          row.lines.push(dated);
          row.spend = (row.spend || 0) + (Number(line.amount) || 0);
          campaign.spend += Number(line.amount) || 0;
          campaign.hasDay = true;
          if (!row.last || day > row.last.day) row.last = dated;
        }
        covered.add(id);
      }
      if (batch.lines?.length || !manual) {
        const start = Math.max(dayStart(from), dayStart(batch.fromDate));
        const end = Math.min(dayStart(to), dayStart(batch.toDate || batch.fromDate));
        for (let d = start; d <= end; d += DAY) covered.add(JSON.stringify([key,iso(d)]));
      }
      if (!batch.lines?.length && batch.fromDate >= from && (batch.toDate || batch.fromDate) <= to && batch.fromDate) {
        const id = JSON.stringify([key, batch.fromDate, batch.toDate || batch.fromDate, 'total']);
        const hasOverlap = [...covered].some(day => snapshots.has(day));
        if (!hasOverlap && !snapshots.has(id)) {
          snapshots.add(id);
          campaign.spend += Number(batch.amount) || 0;
          campaign.hasDay = true;
          if (Number(batch.amount) > 0) campaign.hasUnallocated = true;
          if (!manual && batch.fromDate === latestReport && Number(batch.amount) > 0) campaign.latest = true;
        }
      }
      for (const id of covered) snapshots.add(id);
    }
    return [...campaigns.values()].filter(c => c.hasDay || c.latest)
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name, 'ru'));
  }

  function campaignMetrics(row, finance, claims) {
    if (!row.lines.length) return {};
    const out = Object.fromEntries(countKeys.map(k => [k, sum(row.lines, k)]));
    out.cpc = out.clicks > 0 ? row.spend / out.clicks : null;
    out.partial = {};
    for (const key of countKeys) {
      const known = row.lines.filter(line => number(line[key]) !== null);
      if (known.length && known.length < row.lines.length) out.partial[key] = sum(known, key);
    }
    out.score = number(row.last?.score);
    out.bid = number(row.last?.bid);
    out.averageBid = number(row.last?.averageBid);
    const withRefs = row.lines.every(line => Number.isSafeInteger(line.orders)
      && Array.isArray(line.orderCodes) && line.orders === line.orderCodes.length);
    const codes = [...new Set(row.lines.flatMap(line => line.orderCodes || []))];
    if (!withRefs || !row.productId || !finance || codes.some(code => claims.get(code + '|' + row.productId) !== 1)) return out;

    let margin = 0, buyouts = 0;
    for (const code of codes) {
      if (finance.returned.has(code)) return out;
      const order = finance.byCode.get(code);
      if (!order) return out;
      const lines = order.lines.filter(line => String(line.productId) === row.productId);
      if (!lines.length || lines.some(line => line.unknownCost)) return out;
      margin += lines.reduce((total, line) => total + line.profit, 0);
      buyouts++;
    }
    out.buyouts = buyouts;
    out.profit = margin - row.spend;
    if (buyouts > 0 && out.clicks > 0) out.maxCpc = Math.max(0, margin / out.clicks);
    return out;
  }

  function productTotal(productId, totals) {
    if (!productId) return {profitReason:'Привяжи товар склада, чтобы увидеть его прибыль.'};
    if (!totals) return {profitReason:'Финансовые данные Kaspi пока недоступны.'};
    const row=totals.byProduct.get(String(productId));
    if (row?.unknownCost) return {totalQty:number(row.qty),profitReason:'У части выкупов нет себестоимости. Проверь себестоимость проданных партий.'};
    if (totals.historyIncomplete && !(number(row?.qty)>0)) return {profitReason:'История выкупов за этот период неполная.'};
    if (!row) return totals.incomplete ? {profitReason:'Есть выкупы или рекламные расходы без привязки к товару.'} : {totalProfit:0,totalQty:0};
    const qty=number(row.qty), revenue=number(row.revenue), costs=number(row.cost), fees=number(row.fees);
    const delivery=number(row.delivery), ads=number(row.ads);
    const result={totalProfit:number(row.profit),totalQty:qty,totalPreliminary:totals.incomplete,
      historyIncomplete:totals.historyIncomplete, ads};
    if (!(qty>0&&revenue>0&&costs>0&&fees>=delivery&&delivery>=0&&ads>=0)
      || fees===null || delivery===null || ads===null) return result;
    const feeRate=(fees-delivery)/revenue;
    if (!(feeRate>=0&&feeRate<1)) return result;
    const costUnit=costs/qty, deliveryUnit=delivery/qty, adUnit=ads/qty;
    return {...result,costUnit,deliveryUnit,feeUnit:fees/qty,adUnit,
      beforeAds:(revenue-costs-fees)/qty,
      priceAt100:Math.ceil((costUnit+deliveryUnit+100)/(1-feeRate)),
      baseFloor:Math.ceil((costUnit+deliveryUnit)/(1-feeRate)),
      adFloor:Math.ceil((costUnit+deliveryUnit+adUnit)/(1-feeRate))};
  }

  function totalProducts(products) {
    const unique=new Map();
    for (const entry of products) {
      if (!entry.row.productId) return null;
      unique.set(entry.row.productId,entry.m);
    }
    return unique.size?sum([...unique.values()],'totalProfit'):null;
  }

  const reviewActions = new Set(['lower','raise','price','margin','card']);
  const minBid = 3;
  const lowScore = m => m.score != null && m.score < 7;
  const targetCpc = m => m.maxCpc == null ? null : Math.floor(m.maxCpc*.85*100)/100;
  function advice(m, row, item, test, at) {
    if (active(test, at)) return 'test';
    if (!item || !row.lines.length) return 'unknown';
    if (m.baseFloor != null && (m.beforeAds <= 0 || m.price > 0 && m.price <= m.baseFloor)) return 'margin';
    if (m.clicks >= 30 && m.profit != null && m.profit < 0 && m.buyouts > 0) return 'lower';
    if (row.spend > 0 && m.orders === 0 && (m.clicks >= 30 || m.beforeAds > 0 && row.spend >= 3*m.beforeAds)) return 'lower';
    if (m.views >= 500 && m.clicks != null && m.clicks / m.views < 0.01) return 'card';
    if (!m.historyIncomplete && m.clicks >= 30 && m.orders > 0 && m.orders/m.clicks < .02 && lowScore(m) && m.adFloor != null && m.adFloor+1 < m.price) return 'price';
    if (m.totalProfit < 0 || row.spend > 0 && m.orders === 0) return 'watch';
    if (!m.totalPreliminary && m.score >= 7 && m.buyouts >= 5 && m.profit > 0 && targetCpc(m) > m.bid
      && m.bid >= minBid && m.averageBid > m.bid && m.views > 0 && m.views < 500 && productAvailableStock(item) > 0) return 'raise';
    return m.clicks >= 30 && m.profit != null && m.profit >= 0 ? 'keep' : 'unknown';
  }

  function bidHistory(row, campaign, finance, claims, from, to) {
    const [accountId,campaignId] = campaign.key.split(':');
    const changes = bidChanges.filter(x=>x.accountId===accountId && x.campaignId===campaignId && x.sku===row.sku);
    const byDay = new Map();
    for (const line of row.lines) {
      if (line.day < from || line.day > to) continue;
      if (!byDay.has(line.day)) byDay.set(line.day, []);
      byDay.get(line.day).push(line);
    }
    const byBid = new Map();
    const priceTest = tests()[row.productId];
    let excluded = 0;
    for (const [day,lines] of byDay) {
      const reported=number(lines[0].bid);
      const testedPrice=priceTest && day>=iso(baselineStart(priceTest)) && day<=iso(testEnd(priceTest));
      if (lines.length!==1 || !(reported>=minBid) || testedPrice || changes.some(x=>iso(x.at)===day)) {
        excluded++;
        continue;
      }
      if (!byBid.has(reported)) byBid.set(reported, []);
      byBid.get(reported).push(lines[0]);
    }
    const rows = [...byBid].map(([bid,lines])=>{
      const spend=sum(lines,'amount'), clicks=sum(lines,'clicks'), views=sum(lines,'views');
      const metrics=spend==null ? {} : campaignMetrics({...row,lines,spend},finance,claims);
      return {bid,days:lines.length,spend,clicks,views,cpc:clicks>0 && spend!=null ? spend/clicks : null,
        buyouts:metrics.buyouts,profitDay:metrics.profit==null ? null : metrics.profit/lines.length};
    });
    const best=rows.filter(x=>x.days>=7 && x.buyouts>=5 && x.profitDay>0)
      .sort((a,b)=>b.profitDay-a.profitDay || a.bid-b.bid)[0];
    return {rows,excluded,best,changes};
  }

  function bidHistoryHtml(history) {
    if (!history) return '';
    const {rows,excluded,best,changes}=history;
    return '<details class="kaw-bid-history"><summary>История ставок'+(best?' · выгоднее '+cash(best.bid):'')+'</summary>'
      + (rows.length ? rows.sort((a,b)=>a.bid-b.bid).map(x=>'<div class="kaw-note"><b>'+cash(x.bid)
        + (x===best?' · лучшая по доступным данным':'')+'</b> · дней '+x.days
        +' · показы/день '+value(x.views==null?null:x.views/x.days)+' · клики/день '+value(x.clicks==null?null:x.clicks/x.days)
        +' · расход '+cash(x.spend)+' · клик '+cash(x.cpc)+' · выкупы '+value(x.buyouts)+' · прибыль/день '+cash(x.profitDay)+'</div>').join('')
        : '<div class="kaw-note">За этот период нет дневных отчётов с указанной ставкой.</div>')
      + (excluded?'<div class="kaw-note">Дней вне сравнения (тест цены, смена или неизвестная ставка): '+excluded+'.</div>':'')
      + changes.slice(-5).reverse().map(x=>'<div class="kaw-note">'+dateTime.format(x.at)+' · подтверждена ставка '+cash(x.bid)+'</div>').join('')
      + '</details>';
  }

  function weeklyBid(m, history) {
    if (!(m.bid>=minBid) || history.changes.some(x=>x.at>=m.weekStart)) return null;
    if (m.profit<0 || m.score!=null && m.score<10) {
      if (m.bid===minBid) return m.profit<0 ? {text:'Реклама в минусе при 3 ₸. Проверь паузу.'} : null;
      const rollback=history.best?.bid;
      const cap=targetCpc(m);
      if (m.profit<0 && cap!=null && cap<minBid) return {text:'Порог окупаемости ниже 3 ₸. Проверь паузу.'};
      const next=Math.max(minBid,Math.round((m.bid-3)*100)/100);
      const bid=m.profit<0 && rollback>=minBid && rollback<m.bid && rollback<=Math.min(cap ?? 0,bidLimit())
        ? rollback : Math.min(next,bidLimit());
      return {bid,text:(m.profit<0?'Убыток по рекламным выкупам.':'Оценка ниже 10.')+' Ставка '+cash(m.bid)+' → '+cash(bid)+'.'};
    }
    if (!(m.profit>0 && m.buyouts>=5 && m.score===10)) return null;
    const ceiling=Math.min(targetCpc(m) ?? 0, bidLimit());
    if (!(ceiling>=minBid)) return null;
    const tried30=m.bid>=30 || history.changes.some(x=>x.bid===30) || history.rows.some(x=>x.bid===30);
    let bid=Math.min(ceiling,tried30?m.bid+3:30);
    if (bid===m.bid || (tried30 && bid>m.bid && !(m.views>0 && m.views<500))) return null;
    return {bid,text:'Оценка 10, рекламные выкупы в плюсе. Ставка '+cash(m.bid)+' → '+cash(bid)+'. Потолок '+cash(ceiling)+'.'};
  }

  const css = document.createElement('style');
  css.textContent = `
    .kaw { --ka-ink:#171826; --ka-muted:#5e6176; --ka-border:#e5e6ef; --ka-violet:#6743cf; color:var(--ka-ink); }
    .kaw-toolbar { display:flex; gap:7px; overflow-x:auto; padding:2px 0 7px; align-items:center; scrollbar-width:thin; }
    .kaw-toolbar > * { flex:none; white-space:nowrap; }
    .kaw-toolbar button { border:1px solid var(--ka-border); border-radius:9px; min-height:36px; padding:4px 11px; background:white; color:var(--ka-ink); font:inherit; font-size:12px; }
    .kaw-toolbar button[aria-pressed="true"] { background:#eee8ff; color:#4b2ca2; border-color:#d9caff; font-weight:700; }
    .kaw-overview { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:9px 10px; margin:3px 0 7px; background:#f3efff; border-radius:10px; font-size:12px; }
    .kaw-note { color:var(--ka-muted); font-size:11px; margin:5px 0; }
    .kaw-campaign { background:white; border:1px solid var(--ka-border); border-radius:10px; margin:5px 0; }
    .kaw summary { list-style:none; cursor:pointer; }
    .kaw summary::-webkit-details-marker { display:none; }
    .kaw-row { display:flex; gap:8px; align-items:center; padding:8px 9px; min-height:39px; font-size:12px; }
    .kaw-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .kaw-money { flex:none; white-space:nowrap; }
    .kaw-negative { color:#a12639; }
    .kaw-positive { color:#166744; }
    .kaw-search { width:100%; margin:2px 0 7px; padding:8px 10px; min-height:37px; border:1px solid var(--ka-border); border-radius:9px; font:inherit; }
    .kaw-caret { flex:none; color:var(--ka-muted); }
    .kaw details[open] > summary .kaw-caret { transform:rotate(180deg); }
    .kaw-product { border-top:1px solid var(--ka-border); margin-left:9px; }
    .kaw-product-summary.has-stats,.kaw-campaign-summary { display:grid; grid-template-columns:minmax(0,1.5fr) repeat(6,minmax(0,1fr)) 8px; gap:4px; height:46px; min-height:46px; box-sizing:border-box; }
    .kaw-campaign-summary { height:auto; margin-left:9px; }
    .kaw-campaign-summary .kaw-name { display:flex; flex-direction:column; gap:2px; font-size:11px; }
    .kaw-campaign-summary .kaw-name small { font-size:9px; color:var(--ka-muted); overflow:hidden; text-overflow:ellipsis; }
    .kaw-sort { display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; min-width:0; min-height:32px; padding:2px 0; border:1px solid var(--ka-border); border-radius:5px; background:#fff; color:var(--ka-muted); font:inherit; font-size:9px; cursor:pointer; }
    .kaw-sort[aria-pressed="true"] { background:#eee8ff; border-color:#d9caff; color:#4b2ca2; font-weight:700; }
    .kaw-product-summary.has-stats { padding-block:5px; }
    .kaw-product-summary .kaw-name { font-size:10px; line-height:1.15; white-space:normal; overflow-wrap:anywhere; }
    .kaw-product-summary .kaw-name > b { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
    .kaw-product-summary.kaw-needs-link { height:auto; }
    .kaw-product-summary .kaw-unlinked { color:#814300; background:#fff0d1; padding:2px 3px; border-radius:4px; }
    .kaw-unlinked > small { display:block; font-size:9px; font-weight:700; }
    .kaw-product-summary .kaw-unlinked > b { -webkit-line-clamp:2; }
    .kaw-product-summary .kaw-name.kaw-testing > b { color:#1854a1; }
    .kaw-bid-history { margin-block:6px; }
    .kaw-testing > small { display:block; font-size:8px; color:#1854a1; }
    .kaw-product-summary .kaw-testing > b { -webkit-line-clamp:2; }
    .kaw-product-summary .kaw-name.kaw-review > b { color:#a12639; }
    .kaw-product[open] > .kaw-product-summary.has-stats { height:auto; }
    .kaw-product[open] > .kaw-product-summary .kaw-name > b { display:block; }
    .kaw-product-summary.has-stats .kaw-cell { min-width:0; width:100%; padding-inline:3px; }
    .kaw-product-summary.has-stats .kaw-cell > b { max-width:100%; overflow:hidden; text-overflow:ellipsis; }
    .kaw-cell { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:30px; padding:2px 4px; border-radius:5px; background:#f5f5f8; white-space:nowrap; font-variant-numeric:tabular-nums; line-height:1.15; }
    .kaw-cell > small { color:var(--ka-muted); font-size:9px; }
    .kaw-cell > b { font-size:11px; }
    .kaw-cell.kaw-bid { color:#4b2ca2; background:#eee8ff; border:1px solid #d9caff; font:inherit; cursor:pointer; min-width:40px; }
    .kaw-cell.kaw-bid:disabled { opacity:.6; cursor:default; }
    .kaw-cell.kaw-bid small { color:inherit; }
    .kaw-panel { padding:0 9px 8px; }
    .kaw-metrics { display:flex; gap:9px 13px; flex-wrap:wrap; margin:4px 0 7px; font-size:11px; color:var(--ka-muted); }
    .kaw-metrics b { color:var(--ka-ink); }
    .kaw-form { display:flex; align-items:end; gap:6px; margin:7px 0; overflow:auto; padding-bottom:4px; }
    .kaw-form label { flex:none; font-size:11px; color:var(--ka-muted); }
    .kaw-form input,.kaw-form select { display:block; width:76px; margin-top:3px; height:37px; border:1px solid var(--ka-border); border-radius:8px; padding:4px 5px; font-size:13px; background:white; }
    .kaw-form button { flex:none; white-space:nowrap; }
    .kaw-link-form { display:grid; gap:6px; margin:6px 0; }
    .kaw-link-results { max-height:190px; overflow:auto; display:grid; gap:2px; }
    .kaw-link-results button { text-align:left; min-height:38px; padding:6px 8px; background:#f5f5f8; border:1px solid transparent; border-radius:5px; }
    .kaw-link-results button[aria-pressed="true"] { border-color:var(--ka-violet); background:#eee8ff; }
    .kaw-link-form button:disabled { opacity:.55; }
  `;
  document.head.append(css);

  let days = 30, filter = 'all', mode = 'campaigns', rendered = false, history = false;
  let sortKey = 'spend', sortDirection = 'desc';
  const sortLabels = {spend:'Расход',clicks:'Клики',orders:'Заказы',bid:'Ставка',price:'Цена',profit:'Прибыль'};
  let data = null, pending = '', failure = false, linkVersion = 0;
  let reportCache = null, search = '', catalogLimit = 50, paint = null;
  let confirmedAdDays = new Set(), bidChanges = [];
  const dateTime = new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Almaty',day:'numeric',month:'numeric',hour:'2-digit',minute:'2-digit'});
  const expanded = new Set(), productExpanded = new Set(), forms = new Set(), detailBodies = new Map();
  const bidRows = new Map(), bidValues = new Map(), bidForms = new Set();
  const priceRows = new Map(), priceForms = new Set(), priceChanges = new Map();
  let priceSnapshot = new Map(), priceRequest = null, priceReadAt = 0, priceError = '';
  const productStats = new Map();
  let statsVersion = 0;
  const emptyTests = {};
  const tests = () => state.settings.kaspiPriceTests || emptyTests;
  const bidLimit = () => number(state.settings.kaspiWeeklyBidLimit) ?? 30;
  const priceChange = id => state.settings.kaspiWeeklyPriceDraft?.productId===id
    ? state.settings.kaspiWeeklyPriceDraft : priceChanges.get(id);
  const root = () => document.getElementById('kaspiCampaignWorkbench');

  let identityReadAt=0,identityPending=false,identityTimer=null;
  function readIdentities(){
    if(typeof adsApi!=='function'||identityPending||Date.now()-identityReadAt<60000)return;
    identityPending=true;identityReadAt=Date.now();
    adsApi('/api/kaspi-marketing/identities').then(snapshot=>{
      if(!Array.isArray(snapshot.items))return;
      const codes=new Map(snapshot.items.map(row=>[String(row.productCode),row.merchantSkus]));
      let changed=false;
      const batches=(state.kaspiAdExpenses||[]).map(batch=>({...batch,lines:(batch.lines||[]).map(line=>{
        const merchants=codes.get(String(line.sku));
        if(!merchants || JSON.stringify(line.kaspiMerchantSkus)===JSON.stringify(merchants))return line;
        changed=true;return {...line,kaspiMerchantSkus:merchants};
      })}));
      if(changed){state.kaspiAdExpenses=batches;reportCache=null;data=null;draw();}
      if(snapshot.pending>0&&!identityTimer)identityTimer=setTimeout(()=>{
        identityTimer=null;identityReadAt=0;if(root()&&!root().closest('[hidden]'))readIdentities();
      },15000);
    }).catch(()=>{}).finally(()=>{identityPending=false});
  }

  function readPrices() {
    if (!window.kaspiAdvertisingPrices || priceRequest || Date.now()-priceReadAt<2*60000) return;
    priceReadAt=Date.now();
    priceRequest=window.kaspiAdvertisingPrices.load().then(snapshot=>{
      if (!Array.isArray(snapshot.rows)) throw Error('Не удалось загрузить цены Kaspi.');
      priceSnapshot=new Map(snapshot.rows.map(row=>[String(row.productId),number(row.price)]));
      priceError='';
    }).catch(error=>{priceError=error.message || 'Не удалось загрузить цены Kaspi.';})
      .finally(()=>{priceRequest=null;statsVersion++;draw(false);});
  }

  const statsKey = (campaign,from,to) => JSON.stringify([campaign.key,from,to]);
  function readProductStats(campaigns,from,to) {
    if (typeof adsApi!=='function') return;
    for (const campaign of campaigns) {
      const native=/^([0-9]+):([0-9]+)$/.exec(campaign.key);
      if (!native) continue;
      const key=statsKey(campaign,from,to), cached=productStats.get(key), at=Date.now();
      if (cached && (cached.pending || at-cached.updatedAt<5*60000)) continue;
      const record={accountId:native[1],campaignId:native[2],pending:true,updatedAt:at,items:cached?.items};
      productStats.set(key,record);
      const query=new URLSearchParams({accountId:native[1],campaignId:native[2],from,to});
      adsApi('/api/kaspi-marketing/products?'+query).then(snapshot=>{
        if (snapshot.accountId!==native[1] || snapshot.campaignId!==native[2] || snapshot.from!==from
          || snapshot.to!==to || !Array.isArray(snapshot.products)) throw Error('Не совпал период статистики Kaspi.');
        record.items=new Map(snapshot.products.map(row=>[String(row.sku),row]));
        record.error='';
      }).catch(error=>{record.error=error.message || 'Не удалось загрузить показатели Kaspi.';})
        .finally(()=>{
          record.pending=false;
          record.updatedAt=Date.now();
          statsVersion++;
          draw(false);
        });
    }
  }

  function readAnalytics(from, to, list, at) {
    const activeOrRecent = Object.values(list).filter(t => t?.startedAt > 0 && at - t.startedAt < 90 * DAY);
    const earliest = Math.min(dayStart(from), ...activeOrRecent.map(baselineStart));
    const financeFrom = iso(earliest);
    const key = JSON.stringify([from, to, earliest, Math.floor(at / 60000), linkVersion]);
    if (pending === key || data?.key === key) return;
    pending = key;
    const query = new URLSearchParams({ market: 'Kaspi', after: Math.floor(earliest), before: Math.floor(at), limit: LIMIT, history: 1 });
    const analytics = state.kaspiAdExpenses?.some(batch => batch.lines?.some(line => line.date >= from && line.date <= to && line.orderCodes?.length));
    const totalRequest=typeof window.loadKaspiCampaignFinance==='function'
      ? window.loadKaspiCampaignFinance({from,to}) : Promise.resolve(null);
    const requests = [
      activeOrRecent.length ? apiJson(MILLIONER_API + '/api/orders?' + query) : Promise.resolve(null),
      (analytics || activeOrRecent.length) && typeof window.loadKaspiCampaignFinance === 'function'
        ? window.loadKaspiCampaignFinance({from:financeFrom,to:iso(at)}) : Promise.resolve(null),
      totalRequest,
    ];
    Promise.allSettled(requests).then(([orders, snapshot, productSnapshot]) => {
      if (pending !== key) return;
      const snap = snapshot.status === 'fulfilled' ? snapshot.value : null;
      let finance = null;
      if (snap && !snap.historyIncomplete) {
        try {
          const byCode = new Map();
          for (const order of snap.buyouts || []) {
            for (const code of [order.code, order.id].filter(Boolean)) byCode.set(String(code), order);
          }
          const returned = new Set((snap.returns || []).flatMap(x => [x.code,x.id,x.orderCode,x.orderId].filter(Boolean)).map(String));
          if (!(snap.returns || []).some(x => !x.code && !x.id && !x.orderCode && !x.orderId)) finance = {byCode,returned};
        } catch {}
      }
      const summary=productSnapshot.status==='fulfilled'?productSnapshot.value:null;
      const totals=summary && Array.isArray(summary.products)
        ? {byProduct:new Map(summary.products.filter(row=>row.productId).map(row=>[String(row.productId),row])),
          historyIncomplete:!!summary.historyIncomplete,
          incomplete:!!(summary.historyIncomplete || summary.pendingOrders || summary.adsDateMissing || summary.returns?.length
            || summary.products.some(row=>!row.productId && (Number(row.revenue)!==0 || Number(row.ads)>0)))} : null;
      data = {key, from, to, orders:orders.status === 'fulfilled' ? orders.value : null, finance,totals};
      failure = orders.status === 'rejected' || snapshot.status === 'rejected' || productSnapshot.status==='rejected';
      pending = '';
      draw(false);
    });
  }

  function experimentLabel(t, at) {
    const result = experiment(t, data?.orders, at);
    if (result.after == null) return result.observedAfter == null ? 'Ждём данные заказов' : result.observedAfter + ' заказов видно';
    return 'Заказы: '+result.before+' → '+result.after+(result.percent==null?'':' · '+(result.percent>0?'+':'')+result.percent+'%');
  }

  function testProfit(t, at) {
    if (!data?.finance || !data.orders || data.orders.orders.length >= LIMIT) return null;
    const testStart = Math.ceil((t.startedAt + OFFSET) / DAY) * DAY - OFFSET;
    const end = Math.min(dayStart(iso(at)), t.weekly && !t.stoppedAt ? testStart + t.days * DAY : dayStart(iso(testEnd(t))));
    if (end <= testStart) return null;
    const beforeStart = testStart - (t.startedAt - baselineStart(t));
    const beforeEnd = beforeStart + end - testStart;
    function profit(from, until) {
      if (!coverageIncludes(data.orders, from, until)) return null;
      for (let d=from; d<until; d+=DAY) if (!confirmedAdDays.has(iso(d))) return null;
      const rows = data.orders.orders.filter(row => row.market==='Kaspi' && Number(row.creationDate)>=from
        && Number(row.creationDate)<until && String(row.orderedProductId || row.productId || '')===t.productId);
      const counted = new Set();
      let margin = 0;
      for (const row of rows) {
        const code = String(row.code || row.orderId || '');
        if (!code) return null;
        if (counted.has(code)) continue;
        counted.add(code);
        if (['CANCELLED','RETURNED'].includes(String(row.status).toUpperCase())
          || data.finance.returned.has(code) || data.finance.returned.has(String(row.orderId))) continue;
        const buyout = data.finance.byCode.get(code) || data.finance.byCode.get(String(row.orderId));
        const lines = buyout?.lines.filter(line=>String(line.productId)===t.productId);
        if (!lines?.length || lines.some(line=>line.unknownCost)) return null;
        margin += lines.reduce((total,line)=>total+line.profit,0);
      }
      const campaigns = campaignRows(state.kaspiAdExpenses || [], iso(from), iso(until - 1), kaspiAdsMatchProduct);
      if (campaigns.some(c=>c.hasUnallocated || [...c.products.values()].some(x=>x.spend > 0 && !x.productId))) return null;
      for (const c of campaigns) for (const row of c.products.values()) if (row.productId === t.productId) margin -= row.spend || 0;
      return margin / ((until - from) / DAY);
    }
    const before = profit(beforeStart,beforeEnd), after = profit(testStart,end);
    return before == null || after == null ? null : {before,after};
  }

  function linkCandidates(query) {
    const needle = query.trim().toLowerCase();
    return state.products.filter(item =>
      !String(item.id).startsWith('inferno:') && item.kind !== 'variant-group'
      && (typeof window.isWarehouseCatalogProduct !== 'function' || window.isWarehouseCatalogProduct(item))
      && [item.name,...kaspiSkus(item)].some(field => String(field || '').toLowerCase().includes(needle)))
      .sort((a,b) => a.name.localeCompare(b.name,'ru'));
  }

  function linkOptions(query, current = '') {
    const candidates = linkCandidates(query);
    const listed = candidates.slice(0,50);
    const selected = current && candidates.find(item => String(item.id) === current);
    if (selected && !listed.includes(selected)) listed.unshift(selected);
    if (!listed.length) return '<div class="kaw-note">Товары не найдены</div>';
    return listed.map(item => {
      const id=String(item.id), sku=kaspiSkus(item).find(Boolean);
      return '<button type="button" data-ka-link-pick="'+esc(id)+'" aria-pressed="'+(id===current)+'">'
        +esc(item.name + (sku ? ' · '+sku : ''))+'</button>';
    }).join('')+(candidates.length>50?'<div class="kaw-note">Уточни поиск, чтобы увидеть остальные товары.</div>':'');
  }

  function linkEditor(row, item) {
    const links=state.settings.kaspiAdProductLinks;
    const manual=row.linkKey && links && Object.hasOwn(links,row.linkKey);
    if (!row.linkKey || (item && !manual)) return '';
    const selected=manual ? row.productId : '';
    return '<form class="kaw-link-form" data-ka-link-form="'+esc(row.linkKey)+'">'
      +'<input type="search" class="kaw-search" data-ka-link-search aria-label="Поиск товара склада" placeholder="Название или артикул">'
      +'<input type="hidden" name="product" value="'+esc(selected)+'">'
      +'<div class="kaw-link-results" data-ka-link-results aria-label="Товары склада">'+linkOptions('',selected)+'</div>'
      +'<div class="kaw-toolbar"><button type="submit" data-ka-link-confirm'+(selected?'':' disabled')+'>Привязать</button>'
      +(manual ? '<button type="submit" value="remove">Снять ручную привязку</button>' : '')
      +'</div></form>';
  }

  function insufficientAdvice(m, row) {
    if (!row.spend && m.clicks === 0) return 'За выбранный период у этой рекламы нет расхода и кликов. Минус в общей прибыли сам по себе не говорит, что нужно менять ставку.';
    if (m.orders == null) return 'В выгрузке за выбранный период нет полного числа рекламных заказов. После обновления статистики рекомендация пересчитается.';
    if (m.orders === 0) return 'Рекламных заказов пока нет. По текущему расходу и кликам ещё рано менять ставку или цену.';
    if (m.profit == null) return 'Пока не удалось связать рекламные заказы с выкупами и их себестоимостью. Прибыль всех продаж товара не показывает, окупилась ли реклама.';
    return 'Подтверждённых кликов и выкупов пока мало для рекомендации по цене или ставке.';
  }

  function productBody(row, m, kind, t, at) {
    const item = prod(row.productId), running = active(t, at);
    const metric = key => m[key] == null && m.partial?.[key] != null ? value(m.partial[key]) + '*' : value(m[key]);
    const metrics = [
      ['Расход', cash(row.lines.length ? row.spend : null)], ['Показы', metric('views')],
      ['Клики', metric('clicks')], ['Корзины', metric('carts')], ['Рекл. заказы', metric('orders')],
      ['В выкупе', value(m.buyouts)], ['Цена клика', cash(m.cpc)], ['Окупается до', cash(m.maxCpc)], ['Оценка Kaspi', value(m.score)],
    ];
    if (m.totalProfit != null) metrics.push(['Общая прибыль Kaspi','≈ '+cash(m.totalProfit)]);
    if (m.totalQty != null) metrics.push(['Продано, шт.',value(m.totalQty)]);
    if (m.profit != null) metrics.push(['От рекламных выкупов',cash(m.profit)]);
    if (m.bid != null) metrics.push(['Ставка', cash(m.bid)]);
    if (m.costUnit != null) metrics.push(['Себестоимость / шт.',cash(m.costUnit)],
      ['Комиссии и доставка / шт.',cash(m.feeUnit)],['Реклама / шт.',cash(m.adUnit)],
      ['До рекламы / шт.',cash(m.beforeAds)],['Цена без убытка с рекламой ≈',cash(m.adFloor)]);
    const target=targetCpc(m);
    const reason = {
      lower: m.orders === 0
        ? 'Расход уже есть, рекламных заказов — 0. Сначала снизь ставку или поставь товар на паузу. Окупаемую цену клика можно оценить после выкупов.'
        : target==null ? 'Расход выше прибыли от рекламных выкупов. Снизь ставку небольшим шагом и сравни выкупы и расход.'
        : target>=minBid ? (m.bid > target
          ? 'Протестируй ставку до '+cash(target)+'. Сравни фактическую цену клика и число выкупов после изменения.'
          : 'Текущая ставка уже в расчётном диапазоне. Проверь расход и выкупы за период после последнего изменения ставки.')
        : 'Расчётный порог ниже минимальной ставки Kaspi. Рассмотри паузу и проверь маржу.',
      raise: 'Можно протестировать ставку до '+cash(Math.min(Math.floor(m.bid*1.1*100)/100,target))+'. Следи за фактической ценой клика и выкупами.',
      margin: 'Проверь себестоимость, доставку и цену. Маржа до рекламы исчерпана на выкупах или при текущей цене. Снижение цены усилит убыток.',
      price: 'Сравни цену с конкурентами. Если она выше рынка, можно протестировать снижение с запасом выше расчётной цены без убытка.',
      card: 'Товар часто видят, но редко открывают. Начни с главного фото и цены в выдаче.',
      watch: insufficientAdvice(m,row),
      unknown: row.lines.length && m.orders == null ? 'В выгрузке нет полной статистики рекламных заказов.'
        : row.lines.length && !m.profitReason && m.profit == null ? 'Окупаемость рекламных заказов пока не подтверждена.' : '',
      unadvertised: row.sku ? 'Артикул Kaspi · '+row.sku : '',
    }[kind];
    const scoreNote=lowScore(m)
      ? 'Оценка конверсии ниже 7. Проверь фото, описание, отзывы и цену у конкурентов. Снижать цену имеет смысл при запасе маржи.'
      : m.score>=7 ? 'Оценка конверсии в высокой категории Kaspi (7–10).' : '';
    const outcome = t ? testProfit(t,at) : null;
    const decision = t?.weekly && !running && !t.stoppedAt && outcome
      ? (outcome.after>outcome.before?'Оставить '+cash(t.after):'Вернуть '+cash(t.before)) : '';
    const testInfo = t
      ? '<div class="kaw-note"><b>'+ (running ? 'День '+experiment(t,data?.orders,at).day+'/'+t.days+' · Тест цены' : 'Тест завершён') + ' · '+ cash(t.before) + ' → ' + cash(t.after) + '</b> · ' + esc(experimentLabel(t, at))
        + ' · все заказы Kaspi, предварительно</div><div class="kaw-note">До: '+iso(baselineStart(t))+' — '+iso(baselineStart(t)+Math.max(0,Math.min(testEnd(t),at)-t.startedAt)-1)+' · После: '+iso(t.startedAt)+' — '+iso(Math.min(testEnd(t),at)-1)+'</div><div class="kaw-note">'+(outcome
          ? 'Прибыль после рекламы в день · ≈ '+cash(outcome.before)+' → ≈ '+cash(outcome.after)+' (полные дни). Изменение: '+(outcome.after-outcome.before>0?'+':'')+cash(outcome.after-outcome.before)+'/день'
          : 'Сравнение прибыли появится после сверки полных дней, расходов и выкупов.')+'</div>' : '';
    const priceMismatch=running && number(m.price)>0 && Math.abs(m.price-t.after)>.005
      ? '<div class="kaw-note" role="status">В прайсе склада '+cash(m.price)+', в тесте '+cash(t.after)+'. Проверь цену в Kaspi. Если она ещё не изменилась, заверши тест и начни заново после применения новой цены.</div>' : '';
    const change=priceChange(row.productId);
    const form = item && forms.has(row.productId) && !running ? '<form class="kaw-form" data-ka-test="'+esc(row.productId)+'">'
      + '<label>Было, ₸<input required type="number" name="before" min="1" step="0.01"'+(change?.weekly?' readonly':'')+' value="'+(change?.before ?? m.price ?? '')+'"></label>'
      + '<label>Стало, ₸<input required type="number" name="after" min="1" step="0.01"'+(change?.weekly?' readonly':'')+' value="'+(change?.after ?? '')+'"></label>'
      + '<label>Дней<input required type="number" name="days" min="1" max="60"'+(change?.weekly?' readonly':'')+' value="'+(change?.weekly?7:14)+'"></label>'
      + '<button class="btn dark" type="submit">Начать</button></form><div class="kaw-note">Цена передаётся через прайс Kaspi. Начни тест после обновления цены в магазине. «Было» — прежняя цена, «Стало» — новая. Кнопка «Начать» не меняет цену.</div>' : '';
    const experimentProposal = m.weeklyPrice ? '<div class="kaw-note"><b>Тест недели · '+cash(m.price)+' → '+cash(m.weeklyPrice)
      +' · ≥100 ₸ до рекламы</b></div>' : '';
    const bidProposal = m.weeklyBid ? '<div class="kaw-note"><b>'+esc(m.weeklyBid.text)+'</b></div>' : '';
    const controls = item && !change?.weekly ? '<div class="kaw-toolbar"><button type="button" data-ka-'+(running ? 'finish' : 'open-test')+'="'+esc(row.productId)+'">'+(running ? 'Завершить тест' : 'Тест цены')+'</button></div>' : '';
    const identity = row.lines.length ? '<div class="kaw-note">Код рекламы Kaspi · '+esc(row.sku || 'не указан')+'</div>'+(row.last?.kaspiMerchantSkus?.length?'<div class="kaw-note">Артикул продавца · '+row.last.kaspiMerchantSkus.map(esc).join(', ')+'</div>':'')
      +(!item?'<div class="kaw-note">Нет совпадения со складским товаром. Название в выгрузке · '+esc(row.sourceName || 'не указано')+'</div>':'') : '';
    return identity+linkEditor(row,item)+(row.lines.length ? '<div class="kaw-metrics">'+metrics.map(([label, x])=>'<span>'+label+' <b>'+x+'</b></span>').join('')
      + '</div>' : '')+(Object.keys(m.partial || {}).length ? '<div class="kaw-note">* Сумма по дням с доступными данными.</div>' : '')
      +(m.totalPreliminary?'<div class="kaw-note">Прибыль предварительная: часть операций, выкупов или дней рекламы ещё не учтена.</div>':'')
      +(m.historyIncomplete?'<div class="kaw-note">Прибыль учитывает только загруженные выкупы. История за период неполная.</div>':'')
      +(m.profitReason?'<div class="kaw-note">'+esc(m.profitReason)+'</div>':'')
      +(reason?'<div class="kaw-note"><b>'+esc(actions[kind]||'')+'</b> '+esc(reason)+'</div>':'')
      +(scoreNote?'<div class="kaw-note">'+esc(scoreNote)+'</div>':'')+experimentProposal+bidProposal+testInfo+(decision?'<div class="kaw-note"><b>'+decision+'</b></div>':'')+priceMismatch+controls+form+bidHistoryHtml(m.bidHistory);
  }

  function productCells(row, campaign, m, key) {
    const cell = (label, description, metric, partial = false) =>
      '<span class="kaw-cell '+(label.startsWith('Прибыль')?tone(metric):'')+'" title="'+esc(description+' · '+value(metric)+(partial?' (доступные дни)':''))+'">'
      +'<small>'+label+'</small><b>'+compact(metric)+(partial?'*':'')+'</b></span>';
    const count = key => m[key] ?? m.partial?.[key];
    const native = campaign.latest && !active(tests()[row.productId],Date.now()) && /^([0-9]+):([0-9]+)$/.exec(campaign.key);
    const currentBid = bidValues.has(key) ? bidValues.get(key) : m.bid;
    if (native && row.sku) bidRows.set(key,{accountId:native[1],campaignId:native[2],sku:row.sku,bid:currentBid,productId:row.productId});
    const bid = native && row.sku
      ? '<button type="button" class="kaw-cell kaw-bid" data-ka-bid="'+esc(key)+'"'
        +' aria-label="'+esc('Изменить ставку за клик · '+row.name)+'">'
        +'<small>Ставка ✎</small><b>'+value(currentBid)+'</b></button>'
      : cell('Ставка','Ставка за клик, ₸',m.bid);
    const priceLocked=active(tests()[row.productId],Date.now());
    const warehousePrice=number(prod(row.productId)?.kaspiPrice);
    m.price=number(m.price) ?? (warehousePrice>0?warehousePrice:priceSnapshot.get(row.productId)) ?? null;
    if (row.productId) priceRows.set(key,{productId:row.productId,price:m.price,weeklyPrice:m.weeklyPrice,sku:kaspiSkus(prod(row.productId) || {}).find(sku=>String(sku || '').trim()) || ''});
    const price = row.productId
      ? '<button type="button" class="kaw-cell kaw-bid" data-ka-price="'+esc(key)+'"'+(priceLocked?' disabled':'')
        +' title="'+(priceLocked?'Идёт тест цены':'Изменить цену в прайсе Kaspi')+'" aria-label="'+esc('Изменить цену · '+row.name)+'">'
        +'<small>Цена ✎</small><b>'+compact(m.price)+'</b></button>'
      : cell('Цена','Цена прайса Kaspi, ₸',null);
    if (!row.lines.length) return price;
    return cell('Расход','Расход, ₸',row.spend)
      + cell('Клики','Клики',count('clicks'),m.clicks == null && count('clicks') != null)
      + cell('Заказы','Рекламные заказы',count('orders'),m.orders == null && count('orders') != null)
      + bid+price+cell('Прибыль ≈',m.totalProfit == null ? (m.profitReason || 'Финансовые данные загружаются') : 'Общая прибыль товара в Kaspi за период после всех расходов и всей рекламы, по расчётным тарифам',m.totalProfit,!!m.totalPreliminary);
  }

  function renderProduct(row, campaign, m, kind, t, at) {
    const key = JSON.stringify([campaign.key, row.sku, row.productId, row.name, ...(!row.sku && row.linkKey ? [row.linkKey] : [])]);
    const open = productExpanded.has(key);
    const unlinked = !row.productId && row.lines.length > 0;
    const name = unlinked ? row.sourceName || row.sku : row.name;
    const nameClass = unlinked ? ' kaw-unlinked' : kind==='test' || m.weeklyPrice ? ' kaw-testing' : reviewActions.has(kind) ? ' kaw-review' : '';
    const body = () => productBody(row,m,kind,t,at);
    detailBodies.set(key, body);
    const cells = productCells(row,campaign,m,key);
    const bidInput = bidRows.get(key);
    const testBadge = kind==='test' ? '<small>Тест цены</small>' : m.weeklyPrice ? '<small>Тест недели</small>' : '';
    const editor = bidForms.has(key) && bidInput ? '<form class="kaw-form kaw-bid-form" data-ka-bid-form="'+esc(key)+'">'
      +'<label>Ставка за клик, ₸<input name="bid" type="number" min="3" step="0.01" required value="'+(m.weeklyBid?.bid ?? bidInput.bid ?? '')+'"></label>'
      +'<button class="btn dark" type="submit">Применить</button><button class="btn" type="button" data-ka-bid-cancel="'+esc(key)+'">Отмена</button>'
      +'<span class="kaw-note" role="status"></span></form>' : '';
    const priceInput=priceRows.get(key);
    const priceEditor=priceForms.has(key) && priceInput ? '<form class="kaw-form" data-ka-price-form="'+esc(key)+'">'
      +'<label>Цена Kaspi, ₸<input name="price" type="number" min="1" step="0.01" required value="'+(m.weeklyPrice ?? priceInput.price ?? '')+'"></label>'
      +'<button class="btn dark" type="submit">Сохранить</button><button class="btn" type="button" data-ka-price-cancel="'+esc(key)+'">Отмена</button>'
      +'<span class="kaw-note" role="status"></span></form><div class="kaw-note">Прайс Kaspi · '+esc(priceInput.sku)+'. Изменение передаётся через прайс.</div>' : '';
    return '<details class="kaw-product" data-ka-product="'+esc(key)+'"'+(open?' open':'')+'><summary class="kaw-row kaw-product-summary'+(row.lines.length?' has-stats':'')+(unlinked?' kaw-needs-link':'')+'" title="'+esc(name || 'Нужна привязка')+'">'
      + '<span class="kaw-name'+nameClass+'">'+(unlinked?'<small>Нужна привязка</small>':'')+(name?'<b>'+esc(name)+'</b>':'')+testBadge+'</span>'
      + cells + '<span class="kaw-caret" aria-hidden="true">⌄</span></summary>'
      + '<div class="kaw-panel" data-ka-body'+(open?' data-ka-filled':'')+'>'+(open?body():'')+'</div></details>'+editor+priceEditor;
  }

  const tone = profit => profit < 0 ? 'kaw-negative' : profit > 0 ? 'kaw-positive' : '';
  function compareProducts(a,b,campaign) {
    const metric = item => {
      if (sortKey==='spend') return item.row.lines.length ? item.row.spend : null;
      if (sortKey==='bid') {
        const key=JSON.stringify([campaign.key,item.row.sku,item.row.productId,item.row.name]);
        return bidValues.get(key) ?? item.m.bid;
      }
      return sortKey==='profit'?item.m.totalProfit:item.m[sortKey] ?? item.m.partial?.[sortKey];
    };
    const av=number(metric(a)), bv=number(metric(b));
    if (av===null && bv!==null) return 1;
    if (bv===null && av!==null) return -1;
    const difference=av===null ? 0 : (av-bv)*(sortDirection==='asc'?1:-1);
    return difference || a.row.name.localeCompare(b.row.name,'ru');
  }

  function sortButtons() {
    return Object.entries(sortLabels).map(([key,label])=>{
      const selected=key===sortKey, arrow=selected?(sortDirection==='asc'?'↑':'↓'):'↕';
      return '<button type="button" class="kaw-sort" data-ka-sort="'+key+'" aria-pressed="'+selected+'"'
        +' aria-label="Сортировать · '+label+'" title="'+(selected?(sortDirection==='asc'?'По возрастанию':'По убыванию'):'Сортировать по убыванию')+'">'
        +'<span>'+label+'</span><span aria-hidden="true">'+arrow+'</span></button>';
    }).join('');
  }
  function button(attr, id, label, chosen) {
    return '<button type="button" data-ka-'+attr+'="'+id+'" aria-pressed="'+(chosen === id)+'">'+label+'</button>';
  }

  function reportFor(from, to) {
    const batches = state.kaspiAdExpenses, products = state.products, links = state.settings.kaspiAdProductLinks;
    const confirmed = [...confirmedAdDays].reduce((latest,day)=>day<=to&&day>latest?day:latest,'');
    if (!reportCache || reportCache.to !== to || reportCache.batches !== batches
      || reportCache.confirmed !== confirmed || reportCache.products !== products
      || reportCache.links !== links) {
      reportCache = {to,batches,confirmed,products,links,matches:new Map(),periods:new Map()};
    }
    const {matches,periods} = reportCache;
    if (periods.has(from)) return periods.get(from);
    const rows = campaignRows(batches || [], from, to, (line,batchId) => {
      const linkKey = kaspiAdLinkKey(line,batchId);
      const key = JSON.stringify([linkKey,line.kaspiMerchantSkus,linkKey?'':line.productId]);
      if (!matches.has(key)) matches.set(key,kaspiAdsMatchProduct(line,batchId));
      return matches.get(key);
    }, confirmed);
    const claims = new Map(), advertised = new Set();
    for (const campaign of rows) for (const row of campaign.products.values()) {
      if (row.productId && row.lines.some(hasActivity)) advertised.add(row.productId);
      for (const code of new Set(row.lines.flatMap(line => line.orderCodes || []))) {
        const key = code + '|' + row.productId;
        claims.set(key, (claims.get(key) || 0) + 1);
      }
    }
    const catalog = (products || []).filter(item => !advertised.has(String(item.id))
      && kaspiSkus(item).some(sku => String(sku || '').trim()));
    catalog.sort((a,b) => a.name.localeCompare(b.name,'ru'));
    const report = {rows,claims,catalog};
    periods.set(from,report);
    return report;
  }

  function draw(refresh = true) {
    const panel = root();
    if (!panel || panel.closest('[hidden]')) return;
    if (panel.contains(document.activeElement) && document.activeElement.closest('form, .kaw-search')) return;
    const at = Date.now(), windowDays = mode==='tests' ? 7 : days;
    const from = iso(at - windowDays * DAY), to = iso(at - DAY), list = tests();
    const report = reportFor(from,to);
    const finance = data?.from === from && data?.to === to ? data.finance : null;
    const totals=data?.from===from && data?.to===to?data.totals:null;
    const minute = Math.floor(at / 60000);
    if (!report.prepared || report.finance !== finance || report.totals!==totals || report.list !== list || report.minute !== minute || report.statsVersion !== statsVersion) {
      report.prepared = report.rows.map(campaign => {
        const products = [...campaign.products.values()].map(row => {
          const m = campaignMetrics(row,finance,report.claims), t = list[row.productId];
          const item=prod(row.productId), ownPrice=number(item?.kaspiPrice);
          m.price=ownPrice>0?ownPrice:priceSnapshot.get(row.productId) ?? null;
          const current=productStats.get(statsKey(campaign,from,to))?.items?.get(row.sku);
          if (current) {
            if (number(current.orders)!==null && current.orders!==m.orders || number(current.spend)!==null && Math.abs(current.spend-row.spend)>.01) {
              delete m.profit;
              delete m.buyouts;
              delete m.maxCpc;
            }
            if (m.maxCpc!=null && number(current.clicks)!=null && current.clicks!==m.clicks) delete m.maxCpc;
            for (const key of [...countKeys,'bid','cpc','score']) {
              if (number(current[key])===null) continue;
              m[key]=Number(current[key]);
              if (m.partial) delete m.partial[key];
            }
            const key=JSON.stringify([campaign.key,row.sku,row.productId,row.name]);
            if (number(current.bid)!==null) bidValues.set(key,Number(current.bid));
          }
          Object.assign(m,productTotal(row.productId,totals));
          return {row,m,t,kind:advice(m,row,item,t,at)};
        }).sort((a,b)=>(a.m.totalProfit ?? Infinity)-(b.m.totalProfit ?? Infinity) || (b.row.spend||0)-(a.row.spend||0));
        const profit = campaign.hasDay && !campaign.hasUnallocated ? totalProducts(products) : null;
        return {campaign,products,profit};
      }).sort((a,b)=>(a.profit??Infinity)-(b.profit??Infinity) || b.campaign.spend-a.campaign.spend);
      Object.assign(report,{finance,totals,list,minute,statsVersion});
    }
    if (refresh) readAnalytics(from,to,list,at);
    const weekly = mode==='tests' && Array.from({length:7},(_,i)=>iso(at-(i+1)*DAY)).every(day=>confirmedAdDays.has(day));
    const currentRows=report.prepared.filter(x=>x.campaign.latest);
    const occurrences=new Map();
    for (const {products} of currentRows) for (const {row} of products) {
      occurrences.set(row.productId,(occurrences.get(row.productId)||0)+1);
    }
    const candidates = weekly ? currentRows.flatMap(({campaign,products})=>products.map(x=>({...x,campaign}))) : [];
    const weeklyDraft=state.settings.kaspiWeeklyPriceDraft;
    const priceCandidate = !(weeklyDraft && prod(weeklyDraft.productId)) && !Object.values(list).some(t=>active(t,at) || t.startedAt>=at-7*DAY)
      ? candidates.filter(({row,m})=>occurrences.get(row.productId)===1 && m.priceAt100<m.price
          && !m.totalPreliminary && m.bid>=minBid && m.views>=(m.bid===minBid?100:500) && m.clicks>=30 && m.orders!=null
          && m.orders/m.clicks<.02 && Number(productAvailableStock(prod(row.productId)))>0)
        .sort((a,b)=>Number(b.m.bid===minBid)-Number(a.m.bid===minBid) || b.m.views-a.m.views)[0] : null;
    const filters = {all:'Все', lower:'Снизить', raise:'Поднять', price:'Тест цены', card:'Карточка', keep:'Оставить',margin:'Маржа',watch:'Мало данных',score:'Оценка < 7'};
    const renderRow = (x,c) => {
      const m={...x.m};
      if (x.row.lines.length) m.bidHistory=bidHistory(x.row,c,finance,report.claims,from,to);
      return renderProduct(x.row,c,m,x.kind,x.t,at);
    };
    const empty = message => '<div class="empty">'+message+'</div>';
    function catalogContent() {
      const needle = search.trim().toLowerCase();
      const items = report.catalog.filter(item => [item.name,...kaspiSkus(item)]
        .some(field => String(field || '').toLowerCase().includes(needle)));
      return items.slice(0,catalogLimit).map(item => {
        const productId = String(item.id), t = list[productId];
        return renderRow({row:{productId,sku:kaspiSkus(item).find(sku=>String(sku || '').trim()),name:item.name,lines:[]},
          m:{},t,kind:active(t,at)?'test':'unadvertised'}, {key:'catalog'});
      }).join('')+(items.length>catalogLimit?'<div class="kaw-toolbar"><button type="button" data-ka-more>Показать ещё</button></div>':'')
        +(!items.length?empty(needle?'Товары не найдены':'Нет товаров Kaspi без рекламных данных за период'):'');
    }
    paint = () => {
      detailBodies.clear();
      if (mode === 'catalog') return catalogContent();
      if (mode === 'tests') {
        const bidProposals=candidates.filter(x=>x.row!==priceCandidate?.row && x.row.productId && !active(x.t,at))
          .map(x=>{
            const observed=productStats.get(statsKey(x.campaign,from,to))?.items?.get(x.row.sku);
            const history=bidHistory(x.row,x.campaign,finance,report.claims,from,to);
            return {...x,m:{...x.m,weeklyBid:number(observed?.bid)!=null ? weeklyBid({...x.m,weekStart:dayStart(from)},history) : null}};
          }).filter(x=>x.m.weeklyBid);
        const proposal = priceCandidate ? renderRow({...priceCandidate,kind:'price',m:{...priceCandidate.m,weeklyPrice:priceCandidate.m.priceAt100}},priceCandidate.campaign) : '';
        const running=Object.values(list).map(t => renderRow({
        row:{productId:t.productId,sku:'',name:prod(t.productId)?.name||t.name,lines:[]},m:{},t,
        kind:active(t,at)?'test':'unknown',
        },{key:'tests'})).join('');
        const draft=state.settings.kaspiWeeklyPriceDraft, draftItem=draft && prod(draft.productId);
        const proposedTest=draftItem ? renderRow({row:{productId:draft.productId,sku:'',name:draftItem.name,lines:[]},
          m:{price:draft.after},kind:'unknown'}, {key:'tests'}) : '';
        return '<form class="kaw-form" data-ka-limit-form><label>Потолок ставки, ₸<input type="number" min="3" step="0.01" name="limit" required value="'+bidLimit()+'"></label>'
          +'<button type="submit" class="btn">Сохранить</button></form>'
          + (proposal || running || proposedTest || bidProposals.length
          ? proposal+proposedTest+running+bidProposals.map(x=>renderRow(x,x.campaign)).join('')
          : empty(weekly ? 'По последним семи дням пока нет подходящего теста.' : 'Для недельного теста нужны семь подтверждённых дней рекламы.'));
      }
      const group = report.prepared.filter(({campaign}) => history ? !campaign.latest && (campaign.spend > 0
        || [...campaign.products.values()].some(row => row.lines.some(hasActivity))) : campaign.latest);
      const spend = group.reduce((a,{campaign})=>a+campaign.spend,0);
      const profit = group.length ? totalProducts(group.flatMap(entry=>entry.products)) : null;
      const heading = '<div class="kaw-overview"><span>'+from.slice(5).split('-').reverse().join('.')+' – '+to.slice(5).split('-').reverse().join('.')+'</span>'
        + '<b>Расход '+cash(group.length?spend:null)+'</b>'+(profit == null?'':'<span>Прибыль товаров ≈ '+cash(profit)+'</span>')+'</div>'
        + (failure?'<div class="kaw-note" role="status">Не удалось обновить часть статистики.</div>':'');
      const needle=search.trim().toLowerCase();
      const content = group.map(({campaign,products}) => {
        const visible = products.filter(x => {
          const row=x.row, item=prod(row.productId);
          return (filter==='all' || (filter==='score' ? lowScore(x.m) : x.kind===filter))
            && (!needle || [campaign.name,row.name,row.sourceName,row.sku,...(row.last?.kaspiMerchantSkus||[]),...kaspiSkus(item||{})]
              .some(field => String(field||'').toLowerCase().includes(needle)));
        }).sort((a,b)=>compareProducts(a,b,campaign));
        if ((needle || filter !== 'all') && !visible.length) return '';
        const open = !!needle || expanded.has(campaign.key);
        const body = () => (campaign.manual?'<div class="kaw-panel kaw-note">Старый импорт</div>':'')
          + (visible.length?visible.map(x=>renderRow(x,campaign)).join(''):'<div class="kaw-panel kaw-note">Нет разбивки по товарам за период.</div>');
        detailBodies.set(campaign.key,body);
        return '<details class="kaw-campaign" data-ka-campaign="'+esc(campaign.key)+'"'+(open?' open':'')
          + '><summary class="kaw-row kaw-campaign-summary" title="'+esc(campaign.name)+'"><span class="kaw-name"><b>'+esc(campaign.name)+'</b>'
          + '<small title="Расход кампании">'+cash(campaign.spend)+'</small></span>'+sortButtons()
          + '<span class="kaw-caret" aria-hidden="true">⌄</span></summary><div data-ka-body'+(open?' data-ka-filled':'')+'>'
          + (open?body():'')+'</div></details>';
      }).join('');
      const message = needle ? 'Товары и кампании не найдены.' : filter !== 'all' ? 'За этот период таких рекомендаций нет.'
        : history ? 'Нет прошлых кампаний с расходом или показами за выбранный период.'
        : 'В последней выгрузке нет активности. Прошлые кампании можно посмотреть в истории.';
      const profitMissing = group.some(({products}) => products.some(({row,m}) => row.productId && m.totalProfit == null));
      const stats=group.map(({campaign})=>productStats.get(statsKey(campaign,from,to)));
      return heading+(!history && group.length ? '<div class="kaw-note">Кампании с активностью в последней выгрузке</div>' : '')
        +(stats.some(record=>record?.pending)?'<div class="kaw-note" role="status">Обновляю заказы и ставки Kaspi…</div>':'')
        +(stats.some(record=>record?.error)?'<div class="kaw-note" role="status">Заказы и ставки не обновлены. '+esc(stats.find(record=>record?.error).error)+'</div>':'')
        +(priceError?'<div class="kaw-note" role="status">'+esc(priceError)+'</div>':'')
        +'<div class="kaw-note">Прибыль ≈ — общая по товару в Kaspi за выбранный период, после всей его рекламы. Комиссии и часть доставки расчётные. В разных кампаниях прибыль одного товара повторяется.</div>'
        +(totals?.incomplete?'<div class="kaw-note">Есть нераспределённые операции: прибыль предварительная, они не разнесены по товарам.</div>':'')
        +(pending?'<div class="kaw-note" role="status">Загружаю общую прибыль Kaspi…</div>':profitMissing ? '<div class="kaw-note">Причина отсутствия прибыли указана внутри строки товара.</div>' : '')
        +(content || empty(message));
    };
    const scroll = [...panel.querySelectorAll('.kaw-toolbar')].slice(0,2).map(x=>x.scrollLeft);
    panel.innerHTML = '<div class="kaw-toolbar" aria-label="Период и вид">'
      + button('mode','campaigns','Кампании',history?'':mode)+button('mode','catalog','Без рекламы',mode)
      + button('mode','tests','Тесты',mode)+button('history','history','История',history?'history':'')+'</div>'
      + (mode !== 'tests' ? '<div class="kaw-toolbar" aria-label="Период">'
        + [7,14,30].map(d=>button('days',String(d),d+' дней',String(days))).join('')+'</div>' : '')
      + (mode === 'campaigns' ? '<div class="kaw-toolbar" aria-label="Рекомендации">'
        + Object.entries(filters).map(([key,label])=>button('filter',key,label,filter)).join('')
        + '</div>' : '')
      + (mode !== 'tests' ? '<input class="kaw-search" type="search" aria-label="Поиск товаров Kaspi" placeholder="Название или артикул" value="'+esc(search)+'">'
        + (mode==='catalog'?'<div class="kaw-note">Товары Kaspi без записанной рекламной активности за выбранный период.</div>':'') : '')
      + '<div data-ka-content>'+paint()+'</div>';
    [...panel.querySelectorAll('.kaw-toolbar')].slice(0,2).forEach((x,i)=>{x.scrollLeft=scroll[i]||0});
    if (refresh && (mode==='campaigns' || mode==='tests')) readProductStats(report.rows.filter(c=>history?!c.latest:c.latest),from,to);
    if (refresh) {readPrices();readIdentities();}
  }

  function mount(connection) {
    const panel = root();
    if (!panel) return;
    if (connection?.confirmedDays) confirmedAdDays = new Set(connection.confirmedDays);
    if (Array.isArray(connection?.bidChanges)) bidChanges = connection.bidChanges;
    const draft=state.settings.kaspiWeeklyPriceDraft, draftItem=draft && prod(draft.productId);
    if (draftItem) {
      forms.add(draft.productId);
      productExpanded.add(JSON.stringify(['tests','',draft.productId,draftItem.name]));
    }
    if (!rendered) {
      rendered = true;
      panel.addEventListener('toggle', event => {
        const {kaCampaign,kaProduct} = event.target.dataset || {};
        const target = kaCampaign ? expanded : productExpanded, key = kaCampaign || kaProduct;
        if (!key || !panel.contains(event.target)) return;
        if (!kaCampaign || !search.trim()) {
          if (event.target.open) target.add(key);
          else target.delete(key);
        }
        if (!event.target.open) return;
        const body = event.target.querySelector(':scope > [data-ka-body]');
        if (body && !body.hasAttribute('data-ka-filled') && detailBodies.has(key)) {
          body.innerHTML = detailBodies.get(key)();
          body.setAttribute('data-ka-filled','');
        }
      }, true);
      panel.addEventListener('keydown', event => {
        if (event.key==='Enter' && event.target.matches('[data-ka-link-search]')) event.preventDefault();
      });
      panel.addEventListener('input', event => {
        if (event.target.matches('[data-ka-link-search]')) {
          const form=event.target.form;
          form.elements.product.value='';
          form.querySelector('[data-ka-link-confirm]').disabled=true;
          form.querySelector('[data-ka-link-results]').innerHTML=linkOptions(event.target.value);
          return;
        }
        if (!event.target.matches('.kaw-search')) return;
        search = event.target.value;
        catalogLimit = 50;
        panel.querySelector('[data-ka-content]').innerHTML = paint();
      });
      panel.addEventListener('click', event => {
        const b = event.target.closest('button');
        if (!b) return;
        const k = b.dataset;
        if (k.kaLinkPick) {
          const form=b.form;
          form.elements.product.value=k.kaLinkPick;
          for (const option of form.querySelectorAll('[data-ka-link-pick]')) option.setAttribute('aria-pressed',String(option===b));
          form.querySelector('[data-ka-link-confirm]').disabled=false;
          return;
        }
        if (k.kaPrice || k.kaPriceCancel) {
          event.preventDefault();
          const key=k.kaPrice || k.kaPriceCancel;
          if (k.kaPriceCancel) priceForms.delete(key);
          else if (priceRows.has(key)) {priceForms.add(key);bidForms.delete(key);}
          document.activeElement?.blur();
          draw(false);
          return;
        }
        if (k.kaSort && Object.hasOwn(sortLabels,k.kaSort)) {
          event.preventDefault();
          if (sortKey===k.kaSort) sortDirection=sortDirection==='desc'?'asc':'desc';
          else { sortKey=k.kaSort; sortDirection='desc'; }
          draw(false);
          return;
        }
        if (k.kaBid || k.kaBidCancel) {
          event.preventDefault();
          const key = k.kaBid || k.kaBidCancel;
          if (k.kaBidCancel) bidForms.delete(key);
          else if (bidRows.has(key)) {bidForms.add(key);priceForms.delete(key);}
          document.activeElement?.blur();
          draw(false);
          return;
        }
        if (k.kaMore !== undefined) {
          catalogLimit += 50;
          panel.querySelector('[data-ka-content]').innerHTML = paint();
          return;
        }
        let refresh = false;
        if (k.kaDays) { days = Number(k.kaDays); refresh = true; }
        else if (k.kaMode) { mode = k.kaMode; filter = 'all'; history = false; refresh = mode==='campaigns' || mode==='tests'; }
        else if (k.kaHistory) { mode = 'campaigns'; history = true; filter = 'all'; refresh = true; }
        else if (k.kaFilter) filter = k.kaFilter;
        else if (k.kaOpenTest) forms.has(k.kaOpenTest) ? forms.delete(k.kaOpenTest) : forms.add(k.kaOpenTest);
        else if (k.kaFinish) {
          if (!requireWarehouseEditReady()) return;
          const t = tests()[k.kaFinish];
          if (active(t,Date.now())) { t.stoppedAt = Date.now(); reportCache = null; save(); }
        } else return;
        draw(refresh);
      });
      panel.addEventListener('submit', async event => {
        if ('kaLimitForm' in event.target.dataset) {
          event.preventDefault();
          if (!requireWarehouseEditReady()) return;
          const limit=number(new FormData(event.target).get('limit'));
          if (!(limit>=minBid) || Math.round(limit*100)/100!==limit) return;
          state.settings.kaspiWeeklyBidLimit=limit;
          save();
          document.activeElement?.blur();
          draw(false);
          return;
        }
        const linkKey = event.target.dataset.kaLinkForm;
        if (linkKey) {
          event.preventDefault();
          if (!requireWarehouseEditReady()) return;
          const productId = event.target.elements.product.value;
          const links = {...state.settings.kaspiAdProductLinks};
          if (event.submitter?.value === 'remove') delete links[linkKey];
          else {
            if (!prod(productId)) return;
            links[linkKey] = productId;
          }
          state.settings.kaspiAdProductLinks = links;
          linkVersion++;
          reportCache = null;
          data = null;
          document.activeElement?.blur();
          save();
          draw();
          return;
        }
        const priceKey=event.target.dataset.kaPriceForm;
        if (priceKey) {
          event.preventDefault();
          const form=event.target, row=priceRows.get(priceKey);
          if (!row || form.dataset.saving || !requireWarehouseEditReady()) return;
          const price=number(new FormData(form).get('price')), status=form.querySelector('[role="status"]');
          if (!(price>0)) return;
          if (row.weeklyPrice && state.settings.kaspiWeeklyPriceDraft && prod(state.settings.kaspiWeeklyPriceDraft.productId)) {status.textContent='Сначала запусти подготовленный тест.';return;}
          if (row.weeklyPrice && price<row.weeklyPrice) {status.textContent='Для теста должно остаться не меньше 100 ₸ до рекламы.';return;}
          if (active(tests()[row.productId],Date.now())) {status.textContent='Сначала заверши текущий тест цены.';return;}
          const buttons=[...form.querySelectorAll('button,input')];
          form.dataset.saving='1';
          buttons.forEach(button=>button.disabled=true);
          status.textContent='Сохраняю цену…';
          try {
            const result=await window.kaspiAdvertisingPrices.save(row.productId,price);
            const change={before:result.previous ?? row.price,after:result.price,weekly:!!row.weeklyPrice};
            priceChanges.set(row.productId,change);
            if (row.weeklyPrice) {
              state.settings.kaspiWeeklyPriceDraft={...change,productId:row.productId};
              save();
            }
            priceSnapshot.set(row.productId,result.price);
            priceForms.delete(priceKey);
            productExpanded.add(priceKey);
            if (row.weeklyPrice) productExpanded.add(JSON.stringify(['tests','',row.productId,prod(row.productId).name]));
            forms.add(row.productId);
            statsVersion++;
            document.activeElement?.blur();
            draw(false);
          } catch (error) {status.textContent=error.message || 'Цена не подтверждена сервером.';}
          finally {delete form.dataset.saving;buttons.forEach(button=>button.disabled=false);}
          return;
        }
        const bidKey = event.target.dataset.kaBidForm;
        if (bidKey) {
          event.preventDefault();
          if (!requireWarehouseEditReady()) return;
          const form = event.target, row = bidRows.get(bidKey);
          if (!row || form.dataset.saving || active(tests()[row.productId],Date.now())) return;
          const bid = Number(new FormData(form).get('bid'));
          if (!Number.isFinite(bid) || bid < 3 || Math.round(bid*100)/100 !== bid) return;
          const status = form.querySelector('[role="status"]'), buttons = [...form.querySelectorAll('button,input')];
          form.dataset.saving = '1';
          buttons.forEach(button=>button.disabled=true);
          status.textContent='Сохраняю в Kaspi…';
          try {
            const response = await adsApi('/api/kaspi-marketing/bid',{method:'PUT',body:JSON.stringify({accountId:row.accountId,campaignId:row.campaignId,sku:row.sku,bid})});
            bidValues.set(bidKey,response.bid);
            const moment=Date.now();
            bidChanges=[...bidChanges,{accountId:row.accountId,campaignId:row.campaignId,sku:row.sku,bid:response.bid,at:moment}];
            for (const record of productStats.values()) {
              const item=record.items?.get(row.sku);
              if (item && record.accountId===row.accountId && record.campaignId===row.campaignId) {
                item.bid=response.bid;
                record.updatedAt=0;
              }
            }
            statsVersion++;
            bidForms.delete(bidKey);
            document.activeElement?.blur();
            draw(false);
          } catch (error) {
            status.textContent=error.message || 'Проверьте ставку в Kaspi перед повтором.';
          } finally {
            delete form.dataset.saving;
            buttons.forEach(button=>button.disabled=false);
          }
          return;
        }
        const productId = event.target.dataset.kaTest;
        if (!productId) return;
        event.preventDefault();
        if (!requireWarehouseEditReady()) return;
        const item = prod(productId), at = Date.now();
        if (!item || active(tests()[productId],at)) return;
        const input = new FormData(event.target), before = number(input.get('before')), after = number(input.get('after'));
        const length = Number(input.get('days'));
        const change=priceChange(productId), weekly = change?.weekly === true;
        if (!(before > 0 && after > 0) || before === after || !Number.isInteger(length) || length < 1 || length > 60 || weekly && (length!==7 || before!==change.before || after!==change.after)) {
          const field = event.target.elements.after;
          field.setCustomValidity('Укажи новую цену, отличную от прежней.');
          field.addEventListener('input',()=>field.setCustomValidity(''),{once:true});
          field.reportValidity();
          return;
        }
        state.settings.kaspiPriceTests ||= {};
        state.settings.kaspiPriceTests[productId] = {productId,name:item.name,before,after,days:length,startedAt:at,...(weekly?{weekly:true}:{})};
        priceChanges.delete(productId);
        if (weekly) delete state.settings.kaspiWeeklyPriceDraft;
        forms.delete(productId);
        data = null;
        reportCache = null;
        document.activeElement?.blur();
        save();
        draw();
      });
    }
    draw();
  }

  window.renderKaspiCampaignWorkbench = mount;
})();
