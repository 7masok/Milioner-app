from pathlib import Path

def once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1, got {n}')
    return s.replace(old, new, 1)

ap = Path('cloudflare/millioner-api/src/index.js')
a = ap.read_text(encoding='utf-8')

a = once(a,
    "o.unit_price AS unitPrice,o.total_price AS totalPrice,l.product_id AS productId",
    "o.unit_price AS unitPrice,o.total_price AS totalPrice,o.seller_delivery_cost AS sellerDeliveryCost,\n                 o.marketplace_fee AS marketplaceFee,o.fee_source AS feeSource,l.product_id AS productId",
    'select financial fields')

a = once(a,
    "total_price REAL NOT NULL DEFAULT 0,raw_json TEXT NOT NULL DEFAULT ''",
    "total_price REAL NOT NULL DEFAULT 0,seller_delivery_cost REAL NOT NULL DEFAULT 0,marketplace_fee REAL NOT NULL DEFAULT 0,fee_source TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL DEFAULT ''",
    'create columns')

a = once(a,
    "  for (const sql of statements) await db.prepare(sql).run();\n}",
    "  for (const sql of statements) await db.prepare(sql).run();\n  await ensureColumn(db,'marketplace_order_lines','seller_delivery_cost','REAL NOT NULL DEFAULT 0');\n  await ensureColumn(db,'marketplace_order_lines','marketplace_fee','REAL NOT NULL DEFAULT 0');\n  await ensureColumn(db,'marketplace_order_lines','fee_source',\"TEXT NOT NULL DEFAULT ''\");\n}\nasync function ensureColumn(db,table,column,definition){const info=await db.prepare(`PRAGMA table_info(${table})`).all();if((info.results||[]).some(x=>String(x.name)===column))return;await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();}",
    'schema migration')

old_append = """function appendKaspiLines(result, order, lines) {
  for (const line of lines || []) {
    const qty = Math.max(0, Number(line?.quantity || 1));
    const total = Number(line?.totalPrice || (Number(line?.basePrice || 0) * qty) || 0);
    result.push({
      orderId: String(order?.id || ''), code: String(order?.code || ''), entryId: String(line?.entryId || line?.id || ''),
      status: String(order?.status || ''), state: String(order?.state || ''), creationDate: toTimestamp(order?.creationDate),
      sku: String(line?.merchantCode || line?.sku || '').trim(), productName: String(line?.productName || line?.name || ''), qty,
      unitPrice: qty ? total / qty : Number(line?.basePrice || 0), totalPrice: total, raw: { order, line }
    });
  }
}"""
new_append = """function firstMoney(obj,keys){for(const key of keys){const value=Number(obj?.[key]);if(Number.isFinite(value)&&value>0)return value}return 0}
function kaspiExplicitCommission(obj){return firstMoney(obj,['commissionAmount','commissionForSeller','sellerCommission','marketplaceFee','serviceFee','serviceCostForSeller','commission'])}
function appendKaspiLines(result,order,lines){const prepared=(lines||[]).map(line=>{const qty=Math.max(0,Number(line?.quantity||1)),total=Number(line?.totalPrice||(Number(line?.basePrice||0)*qty)||0);return {line,qty,total}}),revenue=prepared.reduce((sum,x)=>sum+Math.max(0,x.total),0),orderDelivery=Math.max(0,Number(order?.deliveryCostForSeller)||0),orderCommission=kaspiExplicitCommission(order);for(const {line,qty,total} of prepared){const weight=revenue>0?Math.max(0,total)/revenue:(prepared.length?1/prepared.length:0),lineCommission=kaspiExplicitCommission(line),sellerDeliveryCost=orderDelivery*weight,marketplaceFee=lineCommission||orderCommission*weight,sources=[];if(sellerDeliveryCost>0)sources.push('Kaspi API доставка');if(marketplaceFee>0)sources.push('Kaspi API комиссия');result.push({orderId:String(order?.id||''),code:String(order?.code||''),entryId:String(line?.entryId||line?.id||''),status:String(order?.status||''),state:String(order?.state||''),creationDate:toTimestamp(order?.creationDate),sku:String(line?.merchantCode||line?.sku||'').trim(),productName:String(line?.productName||line?.name||''),qty,unitPrice:qty?total/qty:Number(line?.basePrice||0),totalPrice:total,sellerDeliveryCost,marketplaceFee,feeSource:sources.join(' + '),raw:{order,line}})}}"""
a = once(a, old_append, new_append, 'Kaspi allocation')

target = """    await env.DB.prepare(`
      UPDATE marketplace_order_lines
      SET status=?,state=?,creation_date=?,updated_at=?
      WHERE market='Kaspi' AND order_id=?
    `).bind(String(order?.status || ''),String(order?.state || ''),toTimestamp(order?.creationDate),now,orderId).run();"""
a = once(a, target, target + "\n    await updateKaspiOrderFinancials(env.DB,order);", 'historical refresh')

