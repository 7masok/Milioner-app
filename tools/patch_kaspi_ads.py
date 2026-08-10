from pathlib import Path
import re

p = Path('index.html')
s = p.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 marker, found {n}')
    s = s.replace(old, new, 1)


if 'function importKaspiAdsFile()' in s:
    raise SystemExit('Kaspi ads import already present')

# Reports UI.
replace_once(
    '<div class="card"><div class="label">Прибыль</div><div class="num" id="rProfit">0 ₸</div></div></div><h2>По маркетплейсам</h2>',
    '<div class="card"><div class="label">Прибыль</div><div class="num" id="rProfit">0 ₸</div></div><div class="card"><div class="label">Реклама Kaspi</div><div class="num" id="rAds">0 ₸</div></div></div><div class="setting" style="display:block;margin-top:12px"><div class="integration-title"><b>Реклама Kaspi</b><span id="kaspiAdsBadge" class="badge">0 ₸</span></div><div id="kaspiAdsStatus" class="muted integration-status">Импортируйте Excel-отчёт из Kaspi Маркетинг.</div><div class="integration-actions"><button class="btn dark" onclick="openKaspiAdsImport()">Импорт Excel</button><button class="btn" onclick="showKaspiAdsHistory()">История</button></div></div><h2>По маркетплейсам</h2>',
    'reports UI',
)

# Persist advertising batches in local state, D1 warehouse state and backups.
replace_once('state.ozonOrderFeed ||= [];state.kaspiBaselineAt ||= null;', 'state.ozonOrderFeed ||= [];state.kaspiAdExpenses ||= [];state.kaspiBaselineAt ||= null;', 'state init')
replace_once('reservations:state.reservations||[],settings,marketOrderState:', 'reservations:state.reservations||[],kaspiAdExpenses:state.kaspiAdExpenses||[],settings,marketOrderState:', 'warehouse snapshot')
replace_once('reservations:Array.isArray(x.reservations)?x.reservations:[],settings:', 'reservations:Array.isArray(x.reservations)?x.reservations:[],kaspiAdExpenses:Array.isArray(x.kaspiAdExpenses)?x.kaspiAdExpenses:[],settings:', 'warehouse normalize')
replace_once('state.reservations=Array.isArray(state.reservations)?state.reservations:[];state.settings=', 'state.reservations=Array.isArray(state.reservations)?state.reservations:[];state.kaspiAdExpenses=Array.isArray(state.kaspiAdExpenses)?state.kaspiAdExpenses:[];state.settings=', 'warehouse apply')
replace_once('restored.reservations||=[];restored.settings||={};', 'restored.reservations||=[];restored.kaspiAdExpenses||=[];restored.settings||={};', 'backup restore')

# Product profitability also subtracts mapped advertising.
replace_once(
    "function profitForProduct(p,days=30){let since=Date.now()-days*86400000;return financialSales().filter(s=>s.productId===p.id&&s.date>=since).reduce((a,s)=>a+(Number(s.qty)||0)*((Number(s.price)||0)-(Number(s.cost)||0)-(Number(s.fee)||0)),0)}",
    "function profitForProduct(p,days=30){let since=Date.now()-days*86400000;const salesProfit=financialSales().filter(s=>s.productId===p.id&&s.date>=since).reduce((a,s)=>a+(Number(s.qty)||0)*((Number(s.price)||0)-(Number(s.cost)||0)-(Number(s.fee)||0)),0);return salesProfit-kaspiAdsForProduct(p.id,days)}",
    'product profit',
)

