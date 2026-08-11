from pathlib import Path
import re

p=Path('index.html')
s=p.read_text(encoding='utf-8')

# Product filters should reset pagination to page 1.
s=s.replace('id="q" class="search" placeholder="Поиск по названию или артикулам" oninput="renderProducts()"','id="q" class="search" placeholder="Поиск по названию или артикулам" oninput="productFilterChanged()"',1)
s=s.replace('id="filter" class="select" onchange="renderProducts()"','id="filter" class="select" onchange="productFilterChanged()"',1)
s=s.replace('id="sort" class="select" onchange="renderProducts()"','id="sort" class="select" onchange="productFilterChanged()"',1)

# Add a pager target after the product list.
old='<div id="productList" class="list"></div></section>'
new='<div id="productList" class="list"></div><div id="productPager"></div></section>'
if s.count(old)!=1:
    raise SystemExit('productList anchor mismatch')
s=s.replace(old,new,1)

replacement=r'''let productPage=1;
const PRODUCT_PAGE_SIZE=15;
function productFilterChanged(){productPage=1;renderProducts()}
function setProductPage(page){productPage=Math.max(1,Number(page)||1);renderProducts();const section=document.getElementById('products');if(section)window.scrollTo({top:Math.max(0,section.offsetTop-8),behavior:'smooth'})}
function renderProducts(){let q=(document.getElementById('q')?.value||'').toLowerCase(),f=document.getElementById('filter')?.value||'all',sort=document.getElementById('sort')?.value||'name';let a=state.products.filter(p=>[p.name,p.kaspi,p.wb,p.wb2,p.ozon].join(' ').toLowerCase().includes(q));a=a.filter(p=>{const stock=productDisplayStock(p);return f==='all'||f==='low'&&stock<=p.min&&stock>0||f==='zero'&&stock<=0||f==='buy'&&(stock<=p.min||stock<0)});a.sort((x,y)=>{const xs=productDisplayStock(x),ys=productDisplayStock(y);return sort==='name'?x.name.localeCompare(y.name):sort==='stock'?ys-xs:sort==='sales'?salesDays(y)-salesDays(x):sort==='profit'?profitForProduct(y)-profitForProduct(x):salesDays(x)?xs/salesDays(x)-ys/salesDays(y):0});const list=document.getElementById('productList'),pager=document.getElementById('productPager');if(!list)return;if(!a.length){productPage=1;list.innerHTML='<div class="empty">Товаров не найдено</div>';if(pager)pager.innerHTML='';return}const totalPages=Math.max(1,Math.ceil(a.length/PRODUCT_PAGE_SIZE));productPage=Math.min(Math.max(1,productPage),totalPages);const pageProducts=a.slice((productPage-1)*PRODUCT_PAGE_SIZE,productPage*PRODUCT_PAGE_SIZE);list.innerHTML=pageProducts.map(productCard).join('');if(pager)pager.innerHTML=totalPages>1?`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${productPage<=1?'disabled':''} onclick="setProductPage(${productPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${productPage} из ${totalPages}<br>${a.length} товаров</div><button class="btn" ${productPage>=totalPages?'disabled':''} onclick="setProductPage(${productPage+1})">Вперёд →</button></div></div>`:''}
function productCard'''
pat=r'function renderProducts\(\)\{.*?\}\nfunction productCard'
if len(re.findall(pat,s,flags=re.S))!=1:
    raise SystemExit('renderProducts anchor mismatch')
s=re.sub(pat,replacement,s,count=1,flags=re.S)

p.write_text(s,encoding='utf-8')
print('Product pagination patch applied')
