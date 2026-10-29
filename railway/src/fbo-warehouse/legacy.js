// Project only changed canonical products into the existing reporting tables.
// Other marketplace links and unrelated products are left untouched.
export async function mirrorFboProducts(client,products){
 const now=Date.now();for(const p of products){
  await client.query(`INSERT INTO products(id,name,category,photo,min_stock,stock,cost,total_profit,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,stock=EXCLUDED.stock,cost=EXCLUDED.cost,updated_at=EXCLUDED.updated_at`,[String(p.id),p.name||'',p.category||'',p.photo||'',Math.max(0,Number(p.min??p.minStock)||0),Number(p.stock)||0,Number(p.cost)||0,Number(p.totalProfit)||0,now]);
  const aliases=Array.isArray(p.ozonAliases)?p.ozonAliases:String(p.ozonAliases||'').split(/[;,\n]/),keys=[...new Set([p.ozon,...aliases].map(x=>String(x||'').trim()).filter(Boolean))];
  for(const sku of keys)await client.query(`INSERT INTO product_links(product_id,market,sku,created_at,updated_at) VALUES($1,'Ozon',$2,$3,$3) ON CONFLICT(market,sku) DO UPDATE SET product_id=EXCLUDED.product_id,updated_at=EXCLUDED.updated_at`,[String(p.id),sku,now]);
 }
}