ads_code = r'''
let xlsxLoadPromise=null;
function adsMoney(value){if(typeof value==='number')return Number.isFinite(value)?Math.max(0,value):0;let x=String(value??'').replace(/\u00a0/g,' ').trim();if(!x)return 0;x=x.replace(/[₸₽$€]/g,'').replace(/\s+/g,'').replace(',','.').replace(/[^0-9.\-]/g,'');const n=Number(x);return Number.isFinite(n)?Math.max(0,n):0}
function adsColumn(value){return String(value??'').toLowerCase().replace(/ё/g,'е').replace(/[\n\r]+/g,' ').replace(/[^a-zа-я0-9]+/gi,' ').trim()}
function adsSkuEqual(a,b){let x=String(a??'').trim(),y=String(b??'').trim();if(!x||!y)return false;if(x===y)return true;if(/^\d+$/.test(x)&&/^\d+$/.test(y))return (x.replace(/^0+/,'')||'0')===(y.replace(/^0+/,'')||'0');return x.toLowerCase()===y.toLowerCase()}
function reportPeriodEnd(){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+1);return d.getTime()}
function kaspiAdsBreakdown(days=reportPeriod){const start=reportPeriodStart(days),end=reportPeriodEnd(),byProduct=new Map();let total=0,unmatched=0;for(const batch of(state.kaspiAdExpenses||[])){const bs=orderDayStart(batch.fromDate),last=orderDayStart(batch.toDate||batch.fromDate);if(bs===null||last===null)continue;const be=last+86400000,span=Math.max(86400000,be-bs),overlap=Math.max(0,Math.min(end,be)-Math.max(start,bs));if(!overlap)continue;const factor=Math.min(1,overlap/span),batchTotal=Math.max(0,Number(batch.amount)||0);total+=batchTotal*factor;let mappedBase=0;for(const row of(batch.perProduct||[])){const amount=Math.max(0,Number(row.amount)||0);mappedBase+=amount;if(row.productId)byProduct.set(String(row.productId),(byProduct.get(String(row.productId))||0)+amount*factor)}const batchUnmatched=Math.max(0,Number.isFinite(Number(batch.unmatchedAmount))?Number(batch.unmatchedAmount):batchTotal-mappedBase);unmatched+=batchUnmatched*factor}return {total,byProduct,unmatched}}
function kaspiAdsForProduct(productId,days=reportPeriod){return kaspiAdsBreakdown(days).byProduct.get(String(productId))||0}
function renderKaspiAdsStatus(days=reportPeriod){const badge=document.getElementById('kaspiAdsBadge'),status=document.getElementById('kaspiAdsStatus');if(!badge||!status)return;const x=kaspiAdsBreakdown(days),count=(state.kaspiAdExpenses||[]).length;badge.textContent=fmt(x.total);badge.className='badge '+(x.total>0?'warn':'');status.textContent=count?`За выбранный период учтено ${fmt(x.total)} · импортов: ${count}${x.unmatched>0?' · без привязки к товару '+fmt(x.unmatched):''}`:'Расходов ещё нет. Импортируйте Excel-отчёт из Kaspi Маркетинг.'}
function loadXlsxLibrary(){if(window.XLSX)return Promise.resolve(window.XLSX);if(xlsxLoadPromise)return xlsxLoadPromise;xlsxLoadPromise=new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';sc.async=true;sc.onload=()=>window.XLSX?resolve(window.XLSX):reject(new Error('Библиотека Excel не загрузилась'));sc.onerror=()=>reject(new Error('Не удалось загрузить обработчик Excel. Проверьте интернет.'));document.head.appendChild(sc)});return xlsxLoadPromise}
function openKaspiAdsImport(){const today=localDateInputValue();showSheet(`<h3>Реклама Kaspi</h3><div class="link-note">В Kaspi Pay откройте Маркетинг → Реклама товаров → Мои кампании, выберите период и скачайте Excel. Здесь укажите тот же период. Если в файле нет даты по каждой строке, расход распределится по дням этого периода равномерно.</div><div class="two"><div class="field"><label>Период от</label><input id="kaspiAdsFrom" type="date" value="${today}"></div><div class="field"><label>Период до</label><input id="kaspiAdsTo" type="date" value="${today}"></div></div><div class="field"><label>Excel-отчёт Kaspi</label><input id="kaspiAdsFile" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"></div><button class="btn dark full" onclick="importKaspiAdsFile()">Импортировать расходы</button>`)}
async function kaspiAdsHash(buffer){try{if(!crypto?.subtle)return '';const digest=await crypto.subtle.digest('SHA-256',buffer.slice(0));return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}catch{return ''}}
async function importKaspiAdsFile(){const input=document.getElementById('kaspiAdsFile'),file=input?.files?.[0],fromDate=document.getElementById('kaspiAdsFrom')?.value||'',toDate=document.getElementById('kaspiAdsTo')?.value||'';if(!file)return alert('Выберите Excel-отчёт Kaspi');const a=orderDayStart(fromDate),b=orderDayStart(toDate);if(a===null||b===null)return alert('Укажите период отчёта');const startDate=a<=b?fromDate:toDate,endDate=a<=b?toDate:fromDate;try{const buffer=await file.arrayBuffer(),XLSX=await loadXlsxLibrary(),workbook=XLSX.read(buffer,{type:'array',cellDates:true}),sheet=workbook.Sheets[workbook.SheetNames[0]],rows=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:true});if(!rows.length)throw new Error('В Excel нет строк');const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))],normalized=headers.map(k=>[k,adsColumn(k)]);const costKey=(normalized.find(([,n])=>n==='стоимость')||normalized.find(([,n])=>/^стоимость\b/.test(n))||normalized.find(([,n])=>/расход.*реклам|затрат.*реклам|стоимост.*реклам/.test(n)))?.[0];if(!costKey)throw new Error('Не найден столбец «Стоимость». Нужен отчёт рекламной кампании Kaspi.');const skuKey=(normalized.find(([,n])=>n==='sku'||n==='артикул')||normalized.find(([,n])=>/\bsku\b|артикул|код товара/.test(n)))?.[0]||'';const nameKey=(normalized.find(([,n])=>/^наименование товара$|^название товара$/.test(n))||normalized.find(([,n])=>/наименован|назван|товар/.test(n)))?.[0]||'';const firstKey=headers[0]||'',perProduct=new Map();let total=0,used=0,mapped=0;for(const row of rows){const label=String((nameKey&&row[nameKey])??row[firstKey]??'').trim();if(/^(итого|всего|total)\b/i.test(label))continue;const amount=adsMoney(row[costKey]);if(!(amount>0))continue;used++;total+=amount;const sku=skuKey?String(row[skuKey]??'').trim():'',name=nameKey?String(row[nameKey]??'').trim():'';let p=null;if(sku)p=state.products.find(x=>adsSkuEqual(x.kaspi,sku))||null;if(!p&&name)p=state.products.find(x=>normalizeName(x.name)===normalizeName(name))||null;if(p){const old=perProduct.get(p.id)||{productId:p.id,sku,name:p.name,amount:0};old.amount+=amount;perProduct.set(p.id,old);mapped+=amount}}if(!(total>0))throw new Error('В столбце «Стоимость» нет рекламных расходов');const hash=await kaspiAdsHash(buffer);if(hash&&(state.kaspiAdExpenses||[]).some(x=>x.hash===hash&&x.fromDate===startDate&&x.toDate===endDate))return alert('Этот отчёт за такой период уже импортирован.');const batch={id:'ads-'+id(),market:'Kaspi',source:'Kaspi Marketing Excel',fileName:file.name,hash,fromDate:startDate,toDate:endDate,amount:total,rowsCount:used,perProduct:[...perProduct.values()],unmatchedAmount:Math.max(0,total-mapped),importedAt:Date.now()};state.kaspiAdExpenses.push(batch);save();closeModal();renderReports();alert(`Реклама Kaspi импортирована.\nРасход: ${fmt(total)}\nСтрок: ${used}\nПривязано к товарам: ${fmt(mapped)}${batch.unmatchedAmount>0?'\nБез привязки: '+fmt(batch.unmatchedAmount):''}`)}catch(e){alert('Не удалось импортировать рекламу Kaspi:\n'+String(e.message||e))}}
function removeKaspiAdsBatch(batchId){const x=(state.kaspiAdExpenses||[]).find(b=>b.id===batchId);if(!x)return;if(!confirm(`Удалить импорт ${x.fileName||''} на ${fmt(x.amount)}?`))return;state.kaspiAdExpenses=(state.kaspiAdExpenses||[]).filter(b=>b.id!==batchId);save();renderReports();showKaspiAdsHistory()}
function showKaspiAdsHistory(){const rows=[...(state.kaspiAdExpenses||[])].sort((a,b)=>(Number(b.importedAt)||0)-(Number(a.importedAt)||0));const body=rows.length?rows.map(x=>`<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>${esc(x.fileName||'Kaspi реклама')}</b><div class="muted">${esc(x.fromDate||'—')} — ${esc(x.toDate||x.fromDate||'—')} · ${x.rowsCount||0} строк</div><div class="muted">Без привязки: ${fmt(x.unmatchedAmount||0)}</div></div><div class="right"><b>${fmt(x.amount)}</b><button class="btn danger" style="display:block;margin-top:7px" onclick="removeKaspiAdsBatch('${x.id}')">Удалить</button></div></div></div>`).join(''):'<div class="empty">Импортов рекламы пока нет</div>';showSheet(`<h3>Реклама Kaspi · история</h3>${body}<button class="btn dark full" onclick="openKaspiAdsImport()">Импортировать ещё</button>`)}
'''.strip()

