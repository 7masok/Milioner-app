from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
if "const WB_STATISTICS_BASE" not in s:
    s=s.replace("const WB_FINANCE_BASE = 'https://finance-api.wildberries.ru';", "const WB_FINANCE_BASE = 'https://finance-api.wildberries.ru';\nconst WB_STATISTICS_BASE = 'https://statistics-api.wildberries.ru';",1)
marker="      if (url.pathname === '/api/wb-finance-status' && request.method === 'GET') {"
block=r'''      if (url.pathname === '/api/wb-sales-live' && request.method === 'GET') {
        const market=normalizeMarket(url.searchParams.get('market'));
        if(!['WB','WB2'].includes(market)) return json({ok:false,error:'market must be WB or WB2'},400,cors);
        const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
        if(!token) return json({ok:false,error:'WB token is not configured'},400,cors);
        const daysRaw=Number(url.searchParams.get('days')||1);
        const days=daysRaw===-1?-1:Math.max(1,Math.min(90,daysRaw));
        const {since,until}=wbFinancePeriodBounds(days);
        const from=new Date(since).toISOString();
        const endpoint=WB_STATISTICS_BASE+'/api/v1/supplier/sales?dateFrom='+encodeURIComponent(from)+'&flag=0';
        const r=await fetch(endpoint,{headers:{Authorization:token,Accept:'application/json'}});
        let data=null; try{data=await r.json()}catch{}
        if(!r.ok) return json({ok:false,market,status:r.status,error:data?.detail||data?.message||('WB statistics HTTP '+r.status)},r.status,cors);
        const all=Array.isArray(data)?data:[];
        const rows=all.filter(x=>{const t=Date.parse(String(x?.date||x?.lastChangeDate||''));return Number.isFinite(t)&&t>=since&&t<until;});
        const isReturn=x=>String(x?.saleID||x?.saleId||'').trim().toUpperCase().startsWith('R');
        const sales=rows.filter(x=>!isReturn(x));
        const returns=rows.filter(isReturn);
        const byProduct=new Map();
        for(const x of rows){const sign=isReturn(x)?-1:1,key=String(x?.supplierArticle||x?.nmId||x?.barcode||'').trim(),nmId=String(x?.nmId??''),title=String(x?.subject||x?.category||key),revenue=Number(x?.finishedPrice||x?.priceWithDisc||x?.forPay||0)||0;let v=byProduct.get(key);if(!v){v={vendorCode:String(x?.supplierArticle||''),nmId,title,qty:0,revenue:0};byProduct.set(key,v)}v.qty+=sign;v.revenue+=sign*revenue;}
        return json({ok:true,market,days,since,until,totalRows:rows.length,sales:sales.length,returns:returns.length,netQty:sales.length-returns.length,products:[...byProduct.values()].filter(x=>x.qty!==0),sample:rows.slice(0,5).map(x=>({date:x.date,lastChangeDate:x.lastChangeDate,supplierArticle:x.supplierArticle,nmId:x.nmId,saleID:x.saleID,finishedPrice:x.finishedPrice,priceWithDisc:x.priceWithDisc,forPay:x.forPay,isRealization:x.isRealization}))},200,cors);
      }

'''
if "/api/wb-sales-live" not in s:
    if marker not in s: raise SystemExit('route marker missing')
    s=s.replace(marker,block+marker,1)
p.write_text(s,encoding='utf-8')
print('added wb sales live')
