(function(){
'use strict';
const M=PackagingModel,el=id=>document.getElementById(id),e=v=>esc(String(v??''));
const arg=v=>"'"+encodeURIComponent(String(v)).replace(/'/g,'%27')+"'";
const decode=v=>decodeURIComponent(String(v||''));
let itemForm=null,recipeForm=null,groupForm=null,photoToken=0;
function db(){return state.settings?.packagingV1||{items:[],movements:[]}}
function item(id){return M.catalog(state).find(p=>p.id===id)}
function sig(value){return JSON.stringify(value??null)}
function write(items,movements=db().movements||[]){state.settings.packagingV1={...db(),items,movements};save()}
function error(fn){try{return fn()}catch(err){alert(err.message||String(err))}}
function back(){return '<button type="button" class="btn" onclick="openPackagingCatalog()">‹ Упаковка</button>'}
function image(p){return p.photo?'<img class="pack-photo" src="'+e(p.photo)+'" alt="" loading="lazy">':'<span class="pack-photo pack-placeholder" aria-hidden="true">□</span>'}
window.openPackagingCatalog=function(){
 showSheet('<div class="row"><h3 class="grow">Упаковка</h3><button type="button" class="btn dark" onclick="editPackagingItem()">+ Добавить</button></div><input class="search" id="packSearch" placeholder="Поиск упаковки" oninput="renderPackagingCatalog()"><div id="packCatalogRows" class="list" style="margin-top:12px"></div><div class="link-note">Создайте упаковку, затем назначьте её в карточке товара или сразу всей группе размеров.</div>');renderPackagingCatalog();
};
window.renderPackagingCatalog=function(){
 const query=(el('packSearch')?.value||'').trim().toLocaleLowerCase('ru'),all=M.catalog(state).slice().sort((a,b)=>a.name.localeCompare(b.name,'ru'));
 el('packCatalogRows').innerHTML=all.filter(p=>p.name.toLocaleLowerCase('ru').includes(query)).map(p=>'<button type="button" class="item pack-list-row" onclick="openPackagingItem('+arg(p.id)+')">'+image(p)+'<span class="grow"><b>'+e(p.name)+'</b><span class="muted pack-line">'+fmt(p.unitCost)+' / шт.</span></span><span class="right"><b>'+e(p.stock)+' шт.</b><span class="muted pack-line">Открыть ›</span></span></button>').join('')||'<div class="empty">'+(all.length?'Ничего не найдено':'Пока нет упаковки. Добавьте пакеты, коробочки и другие виды.')+'</div>';
};
function photoField(value){return '<div class="field"><label>Фото</label><input id="packPhoto" value="'+e(value)+'" placeholder="Ссылка на фото"><input type="file" accept="image/*" aria-label="Загрузить фото" style="margin-top:8px" onchange="loadPackagingPhoto(this)"><div id="packPhotoStatus" class="muted" role="status"></div></div>'}
window.loadPackagingPhoto=async function(input){
 const file=input.files?.[0];if(!file)return;const token=++photoToken,target=el('packPhoto');
 if(!file.type.startsWith('image/')||file.size>20000000)return alert('Выберите изображение до 20 МБ.');
 el('packPhotoStatus').textContent='Подготавливаю фото…';
 try{const bitmap=await createImageBitmap(file),scale=Math.min(1,480/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const data=canvas.toDataURL('image/jpeg',.72);if(token!==photoToken||target!==el('packPhoto'))return;if(data.length>350000)throw Error('Фото слишком большое. Выберите другое.');target.value=data;el('packPhotoStatus').textContent='Фото готово. Сохраните изменения.'}catch(err){if(target===el('packPhoto')){el('packPhotoStatus').textContent='Не удалось загрузить фото';alert(err.message||'Выберите другое изображение.')}}
};
function readPhoto(){const photo=el('packPhoto').value.trim();if(photo&&(!/^https?:\/\//i.test(photo)&&!/^data:image\/(jpeg|png|webp);base64,/i.test(photo)||photo.length>350000))throw Error('Для фото используйте загрузку или ссылку http/https.');return photo}
window.editPackagingItem=function(encoded=''){
 if(!requireWarehouseEditReady())return;const p=item(decode(encoded));itemForm={id:p?.id||'',signature:sig(p)};photoToken++;
 showSheet(back()+'<h3>'+(p?'Редактировать упаковку':'Новая упаковка')+'</h3><div class="field"><label>Название</label><input id="packName" maxlength="120" value="'+e(p?.name)+'" placeholder="Например: Коробочка для кольца"></div>'+photoField(p?.photo||'')+(p?'':'<div class="two"><div class="field"><label>Начальный остаток, шт.</label><input id="packInitialStock" type="number" min="0" step="1" value="0"></div><div class="field"><label>Стоимость 1 шт., ₸</label><input id="packInitialCost" type="number" min="0" step="0.01" value="0"></div></div>')+'<button type="button" class="btn dark full" onclick="savePackagingItem()">Сохранить</button>');
};
window.savePackagingItem=function(){error(()=>{
 if(!requireWarehouseEditReady()||!itemForm)return;const old=item(itemForm.id);if(sig(old)!==itemForm.signature)throw Error('Упаковка изменилась на другом устройстве. Откройте её заново.');
 const name=el('packName').value.trim(),photo=readPhoto();if(!name||name.length>120)throw Error('Введите название упаковки.');
 if(M.catalog(state).some(p=>p.id!==old?.id&&p.name.trim().toLocaleLowerCase('ru')===name.toLocaleLowerCase('ru')))throw Error('Упаковка с таким названием уже есть.');
 const now=Date.now(),p={...(old||{}),id:old?.id||id(),name,photo,updatedAt:now};let movements=db().movements||[];
 if(!old){const stock=Number(el('packInitialStock').value),cost=Number(el('packInitialCost').value);if(!Number.isSafeInteger(stock)||stock<0||stock>100000000||!Number.isFinite(cost)||cost<0||cost>1e9)throw Error('Проверьте остаток и стоимость.');p.stock=stock;p.unitCost=cost;p.createdAt=now;movements=[...movements,{id:id(),packagingId:p.id,type:'initial',qty:stock,before:0,after:stock,unitCost:cost,date:now,note:'Начальный остаток'}]}
 write([...M.catalog(state).filter(x=>x.id!==p.id),p],movements);itemForm=null;openPackagingItem(encodeURIComponent(p.id));
})};
window.openPackagingItem=function(encoded){
 const p=item(decode(encoded));if(!p)return openPackagingCatalog();
 const direct=(state.products||[]).filter(x=>Array.isArray(x.packagingRecipe)&&x.packagingRecipe.some(r=>r.packagingId===p.id));
 const history=(db().movements||[]).filter(x=>x.packagingId===p.id).slice().reverse().slice(0,30),labels={receipt:'Приход',inventory:'Инвентаризация',writeoff:'Списание',initial:'Начальный остаток'};
 showSheet(back()+'<div class="row" style="margin-top:12px">'+image(p)+'<h3 class="grow">'+e(p.name)+'</h3></div><div class="item row"><div class="grow"><div class="muted">Остаток</div><div class="num">'+e(p.stock)+' шт.</div></div><div class="right"><div class="muted">Средняя стоимость</div><b>'+fmt(p.unitCost)+' / шт.</b></div></div><div class="pack-actions"><button class="btn dark" onclick="openPackagingAdjustment('+arg(p.id)+',\'receipt\')">+ Приход</button><button class="btn" onclick="openPackagingAdjustment('+arg(p.id)+',\'writeoff\')">Списать</button><button class="btn" onclick="openPackagingAdjustment('+arg(p.id)+',\'inventory\')">Пересчитать</button></div><button class="btn full" onclick="editPackagingItem('+arg(p.id)+')">Название и фото</button>'+(direct.length?'<div class="item" style="margin-top:10px"><b>Назначена товарам</b>'+direct.map(x=>'<button class="btn full" onclick="openProduct(decodeURIComponent('+arg(x.id)+'))">'+e(x.name)+'</button>').join('')+'</div>':'')+'<h3 style="margin-top:16px">Последние операции</h3>'+history.map(m=>'<div class="item"><div class="row"><b class="grow">'+e(labels[m.type]||m.type)+'</b><b>'+(m.qty>0?'+':'')+e(m.qty)+' шт.</b></div><div class="muted">'+e(new Date(m.date).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}))+' · остаток '+e(m.after)+' шт.</div>'+(m.note?'<div>'+e(m.note)+'</div>':'')+'</div>').join(''));
};
window.openPackagingAdjustment=function(encoded,type){
 if(!requireWarehouseEditReady())return;const p=item(decode(encoded));if(!p)return;itemForm={id:p.id,signature:sig(p),type};
 const title={receipt:'Приход упаковки',writeoff:'Списание упаковки',inventory:'Пересчитать упаковку'}[type];if(!title)return;
 showSheet('<h3>'+title+'</h3><div class="item"><b>'+e(p.name)+'</b><div class="muted">Сейчас: '+e(p.stock)+' шт.</div></div><div class="field"><label>'+(type==='inventory'?'Фактически осталось, шт.':'Количество, шт.')+'</label><input id="packAdjustQty" type="number" step="1" min="'+(type==='inventory'?0:1)+'" value="'+(type==='inventory'?p.stock:1)+'"></div>'+(type==='receipt'?'<div class="field"><label>Стоимость 1 шт., ₸</label><input id="packAdjustCost" type="number" min="0" step="0.01" value="'+e(p.unitCost)+'"></div>':'')+'<div class="field"><label>Комментарий</label><input id="packAdjustNote" maxlength="300" placeholder="Необязательно"></div><button class="btn dark full" onclick="savePackagingAdjustment()">Сохранить</button><button class="btn full" onclick="openPackagingItem('+arg(p.id)+')">Отмена</button>');
};
window.savePackagingAdjustment=function(){error(()=>{
 if(!requireWarehouseEditReady()||!itemForm)return;const p=item(itemForm.id);if(!p||sig(p)!==itemForm.signature)throw Error('Остаток изменился. Откройте упаковку заново.');
 const result=M.adjust(p,{type:itemForm.type,qty:el('packAdjustQty').value,unitCost:el('packAdjustCost')?.value,note:el('packAdjustNote').value},Date.now(),id());
 write(M.catalog(state).map(x=>x.id===p.id?result.item:x),[...(db().movements||[]),result.movement]);itemForm=null;openPackagingItem(encodeURIComponent(p.id));
})};
window.packagingProductBlock=function(p){
 const recipe=M.recipe(state,p),parent=(state.products||[]).find(x=>String(x.id)===String(p.variantGroupId||'')),inherited=parent&&!Array.isArray(p.packagingRecipe),cost=M.costs(state,p);
 return '<div class="item" style="margin-top:10px"><div class="row"><b class="grow">Упаковка</b><button type="button" class="btn" onclick="openProductPackaging('+arg(p.id)+')">Настроить</button></div>'+(inherited?'<div class="muted">Общая для всех размеров</div>':'')+(recipe.length?recipe.map(r=>{const pack=item(r.packagingId);return '<div class="row" style="margin-top:9px"><span class="grow">'+e(pack?.name||'Упаковка не найдена')+'<span class="muted pack-line">'+(r.scope==='order'?'на заказ':'на 1 товар')+'</span></span><b>× '+e(r.qty)+'</b></div>'}).join('')+'<div class="muted" style="margin-top:10px">Стоимость: '+fmt(cost.item)+' / товар'+(cost.order?' + '+fmt(cost.order)+' / заказ':'')+'</div>':'<div class="muted" style="margin-top:8px">Пока не назначена</div>')+(parent?'<button type="button" class="btn full" style="margin-top:8px" onclick="openVariantGroupEditor('+arg(parent.id)+')">Общая карточка всех размеров ›</button>':'')+'</div>';
};
window.openProductPackaging=function(encoded){
 if(!requireWarehouseEditReady())return;const p=prod(decode(encoded));if(!p)return;recipeForm={id:p.id,signature:sig(p.packagingRecipe),parentSignature:sig(M.recipe(state,p)),childrenSignature:sig(state.products.filter(x=>String(x.variantGroupId||'')===String(p.id)).map(x=>[x.id,x.packagingRecipe])),rows:structuredClone(M.recipe(state,p))};renderRecipeEditor();
};
function renderRecipeEditor(){
 if(!recipeForm)return;const p=prod(recipeForm.id);if(!p)return;const all=M.catalog(state).slice().sort((a,b)=>a.name.localeCompare(b.name,'ru'));
 const rows=recipeForm.rows.map((r,index)=>'<div class="item pack-recipe-row"><div class="row"><select class="grow" aria-label="Вид упаковки" onchange="changePackagingRow('+index+',\'packagingId\',this.value)"><option value="">Выберите упаковку</option>'+all.map(x=>'<option value="'+e(x.id)+'"'+(r.packagingId===x.id?' selected':'')+'>'+e(x.name)+'</option>').join('')+'</select><button type="button" class="btn" aria-label="Убрать упаковку" onclick="removePackagingRow('+index+')">×</button></div><div class="row" style="margin-top:8px"><input style="width:90px;min-width:0" aria-label="Количество" type="number" min="1" step="1" value="'+e(r.qty)+'" oninput="changePackagingRow('+index+',\'qty\',this.value)"><select class="grow" aria-label="Расход" onchange="changePackagingRow('+index+',\'scope\',this.value)"><option value="item"'+(r.scope!=='order'?' selected':'')+'>На каждый товар</option><option value="order"'+(r.scope==='order'?' selected':'')+'>На весь заказ</option></select></div></div>').join('');
 showSheet('<h3>Упаковка товара</h3><div class="muted" style="margin-bottom:12px">'+e(p.name)+'</div>'+(!all.length?'<div class="empty">Сначала создайте коробочки или пакеты.</div><button class="btn full" onclick="editPackagingItem()">+ Создать упаковку</button>':rows+'<button type="button" class="btn full" onclick="addPackagingRow()">+ Добавить упаковку</button>')+(p.kind==='variant-group'?'<div class="link-note">Общая упаковка применяется ко всем размерам без индивидуальной настройки.</div><label class="pack-check"><input id="packReplaceOverrides" type="checkbox">Заменить также индивидуальную упаковку всех размеров</label>':'')+'<button type="button" class="btn dark full" style="margin-top:12px" onclick="saveProductPackaging()">Сохранить</button>'+(p.variantGroupId?'<button type="button" class="btn full" onclick="inheritProductPackaging()">Использовать общую упаковку размеров</button>':'')+'<div class="link-note">В этой версии состав и стоимость упаковки сохраняются в карточке. Приход и списание упаковки ведутся вручную в разделе «Упаковка».</div>');
}
window.changePackagingRow=function(index,key,value){if(recipeForm?.rows[index]&&['packagingId','qty','scope'].includes(key))recipeForm.rows[index][key]=value};
window.addPackagingRow=function(){if(!recipeForm)return;if(recipeForm.rows.length>=30)return alert('Не больше 30 видов упаковки.');recipeForm.rows.push({packagingId:'',qty:1,scope:'item'});renderRecipeEditor()};
window.removePackagingRow=function(index){recipeForm?.rows.splice(index,1);renderRecipeEditor()};
function currentRecipeProduct(){const p=prod(recipeForm?.id);if(!p||sig(p.packagingRecipe)!==recipeForm.signature||sig(M.recipe(state,p))!==recipeForm.parentSignature)throw Error('Упаковка товара изменилась. Откройте настройку заново.');return p}
window.saveProductPackaging=function(){error(()=>{
 if(!requireWarehouseEditReady()||!recipeForm)return;const p=currentRecipeProduct(),recipe=M.validateRecipe(state,recipeForm.rows),replace=el('packReplaceOverrides')?.checked;
 if(replace&&sig(state.products.filter(x=>String(x.variantGroupId||'')===String(p.id)).map(x=>[x.id,x.packagingRecipe]))!==recipeForm.childrenSignature)throw Error('Индивидуальная упаковка размеров изменилась. Откройте настройку заново.');
 p.packagingRecipe=recipe;
 if(p.kind==='variant-group'&&replace)for(const child of state.products.filter(x=>String(x.variantGroupId||'')===String(p.id)))delete child.packagingRecipe;
 save();recipeForm=null;openProduct(p.id);
})};
window.inheritProductPackaging=function(){error(()=>{if(!requireWarehouseEditReady()||!recipeForm)return;const p=currentRecipeProduct();if(!p.variantGroupId)return;delete p.packagingRecipe;save();recipeForm=null;openProduct(p.id)})};
window.openVariantGroupEditor=function(encoded){
 if(!requireWarehouseEditReady())return;const p=prod(decode(encoded));if(p?.kind!=='variant-group')return;groupForm={id:p.id,signature:sig([p,...state.products.filter(x=>String(x.variantGroupId||'')===String(p.id))])};photoToken++;
 const count=state.products.filter(x=>String(x.variantGroupId||'')===String(p.id)).length;
 showSheet('<h3>Общая карточка</h3><div class="muted">'+count+' размеров</div><div class="field"><label>Общее название</label><input id="packGroupName" maxlength="200" value="'+e(p.name)+'"></div><div class="field"><label>Категория</label><input id="packGroupCategory" maxlength="100" value="'+e(p.category)+'"></div>'+photoField(p.photo||'')+'<label class="pack-check"><input id="packRenameChildren" type="checkbox" checked>Обновить названия всех размеров, сохранив размер</label><label class="pack-check"><input id="packShareDetails" type="checkbox" checked>Применить фото и категорию ко всем размерам</label><button type="button" class="btn dark full" style="margin-top:12px" onclick="saveVariantGroupEditor()">Сохранить общую карточку</button><button type="button" class="btn full" onclick="openProductPackaging('+arg(p.id)+')">Настроить общую упаковку</button>');
};
window.saveVariantGroupEditor=function(){error(()=>{
 if(!requireWarehouseEditReady()||!groupForm)return;const p=prod(groupForm.id),children=state.products.filter(x=>String(x.variantGroupId||'')===String(p?.id));if(!p||sig([p,...children])!==groupForm.signature)throw Error('Карточка или размеры изменились. Откройте редактирование заново.');
 const updates=M.updateGroup(state,p.id,{name:el('packGroupName').value,category:el('packGroupCategory').value,photo:readPhoto(),renameChildren:el('packRenameChildren').checked,shareDetails:el('packShareDetails').checked}),map=new Map(updates.map(x=>[x.id,x]));state.products=state.products.map(x=>map.get(x.id)||x);rememberCategory(prod(p.id).category);save();render();groupForm=null;openProduct(p.id);
})};
})();
