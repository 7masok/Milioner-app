const DAY = 86400000;
const FBO_MAX_AGE = 60 * 60_000;
const list = value => Array.isArray(value) ? value : [];
const num = value => Math.max(0, Number(value) || 0);
const parts = p => p?.kind === 'bundle' ? list(p.components) : [];
export function parseAdWarehouse(payload) {
  try { return typeof payload === 'string' ? JSON.parse(payload) : payload || {}; } catch { return {}; }
}

export function arrivalDays(row, settings = {}, now = Date.now()) {
  if (!['to_forwarder', 'to_me', 'at_warehouse'].includes(row.status)) return null;
  if (row.status === 'at_warehouse') return 0;
  const defaults = [{id:'paid',days:0},{id:'departed',days:5},{id:'delivery_warehouse',days:20},{id:'arrived',days:0}];
  const configured = list(settings.purchaseWorkflow);
  const stages = configured.some(s=>s.id==='arrived') && configured.some(s=>s.id==='delivery_warehouse') ? configured : defaults;
  const end = stages.findIndex(s=>s.id==='arrived');
  let current = stages.findIndex(s=>s.id===row.workflowStageId);
  if (current < 0) current = stages.findIndex(s=>s.id===(row.status==='to_me'?'delivery_warehouse':'departed'));
  const at = Number(row.workflowStageAt || row.forwarderReceivedAt || row.orderedAt || row.date || row.createdAt);
  if (current < 0 || current >= end || !at || at > now) return null;
  const due = at + stages.slice(current,end).reduce((sum,s)=>sum+num(s.days),0)*DAY;
  // A late shipment without a confirmed arrival must not suppress a stock warning.
  return due < now ? null : (due-now)/DAY;
}

