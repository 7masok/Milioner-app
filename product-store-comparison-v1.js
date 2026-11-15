(function () {
  'use strict';

  const markets = { WB: 'WB1', WB2: 'WB2', WB3: 'WB3', Kaspi: 'Kaspi', Ozon: 'Ozon' };
  const fields = { WB: 'wb', WB2: 'wb2', WB3: 'wb3', Kaspi: 'kaspi', Ozon: 'ozon' };
  const key = value => String(value ?? '').trim().toLowerCase();
  const nameKey = value => key(value).replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const catalogCache = new Map();
  const pref = 'milioner_product_store_comparison_v1';
  let comparison = null;

  function availableMarkets() {
    if (window.WB3_ONLY) return ['WB'];
    return Object.keys(markets).filter(market => market !== 'WB3' || window.unifiedWarehouseEnabled);
  }

  function skuValues(product, market) {
    const field = fields[market];
    const wb3Native = market === 'WB3' && String(product.id).startsWith('inferno:');
    const aliases = Array.isArray(product[field + 'Aliases']) ? product[field + 'Aliases'] : [];
    return [product[field] || (wb3Native ? product.wb : ''), ...aliases,
      product[field + 'Identity']?.vendorCode, product[field + 'RelinkRequired']?.oldSku,
      product.variantMarket === market ? product.variantVendorCode : ''].map(key).filter(Boolean);
  }

  function savedLink(product, market) {
    const field = fields[market];
    const code = product[field] || (market === 'WB3' && String(product.id).startsWith('inferno:') && product.wb);
    const old = product[field + 'RelinkRequired']?.oldSku;
    if (old && (!code || key(old) === key(code))) return { state: 'review', detail: 'Нужна перепривязка' };
    if (code || (Array.isArray(product[field + 'Aliases']) && product[field + 'Aliases'].length) || product.variantMarket === market && product.variantNmId) {
      return { state: 'linked', detail: String(code || product.variantVendorCode || product[field + 'Aliases']?.[0] || '') };
    }
    return null;
  }

  function indexedCatalog(cards, complete = false) {
    const codes = new Map(), titles = new Map();
    function add(index, token, card) {
      if (!token) return;
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(card);
    }
    for (const card of cards) {
      add(codes, key(card.sku), card);
      add(titles, nameKey(card.name), card);
    }
    return { codes, titles, complete };
  }

  function catalogMatch(product, market, catalog, warehouse) {
    const linked = savedLink(product, market);
    if (linked) return linked;
    const codes = Object.keys(markets).flatMap(store => skuValues(product, store));
    const find = (lookup, keys) => [...new Map(keys.flatMap(token => lookup?.get(token) || [])
      .map(card => [key(card.sku) || nameKey(card.name), card])).values()];
    const exact = find(catalog?.codes, codes), sameCode = find(warehouse.codes, codes);
    if (sameCode.length) return { state: 'review', detail: 'Артикул привязан к другому товару склада' };
    if (exact.length === 1) {
      return exact[0].owner ? { state: 'review', detail: 'Карточка привязана к другому товару склада' } :
        { state: 'unlinked', detail: 'Артикул ' + exact[0].sku };
    }
    if (exact.length > 1) return { state: 'review', detail: 'Найдено несколько карточек по артикулам' };
    const name = nameKey(product.name);
    if (catalog?.titles?.has(name) || warehouse.titles.has(name)) {
      return { state: 'review', detail: 'Есть карточка с таким же названием' };
    }
    if (!catalog?.complete) return { state: 'review', detail: 'В доступных данных карточка не найдена' };
    return { state: 'missing', detail: 'По названию и артикулам' };
  }

  function cachedCatalog(market) {
    const cached = catalogCache.get(market);
    if (cached && Date.now() - cached.at < 60_000) return cached.promise;
    const path = market === 'Kaspi' ? '/api/kaspi-catalog' :
      market === 'Ozon' ? '/api/ozon-product-catalog-snapshot' :
        '/api/market-prices/card-groups?market=' + market;
    const promise = fetch(MILLIONER_API + path, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }).then(async response => {
      const data = await response.json();
      if (!response.ok || !data.ok) return null;
      if (market === 'Kaspi') {
        return indexedCatalog((data.products || []).filter(card => card.inXml || card.source === 'orders')
          .map(card => ({ sku: card.sku, name: card.name, owner: card.linkedProductId })));
      }
      if (market === 'Ozon') return indexedCatalog(data.cards || []);
      const complete = Number(data.fetchedAt) > Date.now() - 24 * 60 * 60_000 && !data.lastError;
      return indexedCatalog((data.cards || []).map(card => ({ sku: card.vendorCode, name: card.title })), complete);
    }).catch(() => null);
    catalogCache.set(market, { at: Date.now(), promise });
    return promise;
  }

  const statuses = { missing: 'Не найдена в каталоге', unlinked: 'Нужна привязка', review: 'Нужно проверить', linked: 'Привязан' };

  function renderComparison(job) {
    if (comparison !== job || !job.list?.isConnected) return;
    const query = nameKey(job.query);
    const rows = job.rows.filter(row => (!query || row.search.includes(query)) &&
      (job.filter === 'all' || row.match.state === job.filter));
    const title = job.loading ? 'Проверяю каталог и выкупы…' : 'Найдено ' + rows.length + ' · Выкупы за ' + job.days + ' дн.';
    job.status.textContent = title;
    job.list.innerHTML = rows.slice(0, job.limit).map(row => {
      const sales = row.qty === null ? 'выкупы —' : (row.partial ? '≥ ' : '') + row.qty + ' шт. выкуплено';
      return '<button type="button" class="item product-compare-row" data-product="' + esc(row.product.id) +
        '" onclick="openProduct(this.dataset.product)"><b>' + esc(row.product.name || 'Товар') + '</b>' +
        '<span>' + esc(markets[job.source] + ' · ' + sales + ' · доступно ' + row.stock + ' шт.') + '</span>' +
        '<span>' + esc(markets[job.target] + ' · ' + statuses[row.match.state]) +
        (row.match.detail ? ' · ' + esc(row.match.detail) : '') + '</span></button>';
    }).join('') || '<div class="empty">' + (job.loading ? 'Загружаю данные…' : 'По выбранным условиям товаров нет.') + '</div>';
    if (rows.length > job.limit) job.list.insertAdjacentHTML('beforeend',
      '<button type="button" class="btn full" onclick="moreProductStoreComparison()">Показать ещё</button>');
  }

  function loadComparison(job) {
    job.loading = true;
    job.rows = [];
    job.limit = 40;
    renderComparison(job);
    const period = productRankSpec();
    job.days = period.days;
    const stock = productRenderStatsCache || buildProductRenderStats();
    const products = stock.products || [];
    const destination = indexedCatalog(products.flatMap(product => {
      const link = savedLink(product, job.target);
      return link?.state === 'linked' ? skuValues(product, job.target).map(sku => ({ sku, name: product.name, owner: product.id })) : [];
    }));
    const sales = Promise.resolve().then(() => window.loadComparisonProductBuyouts?.(job.source, period.days)).catch(() => null);
    Promise.all([cachedCatalog(job.target), sales]).then(([catalog, result]) => {
      if (comparison !== job || !job.list.isConnected) return;
      job.rows = products.filter(product => product?.kind !== 'variant-group' &&
        (typeof window.isWarehouseCatalogProduct !== 'function' || window.isWarehouseCatalogProduct(product)) &&
        savedLink(product, job.source)?.state === 'linked').map(product => {
        const match = catalogMatch(product, job.target, catalog, destination);
        const inventory = productInventoryRow(stock, product);
        const count = result?.counts?.get(String(product.id));
        return {
          product, match, stock: inventory.available + Math.max(0, inventory.warehouse - inventory.warehouseReserved),
          qty: count ?? (result?.complete ? 0 : null), partial: !result?.complete,
          search: nameKey([product.name, ...skuValues(product, job.source)].join(' ')),
        };
      }).filter(row => row.match.state !== 'linked').sort((a, b) => {
        const priority = row => Number(row.stock > 0 && row.qty > 0);
        return priority(b) - priority(a) || (b.qty ?? -1) - (a.qty ?? -1) ||
          String(a.product.name || '').localeCompare(String(b.product.name || ''), 'ru');
      });
      job.loading = false;
      renderComparison(job);
    });
  }

  window.openProductStoreComparison = function () {
    const stores = availableMarkets();
    if (stores.length < 2) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(pref) || '{}') || {}; } catch {}
    const source = stores.includes(saved.source) ? saved.source : 'WB';
    const target = stores.includes(saved.target) && saved.target !== source ? saved.target : stores.find(market => market !== source && market === 'Kaspi') || stores.find(market => market !== source);
    const select = (id, title, value) => '<label for="' + id + '">' + title + '<select id="' + id +
      '" onchange="changeProductStoreComparison(this.id)">' + stores.map(m => '<option value="' + m + '"' +
        (m === value ? ' selected' : '') + '>' + markets[m] + '</option>').join('') + '</select></label>';
    showSheet('<h3>Сравнить магазины</h3><div class="two product-compare-controls">' +
      select('productCompareSource', 'Есть в', source) + select('productCompareTarget', 'Проверить в', target) + '</div>' +
      '<div class="two product-compare-controls"><input id="productCompareQuery" type="search" aria-label="Поиск товаров" placeholder="Поиск товаров" oninput="filterProductStoreComparison()">' +
      '<select id="productCompareFilter" aria-label="Статус карточки" onchange="filterProductStoreComparison()"><option value="all">Все пробелы</option>' +
      Object.keys(statuses).filter(status => status !== 'linked').map(status => '<option value="' + status + '">' +
        statuses[status] + '</option>').join('') + '</select></div><p id="productCompareStatus" class="muted" role="status"></p>' +
      '<div id="productCompareList" class="list"></div>');
    const search = document.getElementById('productCompareQuery');
    search.value = document.getElementById('q')?.value || '';
    comparison = {
      source, target, query: search.value, filter: 'all', rows: [],
      status: document.getElementById('productCompareStatus'), list: document.getElementById('productCompareList'),
    };
    loadComparison(comparison);
  };

  window.changeProductStoreComparison = function (changed) {
    const source = document.getElementById('productCompareSource'), target = document.getElementById('productCompareTarget');
    if (source.value === target.value) {
      if (changed === source.id) target.value = comparison.source;
      else source.value = comparison.target;
    }
    const pair = { source: source.value, target: target.value };
    try { localStorage.setItem(pref, JSON.stringify(pair)); } catch {}
    comparison = { ...comparison, ...pair };
    loadComparison(comparison);
  };

  window.filterProductStoreComparison = function () {
    if (!comparison) return;
    comparison.query = document.getElementById('productCompareQuery').value;
    comparison.filter = document.getElementById('productCompareFilter').value;
    comparison.limit = 40;
    renderComparison(comparison);
  };

  window.moreProductStoreComparison = function () {
    if (!comparison) return;
    comparison.limit += 40;
    renderComparison(comparison);
  };

  if (window.WB3_ONLY) document.getElementById('productStoreCompareButton')?.setAttribute('hidden', '');

  window.productStoreComparisonLinks = function (product) {
    const stores = availableMarkets();
    return stores.map(market => {
      const link = savedLink(product, market);
      const value = link ? (link.state === 'linked' ? 'Привязан' : link.detail) : 'Нет привязки';
      return '<div><span class="muted">' + esc(window.WB3_ONLY && market === 'WB' ? 'WB3' : markets[market]) + '</span> · ' + esc(value) + '</div>';
    }).join('');
  };
})();
