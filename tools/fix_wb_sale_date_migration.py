from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text()
old="    `CREATE INDEX IF NOT EXISTS idx_wb_finance_market_sale_date ON wb_finance_rows(market,sale_date DESC)`,\n"
if old not in s:
    raise SystemExit('sale date index statement not found')
s=s.replace(old,'',1)
needle="  await ensureColumn(db,'wb_finance_rows','sale_date','INTEGER NOT NULL DEFAULT 0');\n  await db.prepare(`UPDATE wb_finance_rows SET sale_date=COALESCE(CAST(strftime('%s',json_extract(raw_json,'$.saleDt')) AS INTEGER)*1000,CAST(strftime('%s',json_extract(raw_json,'$.sale_dt')) AS INTEGER)*1000,rr_date) WHERE sale_date=0`).run();"
replacement="  await ensureColumn(db,'wb_finance_rows','sale_date','INTEGER NOT NULL DEFAULT 0');\n  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_wb_finance_market_sale_date ON wb_finance_rows(market,sale_date DESC)`).run();\n  await db.prepare(`UPDATE wb_finance_rows SET sale_date=COALESCE(CAST(strftime('%s',json_extract(raw_json,'$.saleDt')) AS INTEGER)*1000,CAST(strftime('%s',json_extract(raw_json,'$.sale_dt')) AS INTEGER)*1000,rr_date) WHERE sale_date=0`).run();"
if needle not in s:
    raise SystemExit('migration block not found')
s=s.replace(needle,replacement,1)
p.write_text(s)
print('fixed sale_date migration order')
