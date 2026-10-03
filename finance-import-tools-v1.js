(function(){
'use strict';

if(typeof window.financeStatementCategorySelect!=='function'||typeof window.financeImportStatementDraft!=='function')return;

const splitState=new Map();
const originalCategorySelect=window.financeStatementCategorySelect;
const originalCategoryPickerRender=window.financeStatementRenderCategoryPicker;
const originalStatementPreview=window.financeStatementPreview;
const originalImportStatement=window.financeImportStatementDraft;
const originalTransferChanged=window.financeStatementTransferChanged;
const originalRefundChanged=window.financeStatementRefundChanged;

function rowFor(index){return window.financeStatementDraft?.transactions?.[Number(index)]||null}
function n(value){const x=Number(value);return Number.isFinite(x)?x:0}
function money(value){try{return typeof window.fmt==='function'?window.fmt(value):String(Math.round(n(value)*100)/100)}catch{return String(Math.round(n(value)*100)/100)}}
function html(value){try{return typeof window.esc==='function'?window.esc(String(value??'')):String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}catch{return String(value??'')}}
function categoryName(id){if(String(id)==='__transit__')return 'Транзит';try{return window.financeCategoryName(String(id||''),'Категория')}catch{return'Категория'}}
function visibleCategoriesFor(row){
  try{return window.financeVisibleCategories().filter(c=>c.kind==='both'||c.kind===row?.type)}catch{return[]}
}
function currentAccountId(){return String(document.getElementById('financeStatementAccount')?.value||'')}
function splitFor(index){return splitState.get(Number(index))||null}
function splitTotal(index){return Math.abs(n(rowFor(index)?.amount))}
function simpleHash(value){let h=2166136261;for(const ch of String(value||'')){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return (h>>>0).toString(36)}
function stableSplitFingerprint(row,index){
  const direct=String(row?.statementFingerprint||'').trim();
  if(direct)return direct.slice(0,470);
  const raw=[row?.bankOperationKey,row?.date,row?.time,row?.title,row?.amount,window.financeStatementDraft?.statement?.sourceHash,currentAccountId(),index].join('|');
  return 'split-'+simpleHash(raw)+'-'+simpleHash(raw.split('').reverse().join(''));
}
function splitNote(row,part,totalParts,totalAmount){
  const marker='Разделено '+part+'/'+totalParts+' · исходная сумма '+money(totalAmount);
  const note=String(row?.note||'').trim();
  return note?note+' · '+marker:marker;
}
function splitPartRow(row,index,part,partIndex,totalParts,totalAmount){
  const baseFp=stableSplitFingerprint(row,index),suffix=partIndex===0?'':'#split:'+(partIndex+1),baseKey=String(row?.bankOperationKey||'').trim();
  const originalAmount=Math.abs(n(row?.originalAmount));
  return {
    ...row,
    amount:Math.abs(n(part.amount)),
    originalAmount:originalAmount&&totalAmount?originalAmount*Math.abs(n(part.amount))/totalAmount:originalAmount,
    statementFingerprint:(baseFp.slice(0,Math.max(1,500-suffix.length))+suffix),
    bankOperationKey:baseKey?(baseKey.slice(0,Math.max(1,500-suffix.length))+suffix):'',
    note:splitNote(row,partIndex+1,totalParts,totalAmount)
  };
}
function splitSum(state){return (state?.parts||[]).reduce((sum,p)=>sum+Math.abs(n(p.amount)),0)}
function splitValid(index){
  const state=splitFor(index),total=splitTotal(index);
  if(!state||state.parts.length<2)return {ok:false,message:'Добавьте минимум две части'};
  if(state.parts.some(p=>!String(p.categoryId||'')))return {ok:false,message:'Выберите категорию для каждой части'};
  if(state.parts.some(p=>!(Math.abs(n(p.amount))>0)))return {ok:false,message:'Укажите сумму каждой части'};
  const sum=splitSum(state),diff=Math.round((total-sum)*100)/100;
  if(Math.abs(diff)>.009)return {ok:false,message:diff>0?'Осталось распределить '+money(diff):'Сумма превышена на '+money(Math.abs(diff))};
  return {ok:true,message:'Разделено: '+state.parts.map(p=>categoryName(p.categoryId)+' '+money(p.amount)).join(' + ')};
}
function categoryOptions(row,selected){
  return '<option value="">Категория</option><option value="__transit__" '+(String(selected)==='__transit__'?'selected':'')+'>Транзит · не учитывать</option>'+visibleCategoriesFor(row).map(c=>'<option value="'+html(c.id)+'" '+(String(c.id)===String(selected)?'selected':'')+'>'+html(c.name)+'</option>').join('');
}
function enforceSplitControls(index){
  const state=splitFor(index);if(!state)return;
  const transfer=document.getElementById('financeStatementTransfer-'+index),refundMode=document.getElementById('financeStatementRefundMode-'+index),refund=document.getElementById('financeStatementRefund-'+index),category=document.getElementById('financeStatementCategory-'+index),button=document.getElementById('financeStatementCategoryButton-'+index);
  if(transfer){transfer.value='';transfer.disabled=true}
  if(refundMode){refundMode.value='';refundMode.disabled=true}
  if(refund)refund.value='';
  if(category)category.value=String(state.parts[0]?.categoryId||'');
  if(button){button.disabled=true;button.textContent='Платёж разделён'}
}
function releaseSplitControls(index,state){
  const transfer=document.getElementById('financeStatementTransfer-'+index),refundMode=document.getElementById('financeStatementRefundMode-'+index),category=document.getElementById('financeStatementCategory-'+index),button=document.getElementById('financeStatementCategoryButton-'+index),row=rowFor(index);
  if(transfer)transfer.disabled=false;
  if(refundMode)refundMode.disabled=false;
  if(category&&state?.parts?.[0]?.categoryId)category.value=String(state.parts[0].categoryId);
  if(button){button.disabled=false;button.textContent=window.financeStatementCategoryLabel(row,category?.value||'')}
}
function updateSplitStatus(index){
  const state=splitFor(index),status=document.getElementById('financeStatementSplitStatus-'+index);if(!state||!status)return;
  const result=splitValid(index);status.className='finance-statement-split-status '+(result.ok?'ok':'warn');status.textContent=result.message;
  enforceSplitControls(index);
  try{window.financeStatementUpdateSummary()}catch{}
}
function fillSplitRemainder(index){
  const state=splitFor(index);if(!state||!state.parts.length)return;
  const last=state.parts.length-1;
  if(!state.parts[last].auto)return;
  const others=state.parts.slice(0,-1).reduce((sum,part)=>sum+Math.abs(n(part.amount)),0);
  state.parts[last].amount=Math.max(0,Math.round((splitTotal(index)-others)*100)/100);
}
function renderSplit(index){
  const state=splitFor(index),box=document.getElementById('financeStatementSplitBox-'+index),row=rowFor(index);if(!state||!box||!row)return;
  const removable=state.parts.length>2;
  box.innerHTML='<div class="finance-statement-split-card"><div class="finance-statement-split-head"><b>Разделить платёж</b><button type="button" class="finance-statement-split-close" onclick="financeStatementDisableSplit('+index+')">×</button></div>'+
    state.parts.map((part,p)=>'<div class="finance-statement-split-row'+(removable?' removable':'')+'"><div class="finance-statement-split-category"><select id="financeStatementSplitCategory-'+index+'-'+p+'" onchange="financeStatementSplitCategoryChanged('+index+','+p+',this.value)">'+categoryOptions(row,part.categoryId)+'</select><button type="button" class="finance-statement-split-add-category" onclick="financeStatementQuickAddCategory('+index+','+p+')">+ категория</button></div><input id="financeStatementSplitAmount-'+index+'-'+p+'" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Сумма" value="'+html(part.amount??'')+'" oninput="financeStatementSplitAmountChanged('+index+','+p+',this.value)">'+(removable?'<button type="button" class="finance-statement-split-remove" onclick="financeStatementRemoveSplitPart('+index+','+p+')">×</button>':'')+'</div>').join('')+
    '<button type="button" class="finance-statement-split-more" onclick="financeStatementAddSplitPart('+index+')">Ещё категория</button>'+
    '<div id="financeStatementSplitStatus-'+index+'" class="finance-statement-split-status"></div><div class="finance-statement-split-total">Сумма платежа: <b>'+money(splitTotal(index))+'</b></div></div>';
  enforceSplitControls(index);updateSplitStatus(index);
}
function ensureStyles(){
  if(document.getElementById('financeImportToolsStyle'))return;
  const style=document.createElement('style');style.id='financeImportToolsStyle';style.textContent=`
.finance-category-picker-add{width:100%;border:0;border-top:1px solid var(--line);background:#fff;padding:15px 17px;text-align:left;font-weight:750;font-size:15px}
.finance-category-picker-add:active{background:#f5f6f8}
.finance-quick-category-overlay{position:fixed;inset:0;z-index:80;background:#0006;display:flex;align-items:flex-end;justify-content:center;padding:12px}
.finance-quick-category-card{width:min(520px,100%);background:#fff;border-radius:20px;padding:18px;box-shadow:0 15px 50px #0004}
.finance-statement-split-launch{margin-top:7px;width:100%;border:1px dashed #aeb3ba;background:#fff;border-radius:11px;padding:9px 12px;font-weight:700;text-align:left}
.finance-statement-split-card{margin-top:8px;padding:10px;border:1px solid #dfe2e6;border-radius:13px;background:#f8f9fa}
.finance-statement-split-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.finance-statement-split-close{border:0;background:transparent;font-size:22px;line-height:1;padding:0 4px}
.finance-statement-split-row{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:7px;margin-top:7px}
.finance-statement-split-row select,.finance-statement-split-row input{width:100%;min-width:0;border:1px solid var(--line);border-radius:10px;background:#fff;padding:9px 10px}
.finance-statement-split-category{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px}
.finance-statement-split-add-category{border:1px solid var(--line);border-radius:10px;background:#fff;padding:7px 8px;font-size:11px;white-space:nowrap}
.finance-statement-split-status{margin-top:8px;font-size:11px;line-height:1.3}.finance-statement-split-status.ok{color:#16752d}.finance-statement-split-status.warn{color:#9a5a00}
.finance-statement-split-total{margin-top:5px;font-size:11px;color:var(--muted)}
.finance-statement-split-more{margin-top:8px;width:100%;border:1px dashed #aeb3ba;background:#fff;border-radius:11px;padding:8px 12px;font-weight:700;text-align:left}
.finance-statement-split-row.removable{grid-template-columns:minmax(0,1fr) 96px 28px}
.finance-statement-split-remove{border:0;background:transparent;font-size:20px;line-height:1;padding:0}
@media(max-width:420px){.finance-statement-split-row{grid-template-columns:minmax(0,1fr) 96px}.finance-statement-split-row.removable{grid-template-columns:minmax(0,1fr) 84px 28px}.finance-statement-split-category{grid-template-columns:1fr}.finance-statement-split-add-category{justify-self:start}}
`;document.head.appendChild(style);
}

window.financeStatementCategorySelect=function(tx,index,suggestion=null){
  const base=originalCategorySelect(tx,index,suggestion);
  return base+'<button id="financeStatementSplitLaunch-'+index+'" type="button" class="finance-statement-split-launch" onclick="financeStatementEnableSplit('+index+')">↔ Разделить платёж по категориям</button><div id="financeStatementSplitBox-'+index+'"></div>';
};

window.financeStatementEnableSplit=function(index){
  index=Number(index);const row=rowFor(index);if(!row)return;
  const existing=typeof window.financeStatementExactDuplicate==='function'?window.financeStatementExactDuplicate(row,currentAccountId()):null;
  if(existing)return alert('Этот платёж уже импортирован. Разделение доступно для нового платежа до импорта.');
  if(splitFor(index)){renderSplit(index);return}
  const total=splitTotal(index);if(!(total>0))return alert('У платежа нет суммы для разделения.');
  const current=String(document.getElementById('financeStatementCategory-'+index)?.value||'');
  const firstCategory=current||'';
  splitState.set(index,{parts:[{categoryId:firstCategory,amount:'',auto:false},{categoryId:'',amount:total,auto:true}]});
  const launch=document.getElementById('financeStatementSplitLaunch-'+index);if(launch)launch.hidden=true;
  renderSplit(index);
};
window.financeStatementDisableSplit=function(index){
  index=Number(index);const state=splitFor(index);if(!state)return;
  splitState.delete(index);releaseSplitControls(index,state);
  const box=document.getElementById('financeStatementSplitBox-'+index);if(box)box.innerHTML='';
  const launch=document.getElementById('financeStatementSplitLaunch-'+index);if(launch)launch.hidden=false;
  try{window.financeStatementTransferChanged(index)}catch{}
  try{window.financeStatementRefundChanged(index)}catch{}
  try{window.financeStatementUpdateSummary()}catch{}
};
window.financeStatementSplitCategoryChanged=function(index,part,value){
  const state=splitFor(index);if(!state||!state.parts[part])return;state.parts[part].categoryId=String(value||'');
  if(Number(part)===0){const hidden=document.getElementById('financeStatementCategory-'+index);if(hidden)hidden.value=String(value||'')}
  updateSplitStatus(Number(index));
};
window.financeStatementAddSplitPart=function(index){
  index=Number(index);const state=splitFor(index);if(!state)return;
  if(state.parts.length>=20)return alert('Для одного платежа можно указать не больше 20 категорий.');
  const last=state.parts[state.parts.length-1];
  state.parts.splice(state.parts.length-1,0,{categoryId:'',amount:'',auto:false});
  if(last)last.auto=true;
  fillSplitRemainder(index);
  renderSplit(index);
};
window.financeStatementRemoveSplitPart=function(index,part){
  index=Number(index);part=Number(part);const state=splitFor(index);if(!state||state.parts.length<=2||!state.parts[part])return;
  const removed=state.parts.splice(part,1)[0];
  if(removed?.auto&&state.parts.length)state.parts[state.parts.length-1].auto=true;
  fillSplitRemainder(index);
  renderSplit(index);
};
window.financeStatementSplitAmountChanged=function(index,part,value){
  index=Number(index);part=Number(part);const state=splitFor(index);if(!state||!state.parts[part])return;
  state.parts[part].amount=value;
  state.parts[part].auto=false;
  const last=state.parts.length-1;
  if(part!==last&&state.parts[last]?.auto){fillSplitRemainder(index);const input=document.getElementById('financeStatementSplitAmount-'+index+'-'+last);if(input)input.value=String(state.parts[last].amount)}
  updateSplitStatus(index);
};

window.financeStatementRenderCategoryPicker=function(index,query=''){
  const result=originalCategoryPickerRender(index,query),box=document.getElementById('financeStatementCategoryPickerList');
  const head=document.querySelector('#financeStatementCategoryPicker .finance-category-picker-head');if(head&&!head.querySelector('.finance-category-picker-add')&&!head.querySelector('[onclick*="financeStatementOpenCategoryCreator"]')){const btn=document.createElement('button');btn.type='button';btn.className='finance-category-picker-add';btn.textContent='+ Добавить категорию';btn.onclick=()=>window.financeStatementQuickAddCategory(Number(index),-1);const close=head.querySelector('.finance-category-picker-close');if(close)head.insertBefore(btn,close);else head.appendChild(btn)}
  return result;
};
window.financeStatementQuickAddCategory=function(index,splitPart=-1){
  index=Number(index);splitPart=Number(splitPart);const row=rowFor(index);if(!row)return;
  document.getElementById('financeStatementQuickCategoryCreator')?.remove();
  const prefill=splitPart<0?String(document.getElementById('financeStatementCategoryPickerSearch')?.value||''):'';
  const overlay=document.createElement('div');overlay.id='financeStatementQuickCategoryCreator';overlay.className='finance-quick-category-overlay';overlay.onclick=e=>{if(e.target===overlay)overlay.remove()};
  const defaultKind=String(row.type)==='income'?'income':'expense';
  overlay.innerHTML='<div class="finance-quick-category-card" onclick="event.stopPropagation()"><h3 style="margin-top:0">Новая категория</h3><div class="field"><label>Название</label><input id="financeStatementQuickCategoryName" autocomplete="off" value="'+html(prefill)+'" placeholder="Например, Доставка"></div><div class="field"><label>Для чего</label><select id="financeStatementQuickCategoryKind"><option value="'+defaultKind+'">'+(defaultKind==='income'?'Доходы':'Расходы')+'</option><option value="both">Доходы и расходы</option></select></div><div class="actions"><button type="button" class="btn" onclick="document.getElementById(\'financeStatementQuickCategoryCreator\')?.remove()">Отмена</button><button type="button" class="btn dark" onclick="financeStatementSaveQuickCategory('+index+','+splitPart+')">Добавить</button></div></div>';
  document.body.appendChild(overlay);setTimeout(()=>document.getElementById('financeStatementQuickCategoryName')?.focus(),40);
};
window.financeStatementSaveQuickCategory=async function(index,splitPart=-1){
  index=Number(index);splitPart=Number(splitPart);const name=String(document.getElementById('financeStatementQuickCategoryName')?.value||'').trim(),kind=String(document.getElementById('financeStatementQuickCategoryKind')?.value||'both');if(!name)return alert('Введите название категории');
  const duplicate=window.financeCategories().find(c=>!c.archived&&String(c.name||'').trim().toLowerCase()===name.toLowerCase());
  if(duplicate){document.getElementById('financeStatementQuickCategoryCreator')?.remove();if(splitPart>=0){const state=splitFor(index);if(state?.parts?.[splitPart]){state.parts[splitPart].categoryId=String(duplicate.id);renderSplit(index)}}else window.financeStatementChooseCategory(index,String(duplicate.id));return duplicate}
  const now=Date.now(),category={id:'cat-'+now+'-'+Math.max(0,index),name,kind,includeInTotal:true,createdAt:now,updatedAt:now};
  try{
    await window.financeRunLocalMutation(()=>{window.financeCategories().push(category);return category},()=>[window.financeCommand('/api/finance/categories',{method:'POST',body:{category}})]);
    document.getElementById('financeStatementQuickCategoryCreator')?.remove();
    if(splitPart>=0){const state=splitFor(index);if(state?.parts?.[splitPart]){state.parts[splitPart].categoryId=String(category.id);renderSplit(index)}}else window.financeStatementChooseCategory(index,String(category.id));
    try{window.renderFinanceIfActive()}catch{}
    return category;
  }catch(error){alert('Не удалось создать категорию: '+String(error?.message||error));return null}
};

const originalSummary=window.financeStatementUpdateSummary;
window.financeStatementUpdateSummary=function(){
  if(!splitState.size)return originalSummary();
  const rows=window.financeStatementDraft?.transactions||[];
  let income=0,expense=0,excluded=0,selected=0;
  rows.forEach((row,index)=>{
    const check=document.querySelector('.finance-statement-use[data-index="'+index+'"]');
    if(!check?.checked)return;
    selected++;
    const state=splitFor(index);
    if(state){
      let transit=false;
      for(const part of state.parts){
        const amount=Math.abs(n(part.amount));
        if(String(part.categoryId)==='__transit__'||!String(part.categoryId||'')){if(String(part.categoryId)==='__transit__')transit=true;continue}
        if(row?.type==='income')income+=amount;else if(row?.type==='expense')expense+=amount;
      }
      if(transit)excluded++;
      return;
    }
    const transfer=String(document.getElementById('financeStatementTransfer-'+index)?.value||''),refundId=String(document.getElementById('financeStatementRefund-'+index)?.value||''),category=String(document.getElementById('financeStatementCategory-'+index)?.value||''),amount=Math.abs(n(row?.amount));
    if(refundId){expense-=amount;return}
    if(transfer||category==='__transit__'||!category){excluded++;return}
    if(row?.type==='income')income+=amount;else if(row?.type==='expense')expense+=amount;
  });
  const setText=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=String(value)};
  const setMoney=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=typeof window.fmt==='function'?window.fmt(value):String(value)};
  setText('financeStatementSelectedCount',selected);setMoney('financeStatementExpenseTotal',expense);setMoney('financeStatementIncomeTotal',income);setText('financeStatementExcludedCount',excluded);
};
window.financeStatementTransferChanged=function(index){const result=originalTransferChanged(index);if(splitFor(index))enforceSplitControls(Number(index));return result};
window.financeStatementRefundChanged=function(index){const result=originalRefundChanged(index);if(splitFor(index))enforceSplitControls(Number(index));return result};
window.financeStatementPreview=function(data){splitState.clear();const result=originalStatementPreview(data);setTimeout(()=>{ensureStyles()},0);return result};

function helperInput(container,index,categoryId){
  const check=document.createElement('input');check.type='checkbox';check.checked=true;check.className='finance-statement-use';check.dataset.index=String(index);container.appendChild(check);
  const category=document.createElement('input');category.type='hidden';category.id='financeStatementCategory-'+index;category.value=String(categoryId||'');container.appendChild(category);
  const transfer=document.createElement('input');transfer.type='hidden';transfer.id='financeStatementTransfer-'+index;transfer.value='';container.appendChild(transfer);
  const refund=document.createElement('input');refund.type='hidden';refund.id='financeStatementRefund-'+index;refund.value='';container.appendChild(refund);
  const refundMode=document.createElement('input');refundMode.type='hidden';refundMode.id='financeStatementRefundMode-'+index;refundMode.value='';container.appendChild(refundMode);
}
window.financeImportStatementDraft=async function(){
  const draft=window.financeStatementDraft;if(!draft)return originalImportStatement();
  const active=[...splitState.entries()].filter(([index])=>document.querySelector('.finance-statement-use[data-index="'+index+'"]')?.checked);
  if(!active.length)return originalImportStatement();
  for(const [index] of active){const result=splitValid(index);if(!result.ok){document.getElementById('financeStatementSplitBox-'+index)?.scrollIntoView({behavior:'smooth',block:'center'});return alert(result.message)}}
  const originalRows=Array.isArray(draft.transactions)?draft.transactions:[],expanded=originalRows.slice(),restoreCategories=new Map(),helper=document.createElement('div');helper.hidden=true;helper.id='financeStatementSplitImportHelpers';document.body.appendChild(helper);
  let nextIndex=expanded.length;
  for(const [index,state] of active){
    const row=originalRows[index],total=Math.abs(n(row?.amount)),parts=state.parts.map(p=>({categoryId:String(p.categoryId||''),amount:Math.abs(n(p.amount))}));if(!row)continue;
    const category=document.getElementById('financeStatementCategory-'+index);restoreCategories.set(index,String(category?.value||''));if(category)category.value=parts[0].categoryId;
    expanded[index]=splitPartRow(row,index,parts[0],0,parts.length,total);
    for(let p=1;p<parts.length;p++){expanded.push(splitPartRow(row,index,parts[p],p,parts.length,total));helperInput(helper,nextIndex,parts[p].categoryId);nextIndex++}
  }
  draft.transactions=expanded;
  try{return await originalImportStatement()}
  finally{
    if(window.financeStatementDraft===draft)draft.transactions=originalRows;
    for(const [index,value] of restoreCategories){const category=document.getElementById('financeStatementCategory-'+index);if(category)category.value=value}
    helper.remove();
  }
};

ensureStyles();
})();
