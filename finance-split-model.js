(function(root){
'use strict';
function fail(message){throw Object.assign(new Error(message),{status:400});}
function cents(value){
  const n=Number(value),scaled=Math.round(n*100);
  if(!Number.isFinite(n)||!Number.isSafeInteger(scaled)||scaled<=0||Math.abs(n-scaled/100)>1e-7)fail('Укажите положительные суммы с точностью до 0,01');
  return scaled;
}
function buildRows(before,input,parts,commandId,now=Date.now()){
  if(!before?.id)fail('Операция не найдена');
  if(!/^[a-zA-Z0-9_-]{8,180}$/.test(String(commandId||'')))fail('Не найден идентификатор сохранения');
  const type=String(input.type||before.type),total=cents(input.amount??before.amount);
  if(total!==cents(before.amount)||String(input.accountId||before.accountId)!==String(before.accountId)||type!==before.type)fail('При разбивке сумма, счёт и направление операции сохраняются');
  if(!['income','expense','transit_in','transit_out'].includes(before.type)||!['income','expense','transit_in','transit_out'].includes(type)||before.refundOfId)fail('Разбивка доступна для доходов, расходов и транзита без возврата');
  if(before.source==='bank_statement'&&before.bankStatus==='blocked')fail('Дождитесь проведения банковской операции');
  if(!Array.isArray(parts)||parts.length<2||parts.length>20)fail('Добавьте от 2 до 20 частей');
  const normalized=parts.map(p=>({categoryId:String(p?.categoryId||''),units:cents(p?.amount)}));
  if(normalized.some(p=>!p.categoryId))fail('Выберите категорию каждой части');
  if(normalized.reduce((s,p)=>s+p.units,0)!==total)fail('Сумма частей должна совпадать с суммой операции');
  const income=type==='income'||type==='transit_in',base={...before,
    title:String(input.title??before.title??'Операция').trim(),note:String(input.note??before.note??'')};
  const currency=String(base.currency||'KZT');
  const defaultTotal=currency==='KZT'?total/100:Number.isFinite(Number(base.defaultAmount))?Math.abs(Number(base.defaultAmount)):null;
  let allocatedDefault=0;
  return normalized.map((part,index)=>{
    const transit=part.categoryId==='__transit__',suffix='#split:'+commandId+':'+(index+1);
    const row={...base,id:index===0?String(before.id):'fin-split-'+commandId+'-'+index,
      type:income?(transit?'transit_in':'income'):(transit?'transit_out':'expense'),
      amount:part.units/100,categoryId:transit?'':part.categoryId,excludedFromAnalytics:transit,
      affectsBalance:before.affectsBalance!==false,createdAt:Number(before.createdAt)||now,updatedAt:now,
      splitCommandId:commandId,splitOriginalAmount:total/100,splitPart:index+1,splitCount:parts.length};
    delete row._syncUpdatedAt;delete row.toAccountId;delete row.toAmount;delete row.toDefaultAmount;
    if(defaultTotal!==null){const amount=index===parts.length-1?defaultTotal-allocatedDefault:Math.min(defaultTotal-allocatedDefault,Math.round(defaultTotal*part.units/total*100)/100);allocatedDefault+=amount;row.defaultAmount=amount;}else delete row.defaultAmount;
    if(Number.isFinite(Number(before.originalAmount)))row.originalAmount=Number(before.originalAmount)*part.units/cents(before.amount);
    if(index>0){
      for(const key of ['statementFingerprint','bankOperationKey'])row[key]=before[key]?String(before[key]).slice(0,500-suffix.length)+suffix:'';
    }else{
      row.statementFingerprint=String(before.statementFingerprint||'');row.bankOperationKey=String(before.bankOperationKey||'');
    }
    return row;
  });
}
root.financeSplitModel=Object.freeze({cents,buildRows});
})(globalThis);
