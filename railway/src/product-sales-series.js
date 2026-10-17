import { pool } from './db.js';
import { asyncRoute } from './http.js';
import { resolveWbOrderProducts } from './wb-operation-audit.js';
const markets=['Kaspi','WB','WB2'],DAY=86400000;
const object=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value||'{}')}catch{return {}}};
const text=value=>String(value??'').trim();

// Placed quantity, including later cancellations/returns. A status change is
// never another order. Dates are creation_date, not completion or settlement.
export function buildProductOrderSeries({orders=[],links=[],products=[],history=[]}) {
  const aliases=new Map(),linked=new Map(),add=(market,sku,pid)=>{sku=text(sku);if(!sku||!pid)return;const key=market+'\0'+sku,set=aliases.get(key)||new Set();set.add(String(pid));aliases.set(key,set);linked.set(market+':'+pid,{market,productId:String(pid)})};
  const catalog=new Set(products.map(p=>String(p.id)));
  for(const link of links)if(catalog.has(String(link.productId)))add(link.market,link.sku,link.productId);
  for(const row of products){const p=object(row.payload);for(const [market,field]of [['Kaspi','kaspi'],['WB','wb'],['WB2','wb2']])for(const sku of [p[field],...(Array.isArray(p[field+'Aliases'])?p[field+'Aliases']:[])])add(market,sku,row.id)}
  // Include the same explicit saved aliases in WB's size-aware resolver.
  const wbLinks=[];for(const [key,ids]of aliases){const [market,sku]=key.split('\0');if(market!=='Kaspi')for(const productId of ids)wbLinks.push({market,sku,productId})}
  const resolved=new Map();for(const market of ['WB','WB2'])for(const row of resolveWbOrderProducts({market,orders,links:wbLinks,products}))resolved.set(JSON.stringify([row.market,row.order_id,row.entry_id]),row);
  const totals=new Map(),uncertain=new Map(),seen=new Set();let unlinked=0;
  for(const order of orders){
    const key=JSON.stringify([order.market,order.order_id,order.entry_id]);if(seen.has(key))continue;seen.add(key);
    const qty=Number(order.qty),date=Number(order.creation_date);if(!markets.includes(order.market)||!(qty>0)||!Number.isFinite(qty)||!(date>0))continue;
    // An unresolved composition placeholder is not a known product quantity.
    const candidates=order.market==='Kaspi'?[...(aliases.get('Kaspi\0'+text(order.sku))||[])]:resolved.get(key)?.candidates||[];
    const productId=order.market==='Kaspi'?(candidates.length===1?candidates[0]:''):resolved.get(key)?.productId;
    if(!productId){unlinked+=qty;for(const id of candidates)uncertain.set(order.market+':'+id,{market:order.market,productId:id});continue;}
    const day=new Date(date+18000000).toISOString().slice(0,10),bucket=JSON.stringify([order.market,productId,day]),row=totals.get(bucket)||{market:order.market,productId,day,qty:0};row.qty+=qty;totals.set(bucket,row);
  }
  return {rows:[...totals.values()],history,linked:[...linked.values()],uncertain:[...uncertain.values()],unlinked};
}

export function registerProductOrderSeries(router) {
  router.get('/product-sale-recency',asyncRoute(async(_req,res)=>{
    const asOf=Date.now();
    const result=await pool.query(`SELECT product_id AS "productId",MAX(sale_date) AS "lastSaleAt"
      FROM warehouse_sales WHERE qty>0 AND sale_date>0 AND sale_date<=$1
      GROUP BY product_id LIMIT 50001`,[asOf]);
    if(result.rows.length>50000)return res.status(422).json({ok:false,error:'Слишком много товаров для расчёта последних продаж'});
    res.json({ok:true,scope:'recorded-sales',asOf,rows:result.rows});
  }));

  router.get('/product-order-series',asyncRoute(async(req,res)=>{
    const from=Number(req.query.from),to=Number(req.query.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)||from<=0||to<=from||to-from>731*DAY)return res.status(400).json({ok:false,error:'Некорректный период сравнения'});
    const [orders,links,products,history]=await Promise.all([
      pool.query('SELECT market,order_id,entry_id,creation_date,sku,qty,raw_json FROM marketplace_order_lines WHERE market=ANY($1::text[]) AND creation_date >= $2 AND creation_date < $3 ORDER BY market,creation_date,order_id,entry_id LIMIT 50001',[markets,from,to]),
      pool.query('SELECT market,sku,product_id AS "productId" FROM product_links WHERE market=ANY($1::text[]) LIMIT 50001',[markets]),
      pool.query('SELECT id,name,payload FROM warehouse_products LIMIT 50001'),
      pool.query(`SELECT o.market,MIN(o.creation_date) AS "firstDate",s."lastDate" FROM marketplace_order_lines o
        LEFT JOIN (SELECT market,MAX(finished_at) AS "lastDate" FROM sync_runs WHERE ok=1 AND finished_at>0 GROUP BY market) s ON s.market=o.market
        WHERE o.market=ANY($1::text[]) AND o.creation_date>0 GROUP BY o.market,s."lastDate"`,[markets])
    ]);
    if([orders,links,products].some(x=>x.rows.length>50000))return res.status(422).json({ok:false,error:'Слишком много заказов для сравнения. Сократите период.'});
    res.json({ok:true,...buildProductOrderSeries({orders:orders.rows,links:links.rows,products:products.rows,history:history.rows})});
  }));
}
