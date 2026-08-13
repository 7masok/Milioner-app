from pathlib import Path

fixed=Path('cloudflare/millioner-api/src/fixed.js')
s=fixed.read_text(encoding='utf-8')

start=s.find("async function readWbSalesCache(env, market, days) {")
end=s.find("\nasync function wbSalesLiveCached", start)
if start<0 or end<0: raise SystemExit('readWbSalesCache block not found')
new_func=r'''async function readWbSalesCache(env, market, days) {
  await ensureWbSalesCache(env.DB);
  const { since, until } = wbSalesPeriodBounds(days);
  const rows = await env.DB.prepare(`
    WITH priced AS (
      SELECT r.*,
        COALESCE(
          (SELECT o.unit_price FROM marketplace_order_lines o
             WHERE o.market=r.market AND o.unit_price>0
               AND trim(COALESCE(json_extract(o.raw_json,'$.order.rid'),''))=trim(r.srid)
             ORDER BY o.creation_date DESC LIMIT 1),
          (SELECT o.unit_price FROM marketplace_order_lines o
             WHERE o.market=r.market AND o.unit_price>0
               AND (trim(o.sku)=trim(r.vendor_code) OR trim(o.sku)=trim(r.nm_id) OR trim(o.sku)=trim(r.barcode))
             ORDER BY o.creation_date DESC LIMIT 1),
          0
        ) AS seller_unit_price
      FROM wb_sales_live_rows r
      WHERE r.market=? AND r.sale_date>=? AND r.sale_date<?
    )
    SELECT r.vendor_code AS vendorCode,r.nm_id AS nmId,r.barcode AS barcode,
      MAX(l.product_id) AS productId,
      SUM(CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) AS qty,
      SUM(CASE WHEN r.is_return=1 THEN -ABS(r.finished_price) ELSE ABS(r.finished_price) END) AS finishedPriceRub,
      SUM(CASE WHEN r.is_return=1 THEN -ABS(r.price_with_disc) ELSE ABS(r.price_with_disc) END) AS priceWithDiscRub,
      SUM(CASE WHEN r.is_return=1 THEN -ABS(r.for_pay) ELSE ABS(r.for_pay) END) AS forPayRub,
      SUM((CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) * ABS(r.seller_unit_price)) AS sellerGross,
      SUM((CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) * ABS(r.seller_unit_price) *
          CASE WHEN ABS(r.finished_price)>0 THEN ABS(r.for_pay)/ABS(r.finished_price) ELSE 0 END) AS sellerForPay,
      SUM(CASE WHEN r.seller_unit_price>0 THEN 1 ELSE 0 END) AS pricedRows,
      COUNT(*) AS sourceRows
    FROM priced r
    LEFT JOIN product_links l ON l.market=r.market AND (trim(l.sku)=trim(r.vendor_code) OR trim(l.sku)=trim(r.nm_id) OR trim(l.sku)=trim(r.barcode))
    GROUP BY r.vendor_code,r.nm_id,r.barcode
    ORDER BY SUM((CASE WHEN r.is_return=1 THEN -1 ELSE 1 END) * ABS(r.seller_unit_price)) DESC`)
    .bind(market, since, until).all();
  const totals = await env.DB.prepare(`SELECT COUNT(*) totalRows,
      SUM(CASE WHEN is_return=0 THEN 1 ELSE 0 END) sales,
      SUM(CASE WHEN is_return=1 THEN 1 ELSE 0 END) returns
    FROM wb_sales_live_rows WHERE market=? AND sale_date>=? AND sale_date<?`).bind(market,since,until).first();
  const state = await env.DB.prepare('SELECT * FROM wb_sales_live_state WHERE market=?').bind(market).first();
  const sales = Number(totals?.sales || 0), returns = Number(totals?.returns || 0), netQty = sales - returns;
  const lastSuccessAt = Number(state?.last_success_at || 0) || null;
  const products = (rows.results || []).map(x => {
    const qty=Number(x.qty||0), finishedPriceRub=Number(x.finishedPriceRub||0), priceWithDiscRub=Number(x.priceWithDiscRub||0), forPayRub=Number(x.forPayRub||0);
    const sellerGross=Number(x.sellerGross||0), sellerForPay=Number(x.sellerForPay||0), pricedRows=Number(x.pricedRows||0), sourceRows=Number(x.sourceRows||0);
    return {...x,qty,finishedPriceRub,priceWithDiscRub,forPayRub,sellerGross,sellerForPay,pricedRows,sourceRows,
      finishedPrice:sellerGross,priceWithDisc:sellerGross,forPay:sellerForPay,buyoutSum:sellerGross,
      priceLinked:sourceRows>0&&pricedRows===sourceRows};
  }).filter(x=>x.qty!==0);
  const sellerGross=products.reduce((a,x)=>a+Number(x.sellerGross||0),0);
  const sellerForPay=products.reduce((a,x)=>a+Number(x.sellerForPay||0),0);
  const pricedRows=products.reduce((a,x)=>a+Number(x.pricedRows||0),0);
  return {
    ok:true,available:!!lastSuccessAt,market,days,since,until,totalRows:Number(totals?.totalRows||0),sales,returns,netQty,
    buyoutCount:netQty,buyoutSum:sellerGross,forPay:sellerForPay,products,currency:'KZT',pricedRows,
    cached:true,lastSuccessAt,lastError:String(state?.last_error||''),
    nextSyncAt:Number(state?.last_attempt_at||0)+(state?.last_error?wbSalesRetryMs(state):WB_SALES_REFRESH_MS),
    stale:!lastSuccessAt||Date.now()-lastSuccessAt>WB_SALES_REFRESH_MS*2,
    source:'WB Statistics supplier/sales + Marketplace converted price'
  };
}
'''
s=s[:start]+new_func+s[end:]
fixed.write_text(s,encoding='utf-8')

