from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')
old="""        COALESCE((SELECT l.product_id FROM product_links l
          WHERE l.market=r.market AND (trim(l.sku)=trim(r.vendor_code) OR trim(l.sku)=trim(r.nm_id) OR trim(l.sku)=trim(r.barcode))
          ORDER BY CASE WHEN trim(l.sku)=trim(r.vendor_code) THEN 0 WHEN trim(l.sku)=trim(r.nm_id) THEN 1 ELSE 2 END LIMIT 1),'') AS linked_product_id,
"""
new="""        COALESCE(
          (SELECT l.product_id FROM product_links l WHERE l.market=r.market AND trim(l.sku)=trim(r.vendor_code) LIMIT 1),
          (SELECT l.product_id FROM product_links l WHERE l.market=r.market AND trim(l.sku)=trim(r.nm_id) LIMIT 1),
          (SELECT l.product_id FROM product_links l WHERE l.market=r.market AND trim(l.sku)=trim(r.barcode) LIMIT 1),
          ''
        ) AS linked_product_id,
"""
if old not in s: raise SystemExit('unsafe linked product subquery not found')
s=s.replace(old,new,1)
# Make runtime D1 failures visible as JSON rather than Cloudflare 1101.
old2="""  if (url.searchParams.get('refresh') === '1') await syncWbSalesCache(env, market, { force: false });
  return json(await readWbSalesCache(env, market, days),200,request,env);
}"""
new2="""  try {
    if (url.searchParams.get('refresh') === '1') await syncWbSalesCache(env, market, { force: false });
    return json(await readWbSalesCache(env, market, days),200,request,env);
  } catch (e) {
    return json({ok:false,market,days,error:String(e?.message||e)},500,request,env);
  }
}"""
if old2 not in s: raise SystemExit('wbSalesLiveCached return marker not found')
s=s.replace(old2,new2,1)
p.write_text(s,encoding='utf-8')
print('simplified WB D1 product link lookup and added JSON runtime errors')