marker = 'function setReportPeriod(days){'
if s.count(marker) != 1:
    raise SystemExit('ads code marker mismatch')
s = s.replace(marker, ads_code + '\n' + marker, 1)

new_reports = "function renderReports(){document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));let since=reportPeriodStart(reportPeriod),ss=financialSales().filter(s=>Number(s.date)>=since),rev=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.price)||0),0),cost=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.cost)||0),0),fees=ss.reduce((a,s)=>a+(Number(s.qty)||0)*(Number(s.fee)||0),0),ads=kaspiAdsBreakdown(reportPeriod).total;document.getElementById('rRevenue').textContent=fmt(rev);document.getElementById('rCost').textContent=fmt(cost);document.getElementById('rFees').textContent=fmt(fees);document.getElementById('rAds').textContent=fmt(ads);document.getElementById('rProfit').textContent=fmt(rev-cost-fees-ads);renderKaspiAdsStatus(reportPeriod);let names=['Kaspi','WB','WB2','Ozon','Ручная'];document.getElementById('mpReport').innerHTML=names.map(n=>{let a=ss.filter(s=>s.channel===n),channelRev=a.reduce((x,s)=>x+(Number(s.qty)||0)*(Number(s.price)||0),0),channelProfit=a.reduce((x,s)=>x+(Number(s.qty)||0)*((Number(s.price)||0)-(Number(s.cost)||0)-(Number(s.fee)||0)),0)-(n==='Kaspi'?ads:0);return `<div class=\"item row\" role=\"button\" tabindex=\"0\" style=\"cursor:pointer\" onclick=\"openMarketplaceReport('${n}',${reportPeriod})\"><div class=\"grow\"><b>${n}</b><div class=\"muted\">${a.reduce((x,s)=>x+(Number(s.qty)||0),0)} шт. · прибыль ${fmt(channelProfit)}</div></div><b>${fmt(channelRev)}</b></div>`}).join('')}"
s, n = re.subn(r'^function renderReports\(\)\{.*\}$', lambda m: new_reports, s, count=1, flags=re.M)
if n != 1:
    raise SystemExit(f'renderReports replacement count={n}')

