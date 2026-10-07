(function(){
'use strict';
const originalOpen=window.openModal,originalSave=window.saveFinanceTransaction;
if(typeof originalOpen!=='function'||typeof originalSave!=='function'||!window.financeSplitModel)return;
let editor=null,busy=false;
const el=id=>document.getElementById(id);
// index.html declares esc with const; classic-script lexical bindings do not
// become window properties. Keep this renderer's escaping self-contained.
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const money=value=>window.financeMoney(Number(value)||0,editor?.before?.currency||'KZT');
const expected=tx=>Object.fromEntries(['amount','accountId','type','categoryId','statementFingerprint','title','note'].map(k=>[k,tx[k]??'']));
function input(){return {type:el('financeTransactionType')?.value,accountId:el('financeTransactionAccount')?.value,
  amount:Number(el('financeTransactionAmount')?.value),title:String(el('financeTransactionTitle')?.value||'').trim(),note:String(el('financeTransactionNote')?.value||'').trim()};}
function saveButton(){return document.querySelector('[onclick^="saveFinanceTransaction("]');}
function fillRemainder(){
  if(!editor?.parts?.at(-1)?.auto)return;
  const other=editor.parts.slice(0,-1).reduce((sum,p)=>sum+Math.round((Number(p.amount)||0)*100),0);
  editor.parts.at(-1).amount=Math.max(0,Math.round(editor.before.amount*100)-other)/100;
}
function validation(){
  try{
    const draft=input();if(!draft.title)throw Error('Введите название операции');
    window.financeSplitModel.buildRows(editor.before,draft,editor.parts,'preview-command');
    const kind=['income','transit_in'].includes(draft.type)?'income':'expense';
    for(const part of editor.parts)if(part.categoryId!=='__transit__'&&!window.financeVisibleCategories().some(c=>String(c.id)===part.categoryId&&['both',kind].includes(c.kind)))throw Error('Выберите действующую категорию каждой части');
    return '';
  }catch(e){return String(e.message||e);}
}
function updateStatus(){
  if(!editor?.parts)return;
  const error=validation(),sum=editor.parts.reduce((s,p)=>s+Math.round((Number(p.amount)||0)*100),0)/100;
  const status=el('financeEditSplitStatus');if(status){status.textContent=error||('Распределено '+money(sum)+' из '+money(editor.before.amount));status.className='finance-edit-split-status '+(error?'warn':'ok');}
  const button=saveButton();if(button)button.disabled=busy||Boolean(error);
}
function render(){
  if(!editor?.parts)return;
  const kind=['income','transit_in'].includes(editor.before.type)?'income':'expense';
  const options=selected=>'<option value="">Категория</option><option value="__transit__" '+(selected==='__transit__'?'selected':'')+'>Транзит · не учитывать</option>'+window.financeVisibleCategories().filter(c=>['both',kind].includes(c.kind)).map(c=>'<option value="'+html(c.id)+'" '+(String(c.id)===selected?'selected':'')+'>'+html(c.name)+'</option>').join('');
  const box=el('financeEditSplitBox');if(!box)throw Error('Не найден блок разбивки. Откройте операцию заново.');
  box.innerHTML='<div class="finance-edit-split-head"><b>Разбивка · '+money(editor.before.amount)+'</b><button type="button" class="btn" onclick="financeEditSplitDisable()">Отменить разбивку</button></div>'+editor.parts.map((p,i)=>'<div class="finance-edit-split-part"><div class="field"><label>Категория '+(i+1)+'</label><select onchange="financeEditSplitCategory('+i+',this.value)">'+options(p.categoryId)+'</select></div><div class="field"><label>'+(p.auto?'Остаток':'Сумма')+'</label><input id="financeEditSplitAmount-'+i+'" type="number" min="0.01" step="0.01" inputmode="decimal" value="'+html(p.amount)+'" oninput="financeEditSplitAmount('+i+',this.value)"></div>'+(editor.parts.length>2?'<button type="button" class="btn finance-edit-split-remove" aria-label="Убрать часть '+(i+1)+'" onclick="financeEditSplitRemove('+i+')">×</button>':'')+'</div>').join('')+'<button type="button" class="btn full" onclick="financeEditSplitAdd()">+ Ещё категория</button><div id="financeEditSplitStatus" class="finance-edit-split-status" aria-live="polite"></div>';
  updateStatus();
}
window.openModal=function(type,id=''){
  editor=null;
  const result=originalOpen.apply(this,arguments);
  if(type!=='financeTransaction'||!id)return result;
  const before=window.financeTransactions().find(t=>String(t.id)===String(id));
  const category=el('financeTransactionCategory');if(!before||!category)return result;
  editor={before:JSON.parse(JSON.stringify(before)),id:String(id),parts:null};
  el('financeTransactionTitle')?.addEventListener('input',updateStatus);
  category.closest('.field').insertAdjacentHTML('afterend','<button id="financeEditSplitLaunch" type="button" class="btn full finance-edit-split-launch" onclick="financeEditSplitEnable()">Разделить по категориям</button><div id="financeEditSplitBox"></div>');
  return result;
};
window.financeEditSplitEnable=function(){
  if(!editor||busy)return;
  const before=editor.before,draft=input();
  if(draft.amount!==Number(before.amount)||draft.accountId!==String(before.accountId)||draft.type!==before.type)return alert('Сначала сохраните изменение суммы, счёта или типа, затем откройте разбивку.');
  if(before.refundOfId||window.financeTransactions().some(t=>String(t.refundOfId||'')===editor.id))return alert('У операции есть возврат. Разбивка недоступна.');
  if(before.source==='bank_statement'&&before.bankStatus==='blocked')return alert('Дождитесь проведения банковской операции.');
  const category=['transit_in','transit_out'].includes(before.type)?'__transit__':String(el('financeTransactionCategory')?.value||'');
  editor.parts=[{categoryId:category,amount:'',auto:false},{categoryId:'',amount:Number(before.amount),auto:true}];
  try{
    render();
    el('financeEditSplitLaunch').hidden=true;
    for(const id of ['financeTransactionType','financeTransactionAccount','financeTransactionAmount','financeTransactionCategory'])el(id).disabled=true;
  }catch(e){window.financeEditSplitDisable();alert('Не удалось открыть разбивку: '+String(e.message||e));}
};
window.financeEditSplitDisable=function(){
  if(!editor||busy)return;editor.parts=null;if(el('financeEditSplitBox'))el('financeEditSplitBox').innerHTML='';if(el('financeEditSplitLaunch'))el('financeEditSplitLaunch').hidden=false;
  for(const id of ['financeTransactionType','financeTransactionAccount','financeTransactionAmount','financeTransactionCategory'])el(id).disabled=false;
  if(saveButton())saveButton().disabled=false;
};
window.financeEditSplitCategory=function(i,value){if(editor?.parts?.[i])editor.parts[i].categoryId=String(value);updateStatus();};
window.financeEditSplitAmount=function(i,value){
  if(!editor?.parts?.[i])return;editor.parts[i].amount=value;editor.parts[i].auto=false;
  fillRemainder();const last=editor.parts.length-1;if(editor.parts[last].auto&&el('financeEditSplitAmount-'+last))el('financeEditSplitAmount-'+last).value=editor.parts[last].amount;
  updateStatus();
};
window.financeEditSplitAdd=function(){if(!editor?.parts||busy)return;if(editor.parts.length>=20)return alert('Можно добавить до 20 частей.');editor.parts.splice(editor.parts.length-1,0,{categoryId:'',amount:'',auto:false});fillRemainder();render();};
window.financeEditSplitRemove=function(i){if(!editor?.parts||editor.parts.length<=2||busy)return;const removed=editor.parts.splice(i,1)[0];if(removed.auto)editor.parts.at(-1).auto=true;fillRemainder();render();};
window.saveFinanceTransaction=async function(id=''){
  if(!editor?.parts||String(id)!==editor.id)return originalSave.apply(this,arguments);
  if(busy)return;
  const error=validation();if(error)return alert(error);
  const context=editor,before=context.before,old=window.financeTransactions().find(t=>String(t.id)===context.id);
  if(!old||JSON.stringify(expected(old))!==JSON.stringify(expected(before)))return alert('Операция изменилась. Откройте её заново перед разбивкой.');
  const draft=input(),parts=context.parts.map(p=>({categoryId:p.categoryId,amount:Number(p.amount)}));
  const command=window.financeCommand('/api/finance/transactions/'+encodeURIComponent(context.id)+'/split');
  command.body={commandId:command.id,expected:expected(before),transaction:draft,parts};
  const rows=window.financeSplitModel.buildRows(before,draft,parts,command.id);
  rows.forEach(row=>{row.category=row.categoryId?window.financeCategoryName(row.categoryId,''):'Транзитные деньги';});
  busy=true;updateStatus();
  try{
    const result=await window.financeRunLocalMutation(()=>{
      const list=window.financeTransactions(),index=list.findIndex(row=>String(row.id)===String(before.id));
      if(index<0||rows.slice(1).some(row=>list.some(tx=>String(tx.id)===row.id)))throw Error('Операция или идентификаторы частей изменились');
      // The original balance movement already exists; replace only its journal
      // allocation in the same local commit as the durable split command.
      list[index]=rows[0];list.push(...rows.slice(1));return rows;
    },()=>[command]);
    if(editor===context){editor=null;window.closeModal();}return result;
  }catch(e){alert('Не удалось сохранить разбивку: '+String(e.message||e));}
  finally{busy=false;updateStatus();}
};
const style=document.createElement('style');style.textContent=`
.finance-edit-split-launch{margin-bottom:16px;border-style:dashed;min-height:44px}
#financeEditSplitBox:empty{display:none}#financeEditSplitBox{padding:12px;border:1px solid var(--line);border-radius:16px;margin-bottom:16px;background:#f8f9fa}
.finance-edit-split-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;flex-wrap:wrap}.finance-edit-split-head .btn{min-height:44px}
.finance-edit-split-part{display:grid;grid-template-columns:minmax(0,1fr) minmax(96px,0.6fr) auto;gap:8px;align-items:end}.finance-edit-split-part .field{min-width:0}.finance-edit-split-part input,.finance-edit-split-part select{width:100%;min-width:0}.finance-edit-split-remove{margin-bottom:12px;min-width:44px;min-height:44px}
.finance-edit-split-status{margin-top:12px;font-size:14px}.finance-edit-split-status.ok{color:#16752d}.finance-edit-split-status.warn{color:#9a5a00}
`;document.head.appendChild(style);
})();
