import crypto from 'node:crypto';
import express from 'express';
import pdfParse from 'pdf-parse';
import { pool } from './db.js';
import { credentialFor } from './connections.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

export const aiAssistantRouter = express.Router();
const MODEL = String(process.env.OPENAI_MODEL || 'gpt-5-mini').trim();
const recentRequests = new Map();

function cleanMessages(value) {
  return (Array.isArray(value) ? value : []).slice(-10).map(row => ({
    role: row?.role === 'assistant' ? 'assistant' : 'user',
    content: String(row?.content || '').trim().slice(0, 4000)
  })).filter(row => row.content);
}

export function parseWarehousePayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
  try {
    const parsed = JSON.parse(String(payload || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function snapshotSummary(payload, orderRows = []) {
  const state = parseWarehousePayload(payload);
  const reservations = new Map();
  for (const row of Array.isArray(state.reservations) ? state.reservations : []) {
    if (row?.active === false || row?.cancelled) continue;
    const id = String(row?.productId || '');
    reservations.set(id, (reservations.get(id) || 0) + Math.max(0, Number(row?.qty) || 0));
  }
  const products = (Array.isArray(state.products) ? state.products : []).slice(0, 500).map(p => ({
    id:String(p?.id||''), name:String(p?.name||''), category:String(p?.category||''),
    stock:Number(p?.stock)||0, reserved:reservations.get(String(p?.id||''))||0,
    minStock:Number(p?.min ?? p?.minStock ?? 0)||0, cost:Number(p?.cost)||0,
    kaspi:String(p?.kaspi||''), wb:String(p?.wb||''), wb2:String(p?.wb2||''), ozon:String(p?.ozon||'')
  }));
  const purchases=(Array.isArray(state.purchases)?state.purchases:[]).slice(0,200).map(x=>({productId:String(x?.productId||''),qty:Number(x?.qty)||0,status:String(x?.status||''),orderedAt:Number(x?.orderedAt||x?.date||0)||0,receivedAt:Number(x?.receivedAt||0)||0,unitCost:Number(x?.unitCost)||0,buyTotal:Number(x?.buyTotal)||0,batch:String(x?.batch||'')}));
  const sales=(Array.isArray(state.sales)?state.sales:[]).slice(0,400).map(x=>({productId:String(x?.productId||''),qty:Number(x?.qty)||0,date:Number(x?.date||0)||0,market:String(x?.channel||x?.market||''),price:Number(x?.price)||0,fee:Number(x?.fee)||0,cost:Number(x?.cost)||0}));
  const orders=(Array.isArray(orderRows)?orderRows:[]).slice(0,500).map(x=>({market:String(x?.market||''),orderId:String(x?.order_id||''),status:String(x?.status||''),state:String(x?.state||''),createdAt:Number(x?.creation_date)||0,sku:String(x?.sku||''),name:String(x?.product_name||''),qty:Number(x?.qty)||0,unitPrice:Number(x?.unit_price)||0,totalPrice:Number(x?.total_price)||0}));
  return {generatedAt:new Date().toISOString(),counts:{products:products.length,purchases:purchases.length,sales:sales.length,orders:orders.length},products,purchases,sales,orders};
}

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  return (Array.isArray(data?.output) ? data.output : []).flatMap(item=>Array.isArray(item?.content)?item.content:[]).map(part=>part?.text||'').join('').trim();
}

function cleanStatementCategories(value) {
  return (Array.isArray(value) ? value : []).slice(0, 150).map(row => ({
    name: String(row?.name || '').trim().slice(0, 120),
    kind: ['income','expense','both'].includes(String(row?.kind || '')) ? String(row.kind) : 'both'
  })).filter(row => row.name);
}

function parseJsonObject(text) {
  const raw = String(text || '').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/,'').trim();
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizeStatementDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (!m) return '';
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const month = Number(m[2]), day = Number(m[1]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');
}

function normalizeStatementTime(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return '';
  const hour = Number(m[1]), minute = Number(m[2]), second = m[3] === undefined ? null : Number(m[3]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || (second !== null && (second < 0 || second > 59))) return '';
  return String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+(second === null ? '' : ':'+String(second).padStart(2,'0'));
}

function normalizeStatementResult(raw, sourceHash, filename) {
  const txs = Array.isArray(raw?.transactions) ? raw.transactions : [];
  const seen = new Map();
  const transactions = [];
  for (const row of txs.slice(0, 2000)) {
    const type = String(row?.type || '').toLowerCase();
    const amount = Math.abs(Number(row?.amount) || 0);
    const date = normalizeStatementDate(row?.date);
    const time = normalizeStatementTime(row?.time);
    if (!['income','expense','transfer'].includes(type) || !amount || !date) continue;
    const title = String(row?.title || row?.description || 'Операция').replace(/\s+/g,' ').trim().slice(0,240);
    const note = String(row?.note || '').replace(/\s+/g,' ').trim().slice(0,500);
    const categoryName = String(row?.categoryName || '').trim().slice(0,120);
    const transferDirection = ['in','out'].includes(String(row?.transferDirection||'')) ? String(row.transferDirection) : '';
    const signature = [date,time,type,transferDirection,amount.toFixed(2),title.toLowerCase(),note.toLowerCase()].join('|');
    const occurrence = (seen.get(signature) || 0) + 1;
    seen.set(signature, occurrence);
    const statementFingerprint = crypto.createHash('sha256').update(sourceHash+'|'+signature+'|'+occurrence).digest('hex');
    transactions.push({
      date, time, type, amount, title, note, categoryName, transferDirection, statementFingerprint,
      bankOperationKey:String(row?.bankOperationKey||'').slice(0,96),
      bankStatus:String(row?.bankStatus||'').slice(0,32),
      originalAmount:Math.abs(Number(row?.originalAmount)||0),
      originalCurrency:String(row?.originalCurrency||'').trim().toUpperCase().slice(0,8),
      amountEstimated:Boolean(row?.amountEstimated)
    });
  }
  return {
    statement: {
      sourceHash,
      filename,
      bank: String(raw?.bank || '').trim().slice(0,120),
      accountName: String(raw?.accountName || '').trim().slice(0,160),
      currency: String(raw?.currency || 'KZT').trim().toUpperCase().slice(0,8) || 'KZT',
      periodStart: normalizeStatementDate(raw?.periodStart),
      periodEnd: normalizeStatementDate(raw?.periodEnd),
      pendingCount: Math.max(0,Number(raw?.pendingCount)||0),
      blockedImportedCount: Math.max(0,Number(raw?.blockedImportedCount)||0)
    },
    transactions
  };
}

function cleanPdfText(value) {
  return String(value || '').replace(/\u00a0/g,' ').replace(/\r/g,'').replace(/[ \t]+/g,' ');
}

function kaspiOperationRows(text) {
  const clean=cleanPdfText(text);
  const header=/Дата\s*Сумма\s*Операция\s*Детали/i.exec(clean);
  if(!header)return [];
  const section=clean.slice(header.index+header[0].length);
  const rx=/(\d{2}\.\d{2}\.\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?\s*([+-])\s*([\d\s]+,\d{2})\s*₸?\s*([\s\S]*?)(?=(?:\d{2}\.\d{2}\.\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*[+-]\s*[\d\s]+,\d{2}|(?:\n\s*-\s*Сумма заблокирована)|$)/g;
  const rows=[];
  for(const m of section.matchAll(rx)){
    const amount=Number(String(m[4]).replace(/\s+/g,'').replace(',','.'));
    let rest=String(m[5]||'').replace(/\s+/g,' ').trim();
    rest=rest.replace(/-\s*Сумма заблокирована.*$/i,'').trim();
    if(!Number.isFinite(amount)||amount<=0||!rest)continue;
    if(/^доступно\b/i.test(rest)||/^остаток\b/i.test(rest)||/^итого\b/i.test(rest))continue;
    rows.push({date:m[1],time:m[2]||'',sign:m[3],amount,rest});
  }
  return rows;
}


async function renderPdfLayoutPage(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace:false, disableCombineTextItems:false });
  const rows = [];
  for (const item of Array.isArray(content?.items) ? content.items : []) {
    const text = String(item?.str || '').trim();
    if (!text) continue;
    const transform = Array.isArray(item?.transform) ? item.transform : [];
    const x = Number(transform[4]) || 0, y = Number(transform[5]) || 0;
    let row = rows.find(r => Math.abs(r.y - y) < 1.8);
    if (!row) { row = { y, items:[] }; rows.push(row); }
    row.items.push({ x, text });
  }
  rows.sort((a,b)=>b.y-a.y);
  return rows.map(row=>row.items.sort((a,b)=>a.x-b.x).map(x=>x.text).join(' ')).join('\n');
}

function bccStableTitle(value){
  return String(value||'')
    .replace(/^(?:Аударым|Перевод|Transfer|Төлем|Платеж|Платёж|Payment|Сатып алу|Покупка|Purchase)\s*/i,'')
    .replace(/[^a-zа-яё0-9]+/gi,' ')
    .trim()
    .toLowerCase();
}
function bccOperationKey(date,title,originalAmount,originalCurrency,occurrence=1){
  const base=[String(date||''),bccStableTitle(title),Math.abs(Number(originalAmount)||0).toFixed(2),String(originalCurrency||'').toUpperCase(),occurrence].join('|');
  return crypto.createHash('sha256').update('bcc|'+base).digest('hex').slice(0,48);
}
function bccDateIso(value){
  const m=String(value||'').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m?m[3]+'-'+m[2]+'-'+m[1]:'';
}
function bccMedian(values){
  const rows=(Array.isArray(values)?values:[]).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!rows.length)return 0;
  const mid=Math.floor(rows.length/2);
  return rows.length%2?rows[mid]:(rows[mid-1]+rows[mid])/2;
}
function parseBccBlockedRows(pending, accountCurrency='KZT'){
  const status='(?:ожидается|ожидает|в\\s+ожидании|күтілуде|pending|on\\s+hold)';
  const blockRx=new RegExp('^\\s*(\\d{2}\\.\\d{2}\\.\\d{4})(?:\\s+(\\d{2}:\\d{2}:\\d{2}))?\\s+'+status+'([\\s\\S]*?)(?=^\\s*\\d{2}\\.\\d{2}\\.\\d{4}(?:\\s+\\d{2}:\\d{2}:\\d{2})?\\s+'+status+'|(?![\\s\\S]))','gmi');
  const rows=[];
  for(const m of String(pending||'').matchAll(blockRx)){
    const date=bccDateIso(m[1]),body=String(m[3]||'');
    const time=String(m[2]||((body.match(/\b(\d{2}:\d{2}:\d{2})\b/)||[])[1]||''));
    const amountMatch=/([\d ]+\.\d{2})/.exec(body);
    if(!date||!amountMatch)continue;
    const originalAmount=Number(String(amountMatch[1]).replace(/\s+/g,''));
    if(!Number.isFinite(originalAmount)||originalAmount<=0)continue;
    const before=body.slice(0,amountMatch.index).replace(/\s+/g,' ').trim();
    const after=body.slice(amountMatch.index+amountMatch[0].length);
    const originalCurrency=((body.match(/\b(KZT|USD|EUR|CNY|RUB|GBP|AED|TRY)\b/i)||[])[1]||accountCurrency).toUpperCase();
    const numbers=[...after.matchAll(/\b(\d+\.\d+)\b/g)].map(x=>Number(x[1])).filter(Number.isFinite);
    const cashback=Number(numbers[2])||0;
    const explicitRate=(numbers.slice(3).find(x=>x>=100&&x<=5000))||0;
    const continuation=body.split(/\n+/).slice(1).map(line=>String(line||'')
      .replace(/\b\d{2}:\d{2}:\d{2}\b/g,' ')
      .replace(/\b(?:KZT|USD|EUR|CNY|RUB|GBP|AED|TRY)\b/gi,' ')
      .replace(/\b\d+\.\d+\b/g,' ')
      .replace(/\s+/g,' ').trim()).filter(Boolean).join(' ');
    const title=(before+' '+continuation).replace(/\s+/g,' ').trim()||'Операция';
    rows.push({date,time,title,originalAmount,originalCurrency,cashback,explicitRate});
  }
  const factors=rows.filter(x=>x.originalCurrency!==accountCurrency&&x.explicitRate>0&&x.cashback>0)
    .map(x=>x.cashback/(x.originalAmount*x.explicitRate)).filter(x=>x>.001&&x<.1);
  const cashbackFactor=bccMedian(factors);
  const rateByCurrency=new Map();
  for(const row of rows){
    if(row.explicitRate>0){
      const list=rateByCurrency.get(row.originalCurrency)||[];
      list.push(row.explicitRate);rateByCurrency.set(row.originalCurrency,list);
    }
  }
  const occurrence=new Map(),out=[];
  for(const row of rows){
    let amount=0,amountEstimated=false;
    if(row.originalCurrency===accountCurrency)amount=row.originalAmount;
    else if(row.explicitRate>0)amount=row.originalAmount*row.explicitRate;
    else if(cashbackFactor>0&&row.cashback>0){amount=row.cashback/cashbackFactor;amountEstimated=true}
    else{
      const fallback=bccMedian(rateByCurrency.get(row.originalCurrency)||[]);
      if(fallback>0){amount=row.originalAmount*fallback;amountEstimated=true}
    }
    amount=Math.round(amount*100)/100;
    if(!amount)continue;
    const base=[row.date,bccStableTitle(row.title),row.originalAmount.toFixed(2),row.originalCurrency].join('|');
    const n=(occurrence.get(base)||0)+1;occurrence.set(base,n);
    out.push({
      date:row.date,time:row.time,type:'expense',amount,title:row.title,
      note:'BCC · в блоке',categoryName:'',
      bankStatus:'blocked',bankOperationKey:bccOperationKey(row.date,row.title,row.originalAmount,row.originalCurrency,n),
      originalAmount:row.originalAmount,originalCurrency:row.originalCurrency,amountEstimated
    });
  }
  return out;
}

export function parseBccStatement(text, sourceHash, filename) {
  const clean = cleanPdfText(text);
  const bankMatch = /(Банк\s+ЦентрКредит|Bank\s+CenterCredit|centercredit|KCJBKZKX)/i.test(clean);
  const statementMatch = /(Шот бойынша үзінді|Выписка\s+по\s+сч[её]ту|Выписка|Account\s+statement)/i.test(clean);
  if (!bankMatch || !statementMatch) return null;

  const period = clean.match(/(?:Кезеңі|Период(?:\s+выписки)?|Statement\s+period)\s*[:\-]?\s*(\d{2}\.\d{2}\.\d{4})\s*[-–—]\s*(\d{2}\.\d{2}\.\d{4})/i);
  const account = clean.match(/(?:Шот бойынша үзінді|Выписка\s+по\s+сч[её]ту|Account\s+statement)\s*[:№#-]?\s*([A-Z]{2}\d{10,})/i);
  const card = clean.match(/(?:Карта|Номер\s+(?:платежной\s+)?карты|Payment\s+card\s+number)\s*[:№#-]?\s*([0-9*]{8,})/i);
  const currency = clean.match(/(?:Валюта(?:\s+сч[её]та)?|Шот\s+валютасы|Account\s+currency)\s*[:\-]?\s*([A-Z]{3})/i);
  const accountType = clean.match(/(?:Тип\s+сч[её]та|Шот\s+түрі|Account\s+type)\s*[:\-]?\s*([^\n]+)/i);

  const blockedRx = /(?:Блоктағы транзакциялар|Заблокированные\s+(?:операции|транзакции)|Транзакции\s+в\s+блоке|Операции\s+в\s+блоке|Transactions\s+on\s+hold)/i;
  const blockedMatch = blockedRx.exec(clean);
  const posted = blockedMatch ? clean.slice(0,blockedMatch.index) : clean;
  const pendingRaw = blockedMatch ? clean.slice(blockedMatch.index + blockedMatch[0].length) : '';
  const pending = pendingRaw.split(/(?:Вице-президент|Vice\s+President|QR-код|QR\s*code)/i)[0] || '';
  const pendingCount = (pending.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || []).length;

  const raw = {
    bank:'Bank CenterCredit',
    accountName:card ? 'BCC '+card[1] : (accountType?.[1]?.trim() || '#bccpay'),
    currency:currency?.[1] || 'KZT',
    periodStart:period?.[1] || '',
    periodEnd:period?.[2] || '',
    pendingCount,
    blockedImportedCount:0,
    transactions:[]
  };

  const tableText = posted.replace(
    /(\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}\s+.+?\s+[\d ]+\.\d{2})\s+([+-]?[\d ]+\.\d)\s+(0\.00 KZT\s+0\.00KZT)\n\s*KZT\s+0 KZT/g,
    (_all,prefix,accountAmount,tail)=>prefix+' KZT '+accountAmount+'0 KZT '+tail
  );
  const rowRx = /^\s*(\d{4}-\d{2}(?:-\d{2}|-)?)\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([\d ]+\.\d{2})\s*([A-Z]{3})?\s+([+-]?[\d ]+\.\d{2})(?:\s*(?:[A-Z]{3}))?(?:\s|$)/gmi;
  const postedOccurrence=new Map();
  for (const m of tableText.matchAll(rowRx)) {
    const operationDate = /^\d{4}-\d{2}-\d{2}$/.test(m[1]) ? m[1] : m[2];
    const originalAmount=Number(String(m[4]).replace(/\s+/g,'')),originalCurrency=String(m[5]||raw.currency||'KZT').toUpperCase();
    const accountAmount = Number(String(m[6]).replace(/\s+/g,''));
    if (!Number.isFinite(accountAmount) || accountAmount===0) continue;

    let title = String(m[3]||'Операция').replace(/\s+/g,' ').trim();
    const type = accountAmount < 0 ? 'expense' : 'income';
    let note = '';

    if (/^(Аударым|Перевод|Transfer)(?:\s|$)/i.test(title)) note='Перевод';
    else if (/^(Төлем|Платеж|Платёж|Payment)(?:\s|$)/i.test(title)) note='Платёж';
    else if (/^(Сатып алу|Покупка|Purchase)(?:\s|$)/i.test(title)) note='Покупка';
    else if (/(Foreign currency purchase|Покупка иностранной валюты|Шетел валютасын сатып алу)/i.test(title)) note='Конвертация';

    const base=[operationDate,bccStableTitle(title),Math.abs(originalAmount||0).toFixed(2),originalCurrency].join('|');
    const occurrence=(postedOccurrence.get(base)||0)+1;postedOccurrence.set(base,occurrence);
    raw.transactions.push({
      date:operationDate,
      time:'',
      type,
      amount:Math.abs(accountAmount),
      title,
      note,
      categoryName:'',
      bankStatus:'posted',
      bankOperationKey:bccOperationKey(operationDate,title,originalAmount,originalCurrency,occurrence),
      originalAmount,
      originalCurrency
    });
  }

  const blockedRows=parseBccBlockedRows(pending,raw.currency);
  raw.blockedImportedCount=blockedRows.length;
  raw.transactions.push(...blockedRows);

  const normalized = normalizeStatementResult(raw,sourceHash,filename);
  if (account?.[1]) normalized.statement.accountNumber=account[1];
  normalized.statement.language =
    /Account\s+statement/i.test(clean) ? 'en' :
    /Выписка/i.test(clean) ? 'ru' :
    /Шот бойынша үзінді/i.test(clean) ? 'kk' : '';

  return normalized.transactions.length ? normalized : null;
}

function parseKaspiStatement(text, sourceHash, filename) {
  const clean=cleanPdfText(text);
  if(!/Kaspi\s+Gold/i.test(clean)||!/ВЫПИСКА/i.test(clean))return null;
  const period=clean.match(/за период с\s*(\d{2}\.\d{2}\.\d{2,4})\s*по\s*(\d{2}\.\d{2}\.\d{2,4})/i);
  const account=clean.match(/Номер счета:\s*([A-Z0-9]+)/i);
  const card=clean.match(/Номер карты:\s*([^\s]+)/i);
  const raw={bank:'Kaspi Bank',accountName:card?'Kaspi Gold '+card[1]:'Kaspi Gold',currency:'KZT',periodStart:period?.[1]||'',periodEnd:period?.[2]||'',transactions:[]};
  for(const row of kaspiOperationRows(clean)){
    const lower=row.rest.toLowerCase();
    let type=row.sign==='-'?'expense':'income',transferDirection='',title=row.rest,note='';
    if(/поступление со своего счета|со своего счета в kaspi pay|перевод на сво(?:й|и) счета?/i.test(lower)){
      const detail=row.rest.replace(/поступление со своего счета/i,'').replace(/перевод на сво(?:й|и) счета?/i,'').replace(/^со своего\s+/i,'').trim();
      title=detail||(type==='income'?'Поступление со своего счета':'Перевод на свой счет');
      note=type==='income'?'Поступление со своего счета':'Перевод на свой счет';
    }else if(/^перевод\b/i.test(row.rest)){
      title=row.rest.replace(/^перевод\s*/i,'').trim()||'Перевод';
      note='Перевод';
    }else if(/^покупка\b/i.test(row.rest)){
      title=row.rest.replace(/^покупка\s*/i,'').trim()||'Покупка';
      note='Покупка';
    }else if(/^поступление\b/i.test(row.rest)){
      title=row.rest.replace(/^поступление\s*/i,'').trim()||'Поступление';
      note='Поступление';
    }
    raw.transactions.push({date:row.date,time:row.time,type,transferDirection,amount:row.amount,title,note,categoryName:''});
  }
  const normalized=normalizeStatementResult(raw,sourceHash,filename);
  if(account?.[1])normalized.statement.accountNumber=account[1];
  return normalized.transactions.length?normalized:null;
}

aiAssistantRouter.get('/assistant/status', requireTrustedOrigin, asyncRoute(async (_req,res)=>{
  res.json({ok:true,configured:Boolean(await credentialFor('OPENAI')),model:MODEL});
}));

aiAssistantRouter.post('/assistant/finance-statement', requireTrustedOrigin, asyncRoute(async (req,res)=>{
  const filename=String(req.body?.filename||'statement.pdf').replace(/[\r\n]/g,' ').slice(0,180);
  const fileData=String(req.body?.fileData||'').trim();
  if(!fileData){const error=new Error('Файл не передан');error.status=400;throw error}
  const estimatedBytes=Math.floor(fileData.length*3/4);
  if(estimatedBytes>4_800_000){const error=new Error('PDF слишком большой. Максимум 4,8 МБ');error.status=413;throw error}
  let buffer;
  try{buffer=Buffer.from(fileData,'base64')}catch{const error=new Error('Не удалось прочитать PDF');error.status=400;throw error}
  if(!buffer.length||buffer.length>4_800_000){const error=new Error('PDF пустой или слишком большой');error.status=400;throw error}
  const sourceHash=crypto.createHash('sha256').update(buffer).digest('hex');
  let parsed;
  try{parsed=await pdfParse(buffer)}catch{const error=new Error('Не удалось прочитать текст PDF');error.status=422;throw error}
  let result=parseKaspiStatement(parsed?.text||'',sourceHash,filename),parser='kaspi-local';
  const parsedText=String(parsed?.text||''),looksLikeBcc=/(Банк\s+ЦентрКредит|Bank\s+CenterCredit|centercredit|KCJBKZKX)/i.test(parsedText);
  if(!result&&looksLikeBcc){
    const plainBcc=parseBccStatement(parsedText,sourceHash,filename);
    let layoutBcc=null;
    try{
      const layoutParsed=await pdfParse(buffer,{pagerender:renderPdfLayoutPage});
      layoutBcc=parseBccStatement(layoutParsed?.text||'',sourceHash,filename);
    }catch{}
    result=(layoutBcc?.transactions?.length||0)>(plainBcc?.transactions?.length||0)?layoutBcc:plainBcc;
    parser='bcc-local';
  }
  if(!result){const error=new Error('Сейчас автоматически поддерживаются текстовые выписки Kaspi Gold и BCC. В этом PDF операции не распознаны.');error.status=422;throw error}
  res.json({ok:true,...result,parser});
}));

aiAssistantRouter.post('/assistant/chat', requireTrustedOrigin, asyncRoute(async (req,res)=>{
  const key=await credentialFor('OPENAI');
  if(!key){const error=new Error('Сначала подключите API-ключ OpenAI');error.status=503;throw error}
  const bucket=String(req.ip||'owner'),now=Date.now(),last=recentRequests.get(bucket)||0;
  if(now-last<1500){const error=new Error('Подождите секунду перед следующим сообщением');error.status=429;throw error}
  recentRequests.set(bucket,now);
  const messages=cleanMessages(req.body?.messages);
  if(!messages.length){const error=new Error('Напишите вопрос');error.status=400;throw error}
  const [result,ordersResult]=await Promise.all([
    pool.query('SELECT payload FROM warehouse_state WHERE id=1'),
    pool.query(`SELECT market,order_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price
      FROM marketplace_order_lines ORDER BY creation_date DESC LIMIT 500`)
  ]);
  const context=snapshotSummary(result.rows[0]?.payload,ordersResult.rows);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55_000);
  try{
    const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,store:false,max_output_tokens:4000,reasoning:{effort:'low'},text:{verbosity:'low'},instructions:'Ты встроенный помощник владельца этого склада и продавца на Kaspi и Wildberries. Перед каждым ответом тебе автоматически передаются актуальные данные приложения: товары, остатки, резервы, продажи, закупки и последние заказы. Если владелец говорит «смотри на сайте», «посмотри склад» или похожее — анализируй именно эти переданные данные, не проси CSV, Excel, JSON или скриншоты. Отвечай по-русски, коротко и конкретно. Не выдумывай числа. Если конкретного показателя действительно нет в переданных данных, назови ровно какой показатель отсутствует. Ты анализируешь и советуешь, но пока не изменяешь склад.',input:[{role:'developer',content:'Актуальные данные приложения (JSON): '+JSON.stringify(context)},...messages]})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(String(data?.error?.message||('OpenAI HTTP '+response.status)));error.status=response.status===429?429:502;throw error}
    const answer=outputText(data);
    if(!answer){
      const error=new Error(data?.status==='incomplete'&&data?.incomplete_details?.reason==='max_output_tokens'
        ?'GPT не успел сформировать ответ. Повторите вопрос короче.'
        :'GPT временно не сформировал ответ. Повторите ещё раз.');
      error.status=502;throw error;
    }
    res.json({ok:true,answer,model:MODEL});
  }finally{clearTimeout(timer)}
}));
