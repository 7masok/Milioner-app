(function(root){
'use strict';
const bank=value=>/bcc|centercredit|центр\s*кредит/i.test(String(value||''));
const isBcc=data=>bank(data?.statement?.bank);
const cents=value=>Math.round(Math.abs(Number(value)||0)*100);
const currency=value=>String(value||'').trim().toUpperCase();
const iban=value=>String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
function day(value){const s=String(value||''),m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);return m?m[3]+'-'+m[2]+'-'+m[1]:/^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
// Seconds are required when the description is allowed to change.
function time(value){const s=String(value||'').trim();return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(s)?s:'';}
function direction(tx,account){if(tx.type==='transfer')return tx.statementDirection||(String(tx.toAccountId)===account?'income':String(tx.accountId)===account?'expense':'');return tx.type==='transit_in'?'income':tx.type==='transit_out'?'expense':String(tx.type||'');}
function scoped(tx,account){return String(tx.statementAccountId||'')===account||(!tx.statementAccountId&&(String(tx.accountId||'')===account||String(tx.toAccountId||'')===account));}
function title(value){return String(value||'').replace(/^(?:Покупка|Purchase|Сатып алу|Плат[её]ж|Payment|Төлем)\s*/i,'').toLowerCase().replace(/[^a-zа-яё0-9]+/gi,' ').trim();}
// The posted table can lose continuation words on the next PDF line.
// Permit a complete-token prefix only, with an identifying merchant word;
// amount/date/scope and a unique pair are still required by matches().
function sameMerchant(a,b){
  const left=title(a),right=title(b);if(!left||!right)return false;
  if(left===right)return true;
  const [short,long]=left.length<right.length?[left,right]:[right,left];
  const legal=new Set(['ip','ип','too','тоо','llp','llc','ao','ао','ooo','ооо']);
  return long.startsWith(short+' ')&&short.split(' ').some(word=>!legal.has(word)&&/[a-zа-яё]/i.test(word)&&word.length>=4);
}
function rowIdentity(row,accountCurrency){
  const original=cents(row.originalAmount),originalCurrency=currency(row.originalCurrency);
  if(original>0&&originalCurrency)return {amount:original,currency:originalCurrency};
  // Only an exact account-currency amount is safe when original metadata is absent.
  if(!row.amountEstimated&&(!originalCurrency||originalCurrency===accountCurrency))return {amount:cents(row.amount),currency:accountCurrency};
  return null;
}
function signature(row,accountCurrency){
  const original=rowIdentity(row,accountCurrency),date=day(row.date),clock=time(row.time);
  return original&&date&&clock&&['income','expense'].includes(row.type)?[date,clock,row.type,original.amount,original.currency,accountCurrency].join('|'):'';
}
async function prepareDraft(data,digest){
  if(!isBcc(data))return data;
  const accountCurrency=currency(data.statement.currency||'KZT'),seen=new Map();
  const transactions=await Promise.all((data.transactions||[]).map(async raw=>{
    const base=signature(raw,accountCurrency);if(!base)return {...raw};
    const occurrence=(seen.get(base)||0)+1;seen.set(base,occurrence);
    return {...raw,_bccIncomingKey:String(raw.bankOperationKey||''),bankOperationKey:(await digest('bcc-v2|'+base+'|'+occurrence)).slice(0,48)};
  }));
  return {...data,transactions};
}
// One saved bank movement can suppress one incoming movement, including split parts.
function matches(data,account,history){
  const result=new Map();if(!account||!isBcc(data))return result;
  const accountCurrency=currency(data.statement.currency||'KZT'),accountNumber=iban(data.statement.accountNumber||data.statement.iban),groups=new Map();
  for(const tx of history||[]){
    if(tx.source!=='bank_statement'||!bank(tx.statementBank)||!scoped(tx,account))continue;
    if(accountNumber&&tx.statementAccountNumber&&iban(tx.statementAccountNumber)!==accountNumber)continue;
    const base=String(tx.bankOperationKey||tx.statementFingerprint||tx.id||'').replace(/#split:\d+$/,'');
    const key=tx.splitCommandId?'split:'+tx.splitCommandId:base;
    if(!key)continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(tx);
  }
  const candidates=[];
  for(const parts of groups.values()){
    const primary=parts.find(tx=>!/#split:\d+$/.test(String(tx.bankOperationKey||tx.statementFingerprint||''))&&(!tx.splitPart||+tx.splitPart===1))||parts[0];
    const dir=direction(primary,account),incoming=primary.type==='transfer'&&dir==='income',cur=currency(incoming?(primary.toCurrency||primary.currency):primary.currency);
    if(cur!==accountCurrency||!['income','expense'].includes(dir))continue;
    if(parts.some(tx=>day(tx.date)!==day(primary.date)||direction(tx,account)!==dir||String(tx.statementTime||'')!==String(primary.statementTime||'')))continue;
    const originals=parts.map(tx=>rowIdentity({...tx,amount:incoming?(tx.toAmount??tx.amount):tx.amount},accountCurrency));
    if(originals.some(x=>!x)||originals.some(x=>x.currency!==originals[0].currency))continue;
    const amount=originals.reduce((n,x)=>n+x.amount,0),row={date:primary.date,time:primary.statementTime,type:dir,amount:parts.reduce((n,tx)=>n+Math.abs(Number(incoming?(tx.toAmount??tx.amount):tx.amount)||0),0),originalAmount:amount/100,originalCurrency:originals[0].currency};
    candidates.push({primary,parts,row,signature:signature(row,accountCurrency)});
  }
  const unused=new Set(candidates),rows=data.transactions||[];
  function compatible(c,row){
    const original=rowIdentity(row,accountCurrency);if(!original||!day(row.date))return false;
    if(day(c.row.date)!==day(row.date)||c.row.type!==row.type||cents(c.row.originalAmount)!==original.amount||currency(c.row.originalCurrency)!==original.currency)return false;
    // An old key without time must not steal a different timed movement.
    return !time(c.row.time)||!time(row.time)||time(c.row.time)===time(row.time);
  }
  // Reserve known keys first; refinement fallback never steals an exact match.
  for(const row of rows){
    const c=candidates.find(c=>unused.has(c)&&compatible(c,row)&&c.parts.some(tx=>(row.bankOperationKey&&tx.bankOperationKey===row.bankOperationKey)||(row._bccIncomingKey&&tx.bankOperationKey===row._bccIncomingKey)||(row.statementFingerprint&&tx.statementFingerprint===row.statementFingerprint)));
    if(c){result.set(row,c.primary);unused.delete(c);}
  }
  for(const row of rows){
    if(result.has(row))continue;const key=signature(row,accountCurrency);
    const c=key&&candidates.find(c=>unused.has(c)&&c.signature===key);
    if(c){result.set(row,c.primary);unused.delete(c);}
  }
  // A posted BCC table may omit time and wrapped merchant words. Require an
  // exact merchant or identifying token prefix, with a unique pair in BOTH directions.
  // After a forced blocked->posted update, untimed posted repeats need the exact name.
  for(const row of rows){
    if(result.has(row)||row.bankStatus!=='posted')continue;
    const available=[...unused].filter(c=>compatible(c,row)&&(c.primary.bankStatus==='blocked'&&sameMerchant(c.primary.title,row.title)||c.primary.bankStatus==='posted'&&!time(c.row.time)&&title(c.primary.title)&&title(c.primary.title)===title(row.title)));
    const incoming=available.length===1?rows.filter(r=>!result.has(r)&&r.bankStatus==='posted'&&compatible(available[0],r)&&sameMerchant(available[0].primary.title,r.title)):[];
    if(available.length===1&&incoming.length===1){result.set(row,available[0].primary);unused.delete(available[0]);}
  }
  return result;
}
root.FinanceBccIdentity={prepareDraft,matches};
if(typeof window!=='undefined'&&typeof root.financeStatementPreview==='function'){
  const preview=root.financeStatementPreview,exact=root.financeStatementExactDuplicate,importDraft=root.financeImportStatementDraft,accountChanged=root.financeStatementMainAccountChanged;
  let cache=null;
  function draft(){return typeof financeStatementDraft!=='undefined'?financeStatementDraft:root.financeStatementDraft;}
  function plan(account,force=false){const data=draft(),history=root.financeTransactions();if(force||!cache||cache.data!==data||cache.rows!==data?.transactions||cache.account!==account||cache.history!==history||cache.length!==history.length||Date.now()-cache.at>1000)cache={data,rows:data?.transactions,account,history,length:history.length,at:Date.now(),matches:matches(data,account,history)};return cache.matches;}
  root.financeStatementPreview=async function(data){
    if(!isBcc(data))return preview(data);
    try{const next=await prepareDraft(data,async value=>{const bytes=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');});cache=null;return preview(next);}
    catch(e){root.showSheet('<h3>Не удалось подготовить выписку</h3><div class="empty">'+root.esc(String(e.message||e))+'</div>');return false;}
  };
  root.financeStatementExactDuplicate=function(row,account=''){
    const data=draft();if(!isBcc(data))return exact(row,account);
    const scope=String(account||row?.statementAccountId||'');
    const alias=root.financeTransactions().find(tx=>root.FinanceStatementTransfers?.isAlias(tx,{...row,statementAccountId:scope}));
    return alias||plan(scope).get(row)||null;
  };
  root.financeStatementMainAccountChanged=function(){cache=null;return accountChanged();};
  root.financeImportStatementDraft=async function(){
    const data=draft();if(!isBcc(data))return importDraft();
    const account=String(document.getElementById('financeStatementAccount')?.value||''),restores=[];
    try{
      for(const [row,saved]of plan(account,true)){restores.push({row,key:row.bankOperationKey,fp:row.statementFingerprint});row.bankOperationKey=String(saved.bankOperationKey||'');row.statementFingerprint=String(saved.statementFingerprint||'');}
      return await importDraft();
    }finally{for(const x of restores){x.row.bankOperationKey=x.key;x.row.statementFingerprint=x.fp;}cache=null;}
  };
}
})(typeof globalThis!=='undefined'?globalThis:this);
