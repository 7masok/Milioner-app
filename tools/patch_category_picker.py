from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')  # Always patch the full current main file.

helper_marker = "function stockTotal(){"
helpers = r'''function knownCategories(selected=''){const map=new Map(),add=value=>{const x=String(value||'').trim();if(!x)return;const key=x.toLocaleLowerCase('ru-RU');if(!map.has(key))map.set(key,x)};for(const x of(state.settings?.categories||[]))add(x);for(const p of(state.products||[]))add(p.category);add(selected);return [...map.values()].sort((a,b)=>a.localeCompare(b,'ru-RU'))}
function categoryOptions(selected=''){const current=String(selected||'').trim();return `<option value="">Без категории</option>`+knownCategories(current).map(x=>`<option value="${esc(x)}" ${x===current?'selected':''}>${esc(x)}</option>`).join('')+`<option value="__new__">＋ Новая категория</option>`}
function categoryPickerHtml(selectId,inputId,selected=''){return `<div class="field"><label>Категория</label><select id="${selectId}" onchange="toggleNewCategory('${selectId}','${inputId}')">${categoryOptions(selected)}</select><input id="${inputId}" placeholder="Введите новую категорию" style="display:none;margin-top:8px"></div>`}
function toggleNewCategory(selectId,inputId){const select=document.getElementById(selectId),input=document.getElementById(inputId);if(!select||!input)return;const isNew=select.value==='__new__';input.style.display=isNew?'block':'none';if(isNew)setTimeout(()=>input.focus(),0)}
function readCategoryPicker(selectId,inputId){const select=document.getElementById(selectId),input=document.getElementById(inputId);if(!select)return '';return String(select.value==='__new__'?(input?.value||''):select.value||'').trim()}
function rememberCategory(value){const x=String(value||'').trim();if(!x)return;state.settings.categories=Array.isArray(state.settings.categories)?state.settings.categories:[];if(!state.settings.categories.some(v=>String(v||'').trim().toLocaleLowerCase('ru-RU')===x.toLocaleLowerCase('ru-RU')))state.settings.categories.push(x);state.settings.categories.sort((a,b)=>String(a).localeCompare(String(b),'ru-RU'))}
'''
if 'function knownCategories(selected=' not in s:
    if helper_marker not in s:
        raise SystemExit('Category helper insertion anchor not found')
    s = s.replace(helper_marker, helpers + helper_marker, 1)

old = '<div class="field"><label>Категория</label><input id="pc"></div>'
new = "${categoryPickerHtml('pc','pcnew')}"
if old in s:
    s = s.replace(old, new, 1)
elif '<select id="pc"' not in s:
    raise SystemExit('Create-product category field anchor not found')

old = '<div class="field"><label>Категория</label><input id="ec" value="${esc(p.category||\'\')}"></div>'
new = "${categoryPickerHtml('ec','ecnew',p.category||'')}"
if old in s:
    s = s.replace(old, new, 1)
elif '<select id="ec"' not in s:
    raise SystemExit('Edit-product category field anchor not found')

old = "p.name=n;p.category=document.getElementById('ec').value;p.photo="
new = "p.name=n;p.category=readCategoryPicker('ec','ecnew');rememberCategory(p.category);p.photo="
if old in s:
    s = s.replace(old, new, 1)
elif "readCategoryPicker('ec','ecnew')" not in s:
    raise SystemExit('Edit-product save anchor not found')

old = "function createProduct(){let n=document.getElementById('pn').value.trim();if(!n)return alert('Введите название');const p={id:id(),name:n,category:document.getElementById('pc').value,"
new = "function createProduct(){let n=document.getElementById('pn').value.trim();if(!n)return alert('Введите название');const category=readCategoryPicker('pc','pcnew');rememberCategory(category);const p={id:id(),name:n,category,"
if old in s:
    s = s.replace(old, new, 1)
elif "const category=readCategoryPicker('pc','pcnew')" not in s:
    raise SystemExit('Create-product save anchor not found')

required = [
    "function knownCategories(selected='')",
    "function categoryPickerHtml(selectId,inputId,selected='')",
    "function rememberCategory(value)",
    "categoryPickerHtml('pc','pcnew')",
    "categoryPickerHtml('ec','ecnew',p.category||'')",
    "readCategoryPicker('ec','ecnew')",
    "readCategoryPicker('pc','pcnew')",
    '＋ Новая категория',
    'Без категории'
]
missing = [x for x in required if x not in s]
if missing:
    raise SystemExit('Category picker markers missing: ' + ', '.join(missing))

p.write_text(s, encoding='utf-8')
print('Reusable product categories added.')
