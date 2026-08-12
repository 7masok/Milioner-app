from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
anchor="      if (url.pathname === '/api/wb-finance-summary' && request.method === 'GET') {"
route="""      if (url.pathname === '/api/wb-finance-operation-debug' && request.method === 'GET') {\n        const market=normalizeMarket(url.searchParams.get('market'));\n        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);\n        const days=Math.max(1,Math.min(365,Number(url.searchParams.get('days')||30)));\n        const since=Date.now()-days*86400000;\n        const rows=await env.DB.prepare(`SELECT doc_type AS docType,operation,COUNT(*) rows,SUM(qty) qty,SUM(retail_amount) retailAmount,SUM(for_pay) forPay,SUM(acquiring_fee) acquiring,SUM(delivery_service) delivery,SUM(paid_storage) storage,SUM(paid_acceptance) acceptance,SUM(deduction) deduction,SUM(penalty) penalty,SUM(additional_payment) additionalPayment,SUM(rebill_logistic_cost) rebill FROM wb_finance_rows WHERE market=? AND rr_date>=? GROUP BY doc_type,operation ORDER BY ABS(SUM(for_pay))+ABS(SUM(delivery_service))+ABS(SUM(deduction))+ABS(SUM(penalty)) DESC`).bind(market,since).all();\n        return json({ok:true,market,days,groups:rows.results||[]},200,cors);\n      }\n\n"""
if "'/api/wb-finance-operation-debug'" not in s:
    if anchor not in s: raise SystemExit('anchor missing')
    s=s.replace(anchor,route+anchor,1)
p.write_text(s,encoding='utf-8')
print('operation debug route installed')
