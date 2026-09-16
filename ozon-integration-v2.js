// Ozon FBO integration: Products FBO card + Reports finance
(function(){
'use strict';

let ozonFboStockCache = null;
let ozonFboCacheLoadTime = 0;

// Helper: Load and cache Ozon FBO stocks
async function ensureOzonFboCache(force = false) {
 const now = Date.now();
 if (!force && ozonFboStockCache && (now - ozonFboCacheLoadTime < 60000)) {
 return ozonFboStockCache;
 }
 try {
 const data = await apiJson(MILLIONER_API + '/api/ozon-fbo');
 ozonFboStockCache = new Map();
 for (const account of (data.accounts || [])) {
 for (const stockRow of (account.stocks?.rows || [])) {
 const offerId = String(stockRow.offer_id || '');
 if (offerId) {
 ozonFboStockCache.set(offerId, stockRow);
 }
 }
 }
 ozonFboCacheLoadTime = now;
 return ozonFboStockCache;
 } catch (e) {
 console.warn('Failed to load Ozon FBO cache:', e);
 return new Map();
 }
}

// Get FBO quantity for a product by matching p.ozon SKU
function ozonFboQtyForProduct(p) {
 if (!p || !ozonFboStockCache) return 0;
 const ozonSku = String(p.ozon || p.ozonSku || '').trim();
 if (!ozonSku) return 0;
 
 const stock = ozonFboStockCache.get(ozonSku);
 if (!stock) return 0;
 
 // Sum present quantities across all FBO-type stocks
 return (stock.stocks || [])
 .filter(s => String(s.type || '').toLowerCase() === 'fbo')
 .reduce((qty, s) => qty + (Number(s.present) || 0), 0);
}

// Hook into product rendering
const originalRenderProducts = window.renderProducts;
window.renderProducts = async function(rebuildStats = false) {
 originalRenderProducts.call(this, rebuildStats);
 
 if (rebuildStats) {
 // Load and cache FBO stocks, then update card
 await ensureOzonFboCache();
 const fboTotal = (state.products || []).reduce((sum, p) => 
 sum + ozonFboQtyForProduct(p), 0
 );
 const fboCard = document.getElementById('productFboQty');
 if (fboCard) fboCard.textContent = fboTotal.toLocaleString('ru-RU') + ' шт.';
 }
};

// Hook into productCard to add FBO line
const originalProductCard = window.productCard;
window.productCard = function(p, profit, d, stock) {
 let html = originalProductCard.call(this, p, profit, d, stock);
 
 // Add FBO quantity line before closing </div>
 const ozonFboQty = ozonFboQtyForProduct(p);
 const fboLine = ozonFboQty > 0 
 ? `<div class="muted" style="color:#1c62bb;margin-top:4px">На FBO: ${ozonFboQty} шт.</div>`
 : '';
 
 if (fboLine && html) {
 // Insert before the closing </div> of the muted/right section
 html = html.replace(/(На складе:.*?<\/div>)?(<\/div><\/div>)/, 
 (match, warehouse, closing) => (warehouse || '') + fboLine + closing);
 }
 
 return html;
};

// === REPORTS: Ozon Finance ===

// Load Ozon finance model for reports
async function loadOzonFinanceModel(days) {
 try {
 const data = await apiJson(MILLIONER_API + '/api/ozon-fbo');
 const accounts = data.accounts || [];
 if (!accounts.length) {
 return { rows: [], byType: new Map(), total: 0, financeAvailable: false, accounts: [] };
 }
 
 // Build period bounds
 const raw = Number(days);
 let start, end;
 if (raw === 0) {
 const b = reportCustomBounds();
 start = b.start;
 end = b.end;
 } else {
 const d = new Date();
 d.setHours(0, 0, 0, 0);
 const today = d.getTime();
 const n = Math.max(1, Math.abs(raw) || 1);
 if (raw === -1) {
 start = today - 86400000;
 end = today;
 } else {
 start = today - (n - 1) * 86400000;
 end = today + 86400000;
 }
 }
 
 // Aggregate finance across all accounts
 const allRows = [];
 const byType = new Map();
 for (const account of accounts) {
 for (const row of (account.finance?.rows || [])) {
 const rDate = Date.parse(row.operation_date || '');
 if (rDate >= start && rDate < end) {
 allRows.push(row);
 const type = row.operation_type_name || 'Неизвестно';
 const amount = Number(row.amount || 0);
 byType.set(type, (byType.get(type) || 0) + amount);
 }
 }
 }
 
 const total = allRows.reduce((s, r) => s + Number(r.amount || 0), 0);
 
 return {
 rows: allRows,
 byType,
 total,
 financeAvailable: allRows.length > 0,
 accounts,
 syncedAt: accounts[0]?.updatedAt
 };
 } catch (e) {
 console.warn('Failed to load Ozon finance model:', e);
 return { rows: [], byType: new Map(), total: 0, financeAvailable: false, accounts: [] };
 }
}

// Hook to render Ozon in marketplaceReportSheet
const originalRenderMarketplaceReportSheet = window.renderMarketplaceReportSheet;
window.renderMarketplaceReportSheet = async function() {
 const market = marketplaceReportContext?.market;
 const raw = Number(marketplaceReportContext?.days);
 const days = raw === -1 ? -1 : Math.max(1, raw || 1);
 
 if (market === 'Ozon') {
 const model = await loadOzonFinanceModel(days);
 
 if (!model.financeAvailable) {
 showSheet(`<h3>Финансы Ozon FBO</h3><div class="empty">Финансовые данные Ozon ещё не загружены. Проверьте, что синхронизация Ozon включена и API-ключ правильный.</div>`);
 return;
 }
 
 // Build finance breakdown
 const rows = [...model.byType].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
 const currencies = [...new Set(model.rows.map(x => x.currency_code).filter(Boolean))];
 const isSingleCurrency = currencies.length === 1;
 const currencyCode = currencies[0] || 'RUB';
 
 const money = (value) => {
 if (!isSingleCurrency && currencies.length > 0) {
 return Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
 }
 return new Intl.NumberFormat('ru-RU', { 
 style: 'currency', 
 currency: currencyCode, 
 maximumFractionDigits: 2 
 }).format(Number(value) || 0);
 };
 
 const financeSummary = `<div class="item" style="margin-top:8px">
 <div class="row" style="margin-top:8px">
 <span class="grow"><b>Всего начисленно Ozon</b></span>
 <b>${money(model.total)}</b>
 </div>
 </div>`;
 
 const financeBreakdown = rows.length ? rows.map(([type, amount]) => 
 `<div class="row" style="margin-top:7px">
 <span class="grow muted">${esc(type)}</span>
 <b>${money(amount)}</b>
 </div>`
 ).join('') : '<div class="empty" style="margin-top:8px">Нет финансовых операций</div>';
 
 const details = `<div class="item" style="margin-top:8px">
 <b>По типам операций</b>
 ${financeBreakdown}
 </div>`;
 
 const note = `<div class="link-note" style="margin-top:12px">
 <b>Важно:</b> Начисленные Ozon суммы − это доход после удержаний Ozon, но ДО вычета себестоимости товаров, 
 налогов, доставки на складе и прочих расходов бизнеса. Это не чистая прибыль.<br>
 ${!isSingleCurrency && currencies.length > 0 ? `Операции в валютах: ${currencies.join(', ')}.` : `Валюта: ${currencyCode}.`}
 </div>`;
 
 const periodLabel = raw === 1 ? 'Сегодня' : raw === -1 ? 'Вчера' : raw === 7 ? '7 дней' : raw === 30 ? '30 дней' : `${raw} дн.`;
 
 showSheet(`<h3>Финансы Ozon FBO · ${esc(periodLabel)}</h3>${financeSummary}${details}${note}`);
 return;
 }
 
 // Fall back to original rendering for other markets
 return originalRenderMarketplaceReportSheet.call(this);
};

// Hook into setReportChrome to add Ozon tab
const originalSetReportChrome = window.setReportChrome;
window.setReportChrome = function() {
 const tabs = document.getElementById('reportMarketTabs');
 if (tabs) {
 // Add Ozon tab if not present
 if (!tabs.querySelector('[data-report-market="Ozon"]')) {
 tabs.insertAdjacentHTML('beforeend', '<button class="market-tab" data-report-market="Ozon" onclick="setReportMarket(\'Ozon\')">Ozon</button>');
 }
 }
 
 // Call original
 if (originalSetReportChrome) {
 originalSetReportChrome.call(this);
 }
};

// Initialize: ensure Ozon tab is added and FBO cache is loaded
window.addEventListener('load', () => {
 setReportChrome();
 ensureOzonFboCache().catch(() => {});
 
 // Also initialize when products view becomes active
 const observer = new MutationObserver(() => {
 if (document.getElementById('products')?.classList.contains('active')) {
 ensureOzonFboCache().catch(() => {});
 }
 });
 observer.observe(document.getElementById('products') || document.body, { 
 attributes: true, 
 attributeFilter: ['class'] 
 });
});

})();

