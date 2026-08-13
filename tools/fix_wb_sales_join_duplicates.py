from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')
old="""      SELECT r.*,
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
"""
new="""      SELECT r.*,
        COALESCE((SELECT l.product_id FROM product_links l
          WHERE l.market=r.market AND (trim(l.sku)=trim(r.vendor_code) OR trim(l.sku)=trim(r.nm_id) OR trim(l.sku)=trim(r.barcode))
          ORDER BY CASE WHEN trim(l.sku)=trim(r.vendor_code) THEN 0 WHEN trim(l.sku)=trim(r.nm_id) THEN 1 ELSE 2 END LIMIT 1),'') AS linked_product_id,
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
      MAX(r.linked_product_id) AS productId,
"""
if old not in s: raise SystemExit('priced CTE marker missing')
s=s.replace(old,new,1)
old2="""    FROM priced r
    LEFT JOIN product_links l ON l.market=r.market AND (trim(l.sku)=trim(r.vendor_code) OR trim(l.sku)=trim(r.nm_id) OR trim(l.sku)=trim(r.barcode))
    GROUP BY r.vendor_code,r.nm_id,r.barcode
"""
new2="""    FROM priced r
    GROUP BY r.vendor_code,r.nm_id,r.barcode
"""
if old2 not in s: raise SystemExit('duplicating join marker missing')
s=s.replace(old2,new2,1)
p.write_text(s,encoding='utf-8')
print('removed multiplicative product_links join from WB sales aggregation')
