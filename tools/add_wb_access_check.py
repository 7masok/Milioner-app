from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
route="""      if (url.pathname === '/api/wb-access-check' && request.method === 'GET') {\n        const market = normalizeMarket(url.searchParams.get('market'));\n        if (!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);\n        const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();\n        if(!token) return json({ok:true,market,configured:false,finance:false,promotion:false},200,cors);\n        const headers={Authorization:token,Accept:'application/json'};\n        const check=async(u)=>{try{const r=await fetch(u,{headers});return {ok:r.ok,status:r.status}}catch(e){return {ok:false,status:0,error:String(e?.message||e)}}};\n        const [finance,promotion]=await Promise.all([check('https://finance-api.wildberries.ru/api/v1/account/balance'),check('https://advert-api.wildberries.ru/adv/v1/balance')]);\n        return json({ok:true,market,configured:true,finance:finance.ok,promotion:promotion.ok,financeStatus:finance.status,promotionStatus:promotion.status},200,cors);\n      }\n\n"""
anchor="      if (url.pathname === '/api/orders' && request.method === 'GET') {"
if "'/api/wb-access-check'" not in s:
    if anchor not in s: raise SystemExit('route anchor missing')
    s=s.replace(anchor,route+anchor,1)
p.write_text(s,encoding='utf-8')
print('WB access check added')