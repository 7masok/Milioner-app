from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

def rep(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: marker count={count}')
    s = s.replace(old, new, 1)

rep(
    '<div class="order-summary"><div class="card"><div class="label">Получено</div><div class="num" id="koTotal">0</div></div><div class="card"><div class="label">Привязано</div><div class="num" id="koMatched">0</div></div><div id="koUnmatchedCard" class="card filter-card" role="button" tabindex="0" onclick="toggleUnmatchedOrderFilter()" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleUnmatchedOrderFilter()}"><div class="label">Не привязано</div><div class="num" id="koUnmatched">0</div></div></div>',
    '<div class="order-summary"><div class="card"><div class="label">Заказано, шт.</div><div class="num" id="koTotal">0 шт.</div></div><div class="card"><div class="label">Заказано на сумму</div><div class="num" id="koMatched">0 ₸</div></div><div id="koUnmatchedCard" class="card filter-card" role="button" tabindex="0" onclick="toggleUnmatchedOrderFilter()" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleUnmatchedOrderFilter()}"><div class="label">Не привязано</div><div class="num" id="koUnmatched">0</div></div></div>',
    'selected marketplace summary labels',
)

old = "const total=orders.length,unmatchedOrders=orders.filter(orderHasUnmatchedLine),unmatched=unmatchedOrders.length,matched=total-unmatched,allOrderTotals=allMarketplaceOrderTotalsForPeriod();const eTotal=document.getElementById('koTotal'),eMatched=document.getElementById('koMatched'),eUnmatched=document.getElementById('koUnmatched'),eQty=document.getElementById('koQty'),eAmount=document.getElementById('koAmount'),filterCard=document.getElementById('koUnmatchedCard');if(eTotal)eTotal.textContent=total;if(eMatched)eMatched.textContent=matched;if(eUnmatched)eUnmatched.textContent=unmatched;if(eQty)eQty.textContent=allOrderTotals.qty.toLocaleString('ru-RU')+' шт.';if(eAmount)eAmount.textContent=fmt(allOrderTotals.amount);"
new = "const total=orders.length,unmatchedOrders=orders.filter(orderHasUnmatchedLine),unmatched=unmatchedOrders.length,selectedOrderTotals=marketplaceOrderTotals(orders),allOrderTotals=allMarketplaceOrderTotalsForPeriod();const eTotal=document.getElementById('koTotal'),eMatched=document.getElementById('koMatched'),eUnmatched=document.getElementById('koUnmatched'),eQty=document.getElementById('koQty'),eAmount=document.getElementById('koAmount'),filterCard=document.getElementById('koUnmatchedCard');if(eTotal)eTotal.textContent=selectedOrderTotals.qty.toLocaleString('ru-RU')+' шт.';if(eMatched)eMatched.textContent=fmt(selectedOrderTotals.amount);if(eUnmatched)eUnmatched.textContent=unmatched;if(eQty)eQty.textContent=allOrderTotals.qty.toLocaleString('ru-RU')+' шт.';if(eAmount)eAmount.textContent=fmt(allOrderTotals.amount);"
rep(old, new, 'selected marketplace totals calculation')

p.write_text(s, encoding='utf-8')
