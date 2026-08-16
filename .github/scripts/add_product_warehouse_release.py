from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

marker = "function deleteProduct(pid){"
insert = r'''function openProductWarehouseRelease(pid){const p=prod(pid);if(!p||isBundleProduct(p))return;const available=purchaseAtWarehouseQty(pid);if(available<=0)return alert('Для этого товара нет количества на складе, ожидающего ввода в продажу.');showSheet(`<h3>Из склада в продажу</h3><div class="item"><div class="name">${esc(p.name)}</div><div class="muted" style="margin-top:6px">На складе, не в продаже: <b>${available} шт.</b></div></div><div class="field"><label>Сколько ввести в продажу</label><input id="productWarehouseReleaseQty" type="number" min="1" max="${available}" value="${available}"></div><button class="btn full" onclick="document.getElementById('productWarehouseReleaseQty').value=${available}">Ввести всё</button><button class="btn dark full" onclick="releaseProductWarehouseQty('${pid}')">Ввести в продажу</button>`)}
function releaseProductWarehouseQty(pid){const p=prod(pid);if(!p||isBundleProduct(p))return;let need=Math.floor(Number(document.getElementById('productWarehouseReleaseQty')?.value)||0),available=purchaseAtWarehouseQty(pid);if(need<=0)return alert('Укажите количество');if(need>available)return alert('На складе доступно только '+available+' шт.');if(!confirm(`Ввести в продажу ${need} шт. товара «${p.name}»?`))return;const now=Date.now(),rows=(state.purchases||[]).filter(x=>String(x.productId)===String(pid)&&purchaseStatus(x)==='at_warehouse').sort((a,b)=>(Number(a.warehouseReceivedAt||a.orderedAt||a.date||a.createdAt)||0)-(Number(b.warehouseReceivedAt||b.orderedAt||b.date||b.createdAt)||0));let released=0;for(const x of rows){if(need<=0)break;const originalQty=Math.max(0,Number(x.qty)||0);if(!originalQty)continue;const take=Math.min(need,originalQty);if(take===originalQty){x.status='received';x.receivedAt=now;x.remainingQty=originalQty}else{const ratio=take/originalQty,oldBuy=Math.max(0,Number(x.buyTotal)||0),oldDelivery=Math.max(0,Number(x.delivery)||0),releasedRow={...x,id:id(),qty:take,remainingQty:take,buyTotal:oldBuy*ratio,delivery:oldDelivery*ratio,status:'received',receivedAt:now};x.qty=originalQty-take;x.buyTotal=oldBuy*(1-ratio);x.delivery=oldDelivery*(1-ratio);x.remainingQty=0;state.purchases.unshift(releasedRow)}p.stock=(Number(p.stock)||0)+take;released+=take;need-=take}refreshProductAverageCost(p);log('приход',p.id,released,'из склада в продажу');save();closeModal();render();alert(`В продажу добавлено ${released} шт. На складе без продажи осталось ${purchaseAtWarehouseQty(pid)} шт.`)}
'''

if 'function openProductWarehouseRelease(pid)' not in s:
    if marker not in s:
        raise SystemExit('deleteProduct marker not found')
    s = s.replace(marker, insert + marker, 1)

old = "<button class=\"btn dark full\" onclick=\"closeModal();openModal('edit','${pid}')\">Редактировать товар</button><button class=\"btn full\" onclick=\"closeModal();openModal('writeoff','${pid}')\">Списать</button>"
new = "${!isBundleProduct(p)&&purchaseAtWarehouseQty(p.id)>0?`<button class=\"btn dark full\" onclick=\"openProductWarehouseRelease('${pid}')\">Из склада в продажу · ${purchaseAtWarehouseQty(p.id)} шт.</button>`:''}<button class=\"btn dark full\" onclick=\"closeModal();openModal('edit','${pid}')\">Редактировать товар</button><button class=\"btn full\" onclick=\"closeModal();openModal('writeoff','${pid}')\">Списать</button>"

if 'Из склада в продажу · ${purchaseAtWarehouseQty(p.id)} шт.' not in s:
    if old not in s:
        raise SystemExit('openProduct buttons marker not found')
    s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
