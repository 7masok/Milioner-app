(function(root){
'use strict';
// Page furniture must never identify a bank movement. Keep genuine details intact.
function cleanTitle(value){
  return String(value||'').replace(/(?:АО\s*[«"“]?\s*Kaspi\s+Bank\s*[»"”]?\s*,?\s*БИК\s*:?\s*CASPKZKA|Приложение\s+к\s+Справке\s*(?:№|No|N\s*[oо]|#)\s*\d)[\s\S]*$/i,'').replace(/\s+/g,' ').trim();
}
function polluted(value){return cleanTitle(value)!==String(value||'').replace(/\s+/g,' ').trim();}
function stableTitle(value){return cleanTitle(value).replace(/^(?:Аударым|Перевод|Transfer|Төлем|Платеж|Платёж|Payment|Сатып алу|Покупка|Purchase)\s*/i,'').replace(/[^a-zа-яё0-9]+/gi,' ').trim().toLowerCase();}
function day(value){const s=String(value||''),m=s.match(/^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/);return m?(m[3].length===2?'20':'')+m[3]+'-'+m[2]+'-'+m[1]:/^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
function clock(value){const m=String(value||'').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);if(!m||+m[1]>23||+m[2]>59||(m[3]&&+m[3]>59))return '';return m[1].padStart(2,'0')+':'+m[2]+(m[3]?':'+m[3]:'');}
function isKaspi(statement){return /kaspi/i.test(String(statement?.bank||''));}
function bankBase(row){return [day(row.date),clock(row.time),String(row.type||'').toLowerCase(),Math.abs(Number(row.amount)||0).toFixed(2),stableTitle(row.title)].join('|');}
async function prepareDraft(data,digest){
  if(!isKaspi(data?.statement))return data;
  const seen=new Map(),rows=(data.transactions||[]).map(raw=>{
    const row={...raw,title:cleanTitle(raw.title),_kaspiHadPageMetadata:polluted(raw.title),_kaspiIncomingKey:String(raw.bankOperationKey||'')};
    const base=bankBase(row),occurrence=(seen.get(base)||0)+1;seen.set(base,occurrence);
    return {row,base,occurrence};
  });
  await Promise.all(rows.map(async item=>{item.row.bankOperationKey=(await digest('kaspi|'+item.base+'|'+item.occurrence)).slice(0,48);}));
  return {...data,transactions:rows.map(x=>x.row)};
}
function cents(value){return Math.round(Math.abs(Number(value)||0)*100);}
function direction(tx,account){const type=String(tx.type||'');if(type==='transfer')return tx.statementDirection||(String(tx.toAccountId)===account?'income':String(tx.accountId)===account?'expense':'');return type==='transit_in'?'income':type==='transit_out'?'expense':type;}
function scoped(tx,account){return String(tx.statementAccountId||'')===account||(!tx.statementAccountId&&(String(tx.accountId||'')===account||String(tx.toAccountId||'')===account));}
function groupSignature(row,amount,type,currency,time){return [day(row.date),clock(time),type,amount,String(currency||'KZT').toUpperCase(),stableTitle(row.title)].join('|');}
function identities(tx,account){
  const links=(Array.isArray(tx.statementLinks)?tx.statementLinks:[]).filter(x=>String(x.accountId||'')===account);
  return [...(scoped(tx,account)?[tx]:[]),...links];
}
function exactIdentity(tx,row,account){return identities(tx,account).some(x=>Boolean((row.bankOperationKey&&x.bankOperationKey===row.bankOperationKey)||(row._kaspiIncomingKey&&x.bankOperationKey===row._kaspiIncomingKey)||(row.statementFingerprint&&x.statementFingerprint===row.statementFingerprint)));}
// Match a multiset, not just date+amount: each historic bank movement is used once.
// Fallback requires proof of this specific page-footer bug on either side.
function legacyMatches(data,account,history){
  const matches=new Map();if(!account||!isKaspi(data?.statement))return matches;
  const currency=String(data.statement.currency||'KZT').toUpperCase(),iban=String(data.statement.accountNumber||data.statement.iban||'');
  const groups=new Map();
  for(const tx of history||[]){
    if(tx.source!=='bank_statement'||!scoped(tx,account)||!/kaspi/i.test(String(tx.statementBank||''))||tx.bankStatus==='blocked')continue;
    if(iban&&tx.statementAccountNumber&&String(tx.statementAccountNumber)!==iban)continue;
    const baseKey=String(tx.bankOperationKey||tx.statementFingerprint||tx.id||'').replace(/#split:\d+$/,'');
    const key=tx.splitCommandId?'split:'+tx.splitCommandId:baseKey;
    if(!groups.has(key))groups.set(key,{rows:[],primary:tx});groups.get(key).rows.push(tx);
  }
  const candidates=[];
  for(const group of groups.values()){
    const primary=group.rows.find(x=>!/#split:\d+$/.test(String(x.bankOperationKey||x.statementFingerprint||''))&&(!x.splitPart||+x.splitPart===1))||group.primary;
    const dir=direction(primary,account),incomingTransfer=primary.type==='transfer'&&dir==='income';
    const amount=group.rows.reduce((sum,x)=>sum+cents(incomingTransfer?(x.toAmount??x.amount):x.amount),0);
    const txCurrency=incomingTransfer?(primary.toCurrency||primary.currency):primary.currency;
    if(!['income','expense'].includes(dir)||String(txCurrency||'KZT').toUpperCase()!==currency)continue;
    candidates.push({primary,rows:group.rows,signature:groupSignature(primary,amount,dir,txCurrency,primary.statementTime),dirty:group.rows.some(x=>polluted(x.title))});
  }
  const unused=new Set(candidates),incoming=(data.transactions||[]).map(row=>({row,signature:groupSignature(row,cents(row.amount),row.type,currency,row.time)}));
  // Reserve exact identities first so a legacy guess cannot steal another row's match.
  for(const item of incoming){const candidate=candidates.find(c=>unused.has(c)&&c.signature===item.signature&&c.rows.some(tx=>exactIdentity(tx,item.row,account)));if(candidate){matches.set(item.row,candidate.primary);unused.delete(candidate);}}
  for(const item of incoming){if(matches.has(item.row))continue;const candidate=candidates.find(c=>unused.has(c)&&c.signature===item.signature&&(c.dirty||item.row._kaspiHadPageMetadata));if(candidate){matches.set(item.row,candidate.primary);unused.delete(candidate);}}
  return matches;
}
const model={cleanTitle,polluted,stableTitle,bankBase,prepareDraft,legacyMatches};
root.FinanceKaspiIdentity=model;
if(typeof module==='object'&&module.exports)module.exports=model;

if(typeof window!=='undefined'&&typeof root.financeStatementPreview==='function'){
  const originalPreview=root.financeStatementPreview,originalExact=root.financeStatementExactDuplicate,originalImport=root.financeImportStatementDraft,originalAccountChanged=root.financeStatementMainAccountChanged;
  let cache=null;
  function draft(){return typeof financeStatementDraft!=='undefined'?financeStatementDraft:root.financeStatementDraft;}
  function plan(account,force=false){const data=draft(),history=root.financeTransactions();if(force||!cache||cache.data!==data||cache.account!==account||cache.history!==history||cache.length!==history.length||Date.now()-cache.at>1000)cache={data,account,history,length:history.length,at:Date.now(),matches:legacyMatches(data,account,history)};return cache.matches;}
  root.financeStatementPreview=async function(data){
    try{const next=await prepareDraft(data,async value=>{const bytes=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');});cache=null;return originalPreview(next);}
    catch(error){root.showSheet('<h3>Не удалось подготовить выписку</h3><div class="empty">'+root.esc(String(error.message||error))+'</div>');return false;}
  };
  root.financeStatementExactDuplicate=function(row,account=''){
    const exact=originalExact(row,account);if(exact)return exact;
    const scope=String(account||row?.statementAccountId||'');return plan(scope).get(row)||null;
  };
  root.financeStatementMainAccountChanged=function(){cache=null;return originalAccountChanged();};
  root.financeImportStatementDraft=async function(){
    const data=draft(),account=String(document.getElementById('financeStatementAccount')?.value||''),matches=plan(account,true),restores=[];
    try{
      for(const [row,existing]of matches){restores.push({row,key:row.bankOperationKey,fp:row.statementFingerprint});row.bankOperationKey=String(existing.bankOperationKey||'');row.statementFingerprint=String(existing.statementFingerprint||'');}
      // Reuse the saved identity when sending to the old backend too. No migration or balance write.
      return await originalImport();
    }finally{for(const item of restores){item.row.bankOperationKey=item.key;item.row.statementFingerprint=item.fp;}cache=null;}
  };
}
})(typeof globalThis!=='undefined'?globalThis:this);