marker = 'async function fetchKaspiWorkerFeed(base, params, serviceBinding = null) {'
helper = """async function updateKaspiOrderFinancials(db,order){const orderId=String(order?.id||'').trim();if(!orderId)return;const rows=await db.prepare(`SELECT id,total_price AS totalPrice FROM marketplace_order_lines WHERE market='Kaspi' AND order_id=? AND entry_id<>'__pending__'`).bind(orderId).all(),items=rows.results||[];if(!items.length)return;const revenue=items.reduce((sum,x)=>sum+Math.max(0,Number(x.totalPrice)||0),0),delivery=Math.max(0,Number(order?.deliveryCostForSeller)||0),commission=kaspiExplicitCommission(order);if(delivery<=0&&commission<=0)return;await db.batch(items.map(x=>{const weight=revenue>0?Math.max(0,Number(x.totalPrice)||0)/revenue:1/items.length,d=delivery*weight,c=commission*weight,source=[d>0?'Kaspi API доставка':'',c>0?'Kaspi API комиссия':''].filter(Boolean).join(' + ');return db.prepare('UPDATE marketplace_order_lines SET seller_delivery_cost=?,marketplace_fee=?,fee_source=?,updated_at=? WHERE id=?').bind(d,c,source,Date.now(),x.id)}))}

"""
if marker not in a:
    raise SystemExit('worker marker absent')
a = a.replace(marker, helper + marker, 1)

a = once(a,
    "totalPrice: Number(order?.totalPrice || 0),\n    raw: { order, pending: true }",
    "totalPrice: Number(order?.totalPrice || 0),\n    sellerDeliveryCost:Math.max(0,Number(order?.deliveryCostForSeller)||0),marketplaceFee:kaspiExplicitCommission(order),feeSource:Math.max(0,Number(order?.deliveryCostForSeller)||0)>0?'Kaspi API доставка':'',\n    raw: { order, pending: true }",
    'placeholder financials')

old_cols = "(market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,raw_json,first_seen_at,updated_at)\n    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
new_cols = "(market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,seller_delivery_cost,marketplace_fee,fee_source,raw_json,first_seen_at,updated_at)\n    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
if a.count(old_cols) < 1:
    raise SystemExit('insert columns absent')
a = a.replace(old_cols, new_cols, 1)
old_up = "total_price=excluded.total_price,raw_json=excluded.raw_json,updated_at=excluded.updated_at"
if a.count(old_up) < 1:
    raise SystemExit('upsert update absent')
a = a.replace(old_up, "total_price=excluded.total_price,seller_delivery_cost=excluded.seller_delivery_cost,marketplace_fee=excluded.marketplace_fee,fee_source=excluded.fee_source,raw_json=excluded.raw_json,updated_at=excluded.updated_at", 1)
a = once(a,
    "return db.prepare(sql).bind(market,o.orderId,o.code,o.entryId,o.status,o.state,o.creationDate,o.sku,o.productName,o.qty,o.unitPrice,o.totalPrice,JSON.stringify(o.raw || {}),now,now);",
    "return db.prepare(sql).bind(market,o.orderId,o.code,o.entryId,o.status,o.state,o.creationDate,o.sku,o.productName,o.qty,o.unitPrice,o.totalPrice,Number(o.sellerDeliveryCost)||0,Number(o.marketplaceFee)||0,String(o.feeSource||''),JSON.stringify(o.raw || {}),now,now);",
    'batch bind')
ap.write_text(a, encoding='utf-8')

hp = Path('index.html')
h = hp.read_text(encoding='utf-8')
if not (h.startswith('<!doctype html>') and h.rstrip().endswith('</html>')):
    raise SystemExit('full index read failed')
h = once(h,
    "const existingSale=state.sales.some(x=>x.externalKey===scoped||(market==='Kaspi'&&x.externalKey===legacy));const existingReservation=state.reservations.find(x=>x.active&&x.source===market&&(x.externalKey===scoped||(market==='Kaspi'&&x.externalKey===legacy)));",
    "const existingSale=state.sales.find(x=>x.externalKey===scoped||(market==='Kaspi'&&x.externalKey===legacy));const existingReservation=state.reservations.find(x=>x.active&&x.source===market&&(x.externalKey===scoped||(market==='Kaspi'&&x.externalKey===legacy)));const apiFeeTotal=Math.max(0,Number(o.marketplaceFee)||0)+Math.max(0,Number(o.sellerDeliveryCost)||0),apiFeePerUnit=qty?apiFeeTotal/qty:0;if(existingSale&&market==='Kaspi'&&apiFeeTotal>0){existingSale.fee=apiFeePerUnit;existingSale.feeSource=o.feeSource||'Kaspi API'}",
    'existing sale fees')
h = once(h, "fee:0,channel:market", "fee:apiFeePerUnit,feeSource:o.feeSource||'',channel:market", 'new sale fees')
h = once(h,
    '${x.qty} шт. · себестоимость ${fmt(x.cost)} · прибыль ${fmt(x.profit)}',
    '${x.qty} шт. · себестоимость ${fmt(x.cost)} · расходы МП ${fmt(x.fees)} · прибыль ${fmt(x.profit)}',
    'report fee visibility')
hp.write_text(h, encoding='utf-8')