html=Path('index.html')
h=html.read_text(encoding='utf-8')
needle="""function wbLocalCost(market,days){const since=reportPeriodStart(days),until=reportPeriodEnd(days);return financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until).reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0)}
const wbLiveOverviewCache={};"""
replacement="""function wbLocalCost(market,days){const since=reportPeriodStart(days),until=reportPeriodEnd(days);return financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until).reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0)}
function fifoPreviewCost(productId,qty){let need=Math.max(0,Number(qty)||0),total=0;for(const lot of fifoLots(String(productId))){if(need<=0)break;const available=Math.max(0,Number(lot.remainingQty)||0),take=Math.min(available,need),unit=Number(lot.landedUnitCost)||Number(lot.unitCost)||0;if(!take)continue;total+=take*unit;need-=take}if(need>0){const p=prod(String(productId)),fallback=Number(p?.cost)||0;total+=need*fallback}return total}
function wbRealizedFifoCost(productId,market,days,realizedQty){const signed=Number(realizedQty)||0,sign=signed<0?-1:1;let need=Math.abs(signed),total=0;if(!need||!productId)return 0;const since=reportPeriodStart(days),until=reportPeriodEnd(days),local=financialSales().filter(x=>String(x.productId)===String(productId)&&x.channel===market&&Number(x.date)>=since&&Number(x.date)<until).sort((a,b)=>Number(a.date)-Number(b.date));for(const sale of local){if(need<=0)break;const q=Math.max(0,Number(sale.qty)||0);if(!q)continue;const take=Math.min(q,need),unit=Number(sale.cost)||0;total+=take*unit;need-=take}if(need>0)total+=fifoPreviewCost(productId,need);return sign*total}
function wbLiveRealizedCost(market,days,live){return (live?.products||[]).reduce((sum,x)=>sum+(x.productId?wbRealizedFifoCost(String(x.productId),market,days,Number(x.qty)||0):0),0)}
function wbFinanceKztNet(finance,live){const rubGross=Number(finance?.retailAmount)||0,kztGross=Number(live?.buyoutSum)||0;if(!(rubGross>0&&kztGross>0))return null;return (Number(finance?.netBeforeCost)||0)*(kztGross/rubGross)}
const wbLiveOverviewCache={};"""
if needle not in h: raise SystemExit('wbLocalCost marker not found')
h=h.replace(needle,replacement,1)

