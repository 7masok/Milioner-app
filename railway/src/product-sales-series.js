import { pool } from './db.js';
import { asyncRoute } from './http.js';
import { buildWbOperationAudit } from './wb-operation-audit.js';
import { wbFinancePeriodSql, wbFinancePeriodDate } from './wb-finance-period.js';

// Read cached financial sales only. No marketplace requests or warehouse writes.
export function registerProductSalesSeries(router) {
  router.get('/wb-product-sales-series', asyncRoute(async (req,res)=>{
    const from=Number(req.query.from),to=Number(req.query.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from<=0||to<=from||to-from>731*86400000)return res.status(400).json({ok:false,error:'Некорректный период сравнения'});
    const [finance,links,products,history]=await Promise.all([
      pool.query(`SELECT f.* FROM wb_finance_rows f WHERE f.market=ANY($1::text[]) AND (${wbFinancePeriodSql('f')}) >= $2 AND (${wbFinancePeriodSql('f')}) < $3 AND lower(COALESCE(NULLIF(btrim(f.operation),''),btrim(f.doc_type)))='продажа' ORDER BY f.market,f.rr_date,f.rrd_id LIMIT 50001`,[['WB','WB2'],from,to]),
      pool.query('SELECT market,sku,product_id AS "productId" FROM product_links WHERE market=ANY($1::text[]) LIMIT 50001',[['WB','WB2']]),
      pool.query('SELECT id,name,payload FROM warehouse_products LIMIT 50001'),
      pool.query('SELECT market,MIN(rr_date) AS "firstDate",MAX(rr_date) AS "lastDate",MAX(updated_at) AS "updatedAt" FROM wb_finance_rows WHERE market=ANY($1::text[]) GROUP BY market',[['WB','WB2']])
    ]);
    if([finance,links,products].some(x=>x.rows.length>50000))return res.status(422).json({ok:false,error:'Слишком много операций для сравнения. Сократите период.'});
    const originals=new Map(finance.rows.map(r=>[r.market+':'+String(r.rrd_id),r])),totals=new Map(),uncertain=new Map();let unlinked=0;
    for(const market of ['WB','WB2']){
      const marketLinks=links.rows.filter(r=>r.market===market),candidates=new Map(),key=v=>String(v||'').trim().toLocaleLowerCase('ru-RU'),add=(v,pid)=>{if(!key(v))return;const set=candidates.get(key(v))||new Set();set.add(String(pid));candidates.set(key(v),set)};
      for(const link of marketLinks)add(link.sku,link.productId);
      for(const row of products.rows){let payload=row.payload||{};if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{payload={}}}const field=market==='WB'?'wb':'wb2';for(const v of [payload[field],...(Array.isArray(payload[field+'Aliases'])?payload[field+'Aliases']:[]),payload[field+'Identity']?.nmId,payload.wbVariant?.market===market?payload.wbVariant.nmId:''])add(v,row.id)}
      const audit=buildWbOperationAudit({market,rows:finance.rows.filter(r=>r.market===market),links:marketLinks,products:products.rows,allDates:true});
      for(const r of audit.operations){
        if(!(r.saleQty>0))continue;
        if(!r.productId){unlinked+=r.saleQty;for(const value of [r.barcode,r.nmId,r.vendorCode])for(const productId of candidates.get(key(value))||[])uncertain.set(market+':'+productId,{market,productId});continue;}
        const date=wbFinancePeriodDate(originals.get(market+':'+r.rrdId)),day=new Date(date+18000000).toISOString().slice(0,10),bucketKey=JSON.stringify([market,r.productId,day]);
        const row=totals.get(bucketKey)||{market,productId:r.productId,day,qty:0};row.qty+=r.saleQty;totals.set(bucketKey,row);
      }
    }
    res.json({ok:true,rows:[...totals.values()],history:history.rows,unlinked,uncertain:[...uncertain.values()],linked:links.rows.map(r=>({market:r.market,productId:r.productId}))});
  }));
}