export function campaignInventory(state, orders, market, campaigns, now = Date.now(), fbo = null) {
  const products = list(state.products).filter(p=>p.kind!=='variant-group');
  const byId = new Map(products.map(p=>[String(p.id),p]));
  const demand = new Map(), reserved = new Map();
  const field = market==='WB2'?'wb2':'wb';
  const identity = p => ({...p[field+'Identity'], ...(p.wbVariant?.market===market?p.wbVariant:{})});
  const article = p => String(identity(p).nmId || (p.variantMarket===market?p.variantNmId:'') || '');
  const fboFresh = Number(fbo?.fetchedAt)>now-FBO_MAX_AGE && Number(fbo.fetchedAt)<=now && fbo.items;
  function fboQuantity(nm) {
    if(!fboFresh)return null;
    const item=fbo.items[nm];
    if(!item)return fbo.fullCatalog?0:null;
    return Number.isSafeInteger(item.quantity)&&item.quantity>=0?item.quantity:null;
  }
  function add(target, id, qty, seen = new Set()) {
    id=String(id); if(seen.has(id))return;
    const p=byId.get(id);if(!p)return;
    const next=new Set(seen);next.add(id);
    if(parts(p).length)for(const part of parts(p))add(target,part.productId,qty*num(part.qty),next);
    else target.set(id,(target.get(id)||0)+qty);
  }
  function codes(p, key) { const aliases=p[key+'Aliases'];return [...new Set([p[key],...(Array.isArray(aliases)?aliases:String(aliases||'').split(/[;,\n]/))].map(x=>String(x||'').trim()).filter(Boolean))]; }
  const skuIndex=new Map();
  for(const key of ['kaspi','wb','wb2','ozon'])for(const p of products)for(const code of codes(p,key)){
    const id=key+':'+code,items=skuIndex.get(id)||[];items.push(p);skuIndex.set(id,items);
  }
  const keyFor = m => m==='Kaspi'?'kaspi':m==='WB2'?'wb2':m==='WB'||m==='WB1'?'wb':m==='Ozon'?'ozon':null;
  for(const order of orders) {
    if(/CANCEL|RETURN|DECLINED|DEFECT/i.test(String(order.status)+' '+String(order.state)))continue;
    const key=keyFor(order.market); if(!key)continue;
    const matches=skuIndex.get(key+':'+String(order.sku).trim())||[];
    // Ambiguous variant articles do not provide a reliable rate for one size.
    if(matches.length===1)add(demand,matches[0].id,num(order.qty));
  }
  for(const row of list(state.reservations))if(row.active===true)add(reserved,row.productId,num(row.qty));
  function available(id, seen=new Set()) {
    id=String(id); const p=byId.get(id);if(!p||seen.has(id))return 0;
    const next=new Set(seen);next.add(id);
    if(p.kind==='bundle')return parts(p).length?Math.floor(Math.min(...parts(p).map(x=>available(x.productId,next)/Math.max(1,num(x.qty))))):0;
    return Math.max(0,num(p.stock)-(reserved.get(id)||0));
  }
  function stockKnown(p, seen=new Set()) {
    if(!p||seen.has(String(p.id)))return false;
    if(p.kind!=='bundle')return p.stock!==null&&p.stock!==''&&Number.isFinite(Number(p.stock));
    const next=new Set(seen);next.add(String(p.id));
    return parts(p).length>0&&parts(p).every(x=>stockKnown(byId.get(String(x.productId)),next));
  }
  function dailyRate(p, seen=new Set()) {
    if(!p||seen.has(String(p.id)))return 0;
    if(p.kind!=='bundle')return (demand.get(String(p.id))||0)/25;
    const next=new Set(seen);next.add(String(p.id));
    return Math.max(0,...parts(p).map(x=>dailyRate(byId.get(String(x.productId)),next)/Math.max(1,num(x.qty))));
  }
  function productRisk(p, fboUnits = 0) {
    const ownAvailable=available(p.id),stock=ownAvailable+fboUnits,daily=dailyRate(p);
    const days=daily>0?stock/daily:null;
    const inbound=list(state.purchases).filter(x=>String(x.productId)===String(p.id)&&num(x.qty)>0&&['to_forwarder','to_me','at_warehouse'].includes(x.status)).map(x=>({qty:num(x.qty),days:arrivalDays(x,state.settings,now)})).sort((a,b)=>(a.days??Infinity)-(b.days??Infinity));
    // Simulate arrivals through day 5. Late or insufficient lots cannot hide a gap.
    let balance=stock, time=0, gap=false;
    if(daily>0) {
      for(const lot of inbound.filter(x=>x.days!==null&&x.days<=5)) {
        balance-=daily*(lot.days-time);if(balance<0)gap=true;
        balance+=lot.qty;time=lot.days;
      }
      balance-=daily*(5-time);
    }
    const covered=daily>0&&!gap&&balance>=0;
    return {productId:String(p.id),name:String(p.name||''),available:stock,ownAvailable,fboAvailable:fboUnits,daily,days,inbound:inbound.reduce((s,x)=>s+x.qty,0),arrivalDays:inbound.find(x=>x.days!==null)?.days??null,overdue:inbound.some(x=>x.days===null),status:stock<=0?'empty':days!==null&&days<5&&!covered?'low':days!==null&&days<5&&covered?'inbound':daily>0?'ok':'no_demand'};
  }
  const risks=new Map(products.map(p=>[String(p.id),productRisk(p)]));
  return new Map(campaigns.map(c=>{
    const codesWanted=list(c.vendorCodes).map(String).filter(Boolean);
    const nms=[...new Set(list(c.nmIds).map(String).filter(nm=>/^[1-9]\d*$/.test(nm)))];
    const codeByArticle=c.vendorCodesByNm;
    const resolved=new Map();
    if (codeByArticle && nms.length) {
      for (const nm of nms) {
        const exact=products.filter(p=>article(p)===nm);
        const code=codeByArticle[nm];
        const fallback=code ? products.filter(p=>!article(p)&&codes(p,field).includes(code)) : [];
        resolved.set(nm,exact.length?exact:fallback.length===1?fallback:[]);
      }
    }
    const matches=resolved.size ? [...new Set([...resolved.values()].flat())]
      : products.filter(p=>nms.includes(article(p)) || ((!article(p)||!nms.length)&&codes(p,field).some(x=>codesWanted.includes(x))));
    const completeCodes=codesWanted.length>0&&codesWanted.every(code=>matches.some(p=>codes(p,field).includes(code)));
    const completeNms=nms.length>0&&nms.every(nm=>matches.some(p=>article(p)===nm));
    const complete=resolved.size ? [...resolved.values()].every(items=>items.length)
      : (completeCodes&&nms.length<=codesWanted.length)||completeNms;
    const localKnown=products.length>0&&complete&&matches.every(p=>stockKnown(p));
    const fboByNm=new Map(nms.map(nm=>[nm,fboQuantity(nm)]));
    const fboKnown=nms.length>0&&[...fboByNm.values()].every(qty=>qty!==null);
    const fboAvailable=[...fboByNm.values()].reduce((sum,qty)=>sum+(qty??0),0);
    const items=matches.map(p=>{
      const nm=article(p)||(nms.length===1&&matches.length===1?nms[0]:'');
      const cardQty=fboByNm.get(nm)||0;
      if(!cardQty)return risks.get(String(p.id));
      const peers=matches.filter(other=>article(other)===nm),chrt=String(identity(p).chrtId||'');
      const sizeQty=fbo.sizes?.[nm+':'+chrt]?.quantity;
      const qty=chrt
        ? peers.filter(other=>String(identity(other).chrtId||'')===chrt).length<=1&&Number.isSafeInteger(sizeQty)&&sizeQty>0?Math.min(sizeQty,cardQty):0
        : p.kind!=='variant'&&peers.length<=1?cardQty:0;
      return qty?productRisk(p,qty):risks.get(String(p.id));
    });
    const ownAvailable=items.reduce((sum,p)=>sum+p.ownAvailable,0);
    const unallocatedFbo=fboAvailable>items.reduce((sum,p)=>sum+p.fboAvailable,0);
    const available=ownAvailable+fboAvailable;
    const known=localKnown&&(available>0||!fbo||fboKnown);
    const allEmpty=known&&available===0;
    const allRisky=known&&!unallocatedFbo&&(!fbo||fboKnown)&&items.every(p=>['empty','low'].includes(p.status));
    const status=!known?'unknown':allEmpty?'empty':!unallocatedFbo&&items.some(p=>['low','empty'].includes(p.status))?'low':items.some(p=>p.status==='inbound')?'inbound':items.every(p=>p.daily===0)?'no_demand':'ok';
    return [Number(c.id),{known,status,allEmpty,allRisky,products:items,periodDays:25,thresholdDays:5,
      available:known?available:null,fboAvailable:fboKnown||fboAvailable>0?fboAvailable:null,
      fboUnconfirmed:localKnown&&!known&&Boolean(fbo),checkedAt:now}];
  }));
}

export function stockBlock(inventory, rule = {}) {
  if(inventory?.fboUnconfirmed)return 'Нет свободного остатка на своём складе. Ждём подтверждения остатков FBO WB';
  if(!inventory?.known)return 'Не удалось проверить остаток: проверьте привязку товаров к складу';
  if(inventory.allEmpty)return 'Нет свободного остатка. Сначала оприходуйте товар';
  if(rule.lowStockMode==='pause'&&inventory.allRisky)return 'Запас меньше 5 дней, поставка не перекрывает нехватку';
  return '';
}
