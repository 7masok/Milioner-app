(function(root){
'use strict';
const text=value=>String(value??'');
const cents=value=>Math.round(Number(value)*100);
function day(value){
 const s=text(value),ru=s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
 const iso=ru?`${ru[3]}-${ru[2]}-${ru[1]}`:s;
 return /^\d{4}-\d{2}-\d{2}$/.test(iso)?Date.parse(iso+'T00:00:00Z'):NaN;
}
function scope(tx){return text(tx?.statementAccountId||tx?.accountId)}
function isAlias(existing,incoming){
 return (Array.isArray(existing?.statementLinks)?existing.statementLinks:[]).some(link=>text(link.accountId)===scope(incoming)&&(
  incoming?.bankOperationKey&&text(link.bankOperationKey)===text(incoming.bankOperationKey)||
  incoming?.statementFingerprint&&text(link.statementFingerprint)===text(incoming.statementFingerprint)
 ));
}
function canLink(existing,incoming){
 if(existing?.type!=='transfer'||incoming?.type!=='transfer'||existing.source!=='bank_statement'||incoming.source!=='bank_statement'||!existing.statementTransfer||!incoming.statementTransfer||existing.affectsBalance===false||incoming.affectsBalance===false||existing.splitCommandId||existing.bankStatus==='blocked'||incoming.bankStatus==='blocked')return false;
 if(!incoming.bankOperationKey&&!incoming.statementFingerprint)return false;
 if(text(existing.accountId)!==text(incoming.accountId)||text(existing.toAccountId)!==text(incoming.toAccountId)||text(existing.currency)!==text(incoming.currency)||text(existing.toCurrency||existing.currency)!==text(incoming.toCurrency||incoming.currency)||text(incoming.currency)!==text(incoming.toCurrency||incoming.currency))return false;
 if(!(cents(incoming.amount)>0)||cents(existing.amount)!==cents(incoming.amount)||cents(existing.toAmount??existing.amount)!==cents(incoming.toAmount??incoming.amount))return false;
 const from=text(incoming.accountId),to=text(incoming.toAccountId),account=scope(incoming),other=scope(existing);
 if(!from||!to||from===to||!existing.statementAccountId||!incoming.statementAccountId||account===other)return false;
 if(incoming.statementDirection!==(account===to?'income':account===from?'expense':'')||existing.statementDirection!==(other===to?'income':other===from?'expense':''))return false;
 if(!['income','expense'].includes(incoming.statementDirection)||!['income','expense'].includes(existing.statementDirection))return false;
 if(!Number.isFinite(day(existing.date))||!Number.isFinite(day(incoming.date))||Math.abs(day(existing.date)-day(incoming.date))>86400000)return false;
 // Each bank side can identify this transfer once; repeated equal transfers stay separate.
 return !(Array.isArray(existing.statementLinks)?existing.statementLinks:[]).some(link=>text(link.accountId)===account);
}
function link(existing,incoming){
 if(isAlias(existing,incoming))return existing;
 if(!canLink(existing,incoming))throw new Error('Перевод уже изменён или не соответствует операции выписки. Выбери его заново.');
 const alias={accountId:scope(incoming),bankOperationKey:text(incoming.bankOperationKey),statementFingerprint:text(incoming.statementFingerprint),statementBank:text(incoming.statementBank),statementHash:text(incoming.statementHash),statementFileName:text(incoming.statementFileName),date:text(incoming.date),time:text(incoming.statementTime),direction:text(incoming.statementDirection)};
 return {...existing,statementLinks:[...(Array.isArray(existing.statementLinks)?existing.statementLinks:[]),alias]};
}
root.FinanceStatementTransfers=Object.freeze({canLink,link,isAlias});
})(globalThis);