new_stats = "function marketplaceProductStats(market,days=reportPeriod){const since=reportPeriodStart(days),rows=financialSales().filter(s=>Number(s.date)>=since&&s.channel===market),map=new Map();for(const sale of rows){const p=prod(sale.productId),key=sale.productId||'unknown',qty=Number(sale.qty)||0,revenue=qty*(Number(sale.price)||0),cost=qty*(Number(sale.cost)||0),fees=qty*(Number(sale.fee)||0);let x=map.get(key);if(!x){x={productId:sale.productId,name:p?.name||'Неизвестный товар',qty:0,revenue:0,cost:0,fees:0,ads:0,profit:0};map.set(key,x)}x.qty+=qty;x.revenue+=revenue;x.cost+=cost;x.fees+=fees;x.profit+=revenue-cost-fees}if(market==='Kaspi'){const ads=kaspiAdsBreakdown(days);for(const [productId,amount] of ads.byProduct){let x=map.get(productId),p=prod(productId);if(!x){x={productId,name:p?.name||'Реклама Kaspi',qty:0,revenue:0,cost:0,fees:0,ads:0,profit:0};map.set(productId,x)}x.ads+=amount;x.profit-=amount}if(ads.unmatched>0){map.set('__kaspi_ads_unmatched__',{productId:null,name:'Реклама Kaspi без привязки',qty:0,revenue:0,cost:0,fees:0,ads:ads.unmatched,profit:-ads.unmatched})}}return [...map.values()].sort((a,b)=>b.profit-a.profit)}"
s, n = re.subn(r'^function marketplaceProductStats\(market,days=reportPeriod\)\{.*\}$', lambda m: new_stats, s, count=1, flags=re.M)
if n != 1:
    raise SystemExit(f'marketplaceProductStats replacement count={n}')

