from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old = "function marketplaceOrderTotals(orders){let qty=0,amount=0;for(const g of(orders||[])){const stage=marketplaceLifecycleStage(String(g?.market||selectedOrderMarket),g?.status,g?.state);if(stage==='cancelled')continue;for(const o of(g.lines||[])){if(isPendingMarketplaceLine(o))continue;const q=Math.max(0,Number(o.qty)||0),lineTotal=Math.max(0,Number(o.totalPrice)||0),unit=Math.max(0,Number(o.unitPrice)||0);qty+=q;amount+=lineTotal>0?lineTotal:q*unit}}return {qty,amount}}\nfunction renderMarketplaceOrders()"
new = "function marketplaceOrderTotals(orders){let qty=0,amount=0;for(const g of(orders||[])){const stage=marketplaceLifecycleStage(String(g?.market||selectedOrderMarket),g?.status,g?.state);if(stage==='cancelled')continue;for(const o of(g.lines||[])){if(isPendingMarketplaceLine(o))continue;const q=Math.max(0,Number(o.qty)||0),lineTotal=Math.max(0,Number(o.totalPrice)||0),unit=Math.max(0,Number(o.unitPrice)||0);qty+=q;amount+=lineTotal>0?lineTotal:q*unit}}return {qty,amount}}\nfunction allMarketplaceOrderTotalsForPeriod(){const combined=[...(state.kaspiOrderFeed||[]).map(o=>({...o,market:o.market||'Kaspi'})),...(state.wbOrderFeed||[]).map(o=>({...o,market:o.market||'WB'})),...(state.ozonOrderFeed||[]).map(o=>({...o,market:o.market||'Ozon'}))],orders=filterMarketplaceOrdersByPeriod(groupMarketplaceOrders(combined));return marketplaceOrderTotals(orders)}\nfunction renderMarketplaceOrders()"
if s.count(old) != 1:
    raise SystemExit(f'helper marker count={s.count(old)}')
s = s.replace(old, new, 1)

old2 = "const total=orders.length,unmatchedOrders=orders.filter(orderHasUnmatchedLine),unmatched=unmatchedOrders.length,matched=total-unmatched,orderTotals=marketplaceOrderTotals(orders);const eTotal=document.getElementById('koTotal'),eMatched=document.getElementById('koMatched'),eUnmatched=document.getElementById('koUnmatched'),eQty=document.getElementById('koQty'),eAmount=document.getElementById('koAmount'),filterCard=document.getElementById('koUnmatchedCard');if(eTotal)eTotal.textContent=total;if(eMatched)eMatched.textContent=matched;if(eUnmatched)eUnmatched.textContent=unmatched;if(eQty)eQty.textContent=orderTotals.qty.toLocaleString('ru-RU')+' шт.';if(eAmount)eAmount.textContent=fmt(orderTotals.amount);"
new2 = "const total=orders.length,unmatchedOrders=orders.filter(orderHasUnmatchedLine),unmatched=unmatchedOrders.length,matched=total-unmatched,allOrderTotals=allMarketplaceOrderTotalsForPeriod();const eTotal=document.getElementById('koTotal'),eMatched=document.getElementById('koMatched'),eUnmatched=document.getElementById('koUnmatched'),eQty=document.getElementById('koQty'),eAmount=document.getElementById('koAmount'),filterCard=document.getElementById('koUnmatchedCard');if(eTotal)eTotal.textContent=total;if(eMatched)eMatched.textContent=matched;if(eUnmatched)eUnmatched.textContent=unmatched;if(eQty)eQty.textContent=allOrderTotals.qty.toLocaleString('ru-RU')+' шт.';if(eAmount)eAmount.textContent=fmt(allOrderTotals.amount);"
if s.count(old2) != 1:
    raise SystemExit(f'render marker count={s.count(old2)}')
s = s.replace(old2, new2, 1)

p.write_text(s, encoding='utf-8')
