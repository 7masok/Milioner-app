from pathlib import Path

path = Path('index.html')
s = path.read_text(encoding='utf-8')

old_select = '<select id="sort" class="select" onchange="productFilterChanged()" style="width:100%">'
new_select = '<select id="sort" class="select" onchange="productSortChanged()" style="width:100%">'
if old_select not in s:
    if new_select not in s:
        raise SystemExit('Product sort select marker not found')
else:
    s = s.replace(old_select, new_select, 1)

old_block = """let productPage=1;\nconst PRODUCT_PAGE_SIZE=15;\nfunction productFilterChanged(){productPage=1;renderProducts()}\nfunction setProductPage(page){productPage=Math.max(1,Number(page)||1);renderProducts();const section=document.getElementById('products');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}\nfunction renderProducts(){let q=(document.getElementById('q')?.value||'').toLowerCase(),f=document.getElementById('filter')?.value||'all',sort=document.getElementById('sort')?.value||'name';"""
new_block = """let productPage=1;\nconst PRODUCT_PAGE_SIZE=15;\nconst PRODUCT_SORT_VALUES=['name','stock','sales','profit','days'];\nfunction normalizeProductSort(value){return PRODUCT_SORT_VALUES.includes(String(value||''))?String(value):'name'}\nfunction productFilterChanged(){productPage=1;renderProducts()}\nfunction productSortChanged(){const el=document.getElementById('sort');state.settings.productSort=normalizeProductSort(el?.value);save();productPage=1;renderProducts()}\nfunction setProductPage(page){productPage=Math.max(1,Number(page)||1);renderProducts();const section=document.getElementById('products');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}\nfunction renderProducts(){const sortEl=document.getElementById('sort'),sort=normalizeProductSort(state.settings.productSort);if(sortEl&&sortEl.value!==sort)sortEl.value=sort;let q=(document.getElementById('q')?.value||'').toLowerCase(),f=document.getElementById('filter')?.value||'all';"""
if old_block not in s:
    if 'function productSortChanged()' not in s:
        raise SystemExit('Product list function block not found')
else:
    s = s.replace(old_block, new_block, 1)

path.write_text(s, encoding='utf-8')
print('Product sort persistence patch applied')