new_open = """function openProduct(pid,market='',days=30){let p=prod(pid);if(!p)return;let periodDays=Math.max(1,Number(days)||30),since=reportPeriodStart(periodDays),baseProfit=market?financialSales().filter(x=>x.productId===p.id&&x.channel===market&&Number(x.date)>=since).reduce((a,x)=>a+(Number(x.qty)||0)*((Number(x.price)||0)-(Number(x.cost)||0)-(Number(x.fee)||0)),0):profitForProduct(p,periodDays),adCost=market==='Kaspi'?kaspiAdsForProduct(p.id,periodDays):0,profit=market==='Kaspi'?baseProfit-adCost:baseProfit,profitLabel=market?`Прибыль ${esc(market)} за ${periodDays===1?'сегодня':periodDays+' дней'}`:'Прибыль за '+periodDays+' дней',deliveryDays=market==='Kaspi'?periodDays:30,kaspiDelivery=productKaspiDelivery(p,deliveryDays),deliveryLabel=`Расход на доставку Kaspi за ${deliveryDays===1?'сегодня':deliveryDays+' дней'}`,adRow=market==='Kaspi'?`<div style=\"margin-top:8px\"><div class=\"muted\">Расход на рекламу Kaspi за ${periodDays===1?'сегодня':periodDays+' дней'}</div><b>${fmt(adCost)}</b></div>`:'';let s=`<h3>${esc(p.name)}</h3><div class=\"item\"><b>Остаток товара</b><div style=\"margin-top:10px\"><div class=\"label\">Всего на складе</div><div class=\"num\">${p.stock} шт.</div></div><div style=\"margin-top:12px\"><div class=\"muted\">Себестоимость 1 шт.</div><b>${fmt(p.cost)}</b></div><div style=\"margin-top:8px\"><div class=\"muted\">${deliveryLabel}</div><b>${fmt(kaspiDelivery)}</b></div>${adRow}<div style=\"margin-top:8px\"><div class=\"muted\">${profitLabel}</div><b>${fmt(profit)}</b></div></div><div class=\"item\" style=\"margin-top:8px\"><b>Артикулы маркетплейсов</b><div style=\"margin-top:9px;line-height:1.8\"><div><span class=\"muted\">Kaspi:</span> ${esc(p.kaspi||'—')}</div><div><span class=\"muted\">WB 1:</span> ${esc(p.wb||'—')}</div><div><span class=\"muted\">WB 2:</span> ${esc(p.wb2||'—')}</div><div><span class=\"muted\">Ozon:</span> ${esc(p.ozon||'—')}</div></div></div><button class=\"btn dark full\" onclick=\"closeModal();openModal('edit','${pid}')\">Редактировать товар</button><button class=\"btn full\" onclick=\"closeModal();openModal('writeoff','${pid}')\">Списать</button><button class=\"btn full\" onclick=\"closeModal();openModal('inventory','${pid}')\">Инвентаризация</button>`;showSheet(s)}"""
s, n = re.subn(r"^function openProduct\(pid,market='',days=30\)\{.*\}$", lambda m: new_open, s, count=1, flags=re.M)
if n != 1:
    raise SystemExit(f'openProduct replacement count={n}')

required = [
    'id="rAds"',
    'function importKaspiAdsFile()',
    'state.kaspiAdExpenses ||= []',
    'kaspiAdExpenses:state.kaspiAdExpenses||[]',
    'function kaspiAdsBreakdown(',
    'Реклама Kaspi без привязки',
    'xlsx@0.18.5',
]
missing = [x for x in required if x not in s]
if missing:
    raise SystemExit('Missing ads markers: ' + ', '.join(missing))

p.write_text(s, encoding='utf-8')