old="""      if(finance){
        channelRev=Number(finance.retailAmount)||channelRev;channelProfit=(Number(finance.netBeforeCost)||0)-wbLocalCost(n,reportPeriod);financeLabel=' · факт WB';
        if(live?.available===true)qty=Number(live.buyoutCount||0);
      }else if(live?.available===true){
        qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);financeLabel=' · выкупы WB';ensureWbFinanceSummary(n,reportPeriod);
"""
new="""      if(finance&&live?.available===true){
        qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);const exactNet=wbFinanceKztNet(finance,live);channelProfit=(exactNet===null?Number(live.forPay||0):exactNet)-wbLiveRealizedCost(n,reportPeriod,live);financeLabel=exactNet===null?' · реализация WB':' · факт WB';
      }else if(live?.available===true){
        qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);channelProfit=Number(live.forPay||0)-wbLiveRealizedCost(n,reportPeriod,live);financeLabel=' · реализация WB';ensureWbFinanceSummary(n,reportPeriod);
"""
if old not in h: raise SystemExit('renderReports WB block not found')
h=h.replace(old,new,1)

old="""    const since=reportPeriodStart(periodDays),until=reportPeriodEnd(periodDays),sales=financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until),costByProduct=new Map();
    for(const s of sales)costByProduct.set(String(s.productId),(costByProduct.get(String(s.productId))||0)+(Number(s.qty)||0)*(Number(s.cost)||0));
"""
new="""    const since=reportPeriodStart(periodDays),until=reportPeriodEnd(periodDays);
"""
if old not in h: raise SystemExit('costByProduct setup not found')
h=h.replace(old,new,1)

old="""      const f=financeByKey.get(String(x.vendorCode||'').trim())||financeByKey.get(String(x.nmId||'').trim())||null,pid=String(x.productId||f?.productId||''),cost=pid?(costByProduct.get(pid)||0):0;
      if(f){const net=Number(f.netBeforeCost)||0;return {...x,productId:pid,cost,profit:net-cost,exact:true,wbCharges:Number(f.wbCharges)||0,forPay:Number(f.forPay)||0}}
      const preliminaryPayout=Number(x.forPay||x.buyoutSum)||0,profit=preliminaryPayout-cost;
"""
new="""      const f=financeByKey.get(String(x.vendorCode||'').trim())||financeByKey.get(String(x.nmId||'').trim())||null,pid=String(x.productId||f?.productId||''),cost=pid?wbRealizedFifoCost(pid,market,periodDays,Number(x.qty)||0):0;
      if(f){const rubGross=Number(f.retailAmount)||0,kztGross=Number(x.buyoutSum)||0,netKzt=rubGross>0&&kztGross>0?(Number(f.netBeforeCost)||0)*(kztGross/rubGross):null;if(netKzt!==null)return {...x,productId:pid,cost,profit:netKzt-cost,exact:true,wbCharges:(Number(f.wbCharges)||0)*(kztGross/rubGross),forPay:netKzt}}
      const preliminaryPayout=Number(x.forPay||0)||0,profit=preliminaryPayout-cost;
"""
if old not in h: raise SystemExit('WB product profit mapping not found')
h=h.replace(old,new,1)

h=h.replace("`Выкуп WB · сумма выкупов предварительно ${fmt(x.forPay)} · FIFO ${fmt(x.cost)}`","`Реализация WB · предварительно к перечислению ${fmt(x.forPay)} · FIFO ${fmt(x.cost)}`")
h=h.replace("'Количество — фактические продажи WB минус возвраты из оперативного отчёта продаж. Финансовые удержания WB за свежий период ещё могут измениться; после появления детализации прибыль заменится на точную автоматически.'","'Количество и цена в ₸ — по фактическим продажам WB и связанным заказам. Удержания за свежий период предварительные; после финансовой детализации прибыль уточнится автоматически.'")
html.write_text(h,encoding='utf-8')
print('patched exact KZT realized prices and FIFO preview')
