from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')

old = "const cards=pageGroups.map(g=>{const t=purchaseShipmentTotals(g),status=g.status,label=status==='to_forwarder'?'Едет на склад':status==='to_me'?'Едет ко мне':status==='at_warehouse'?'Поступило на склад':'В продаже',badge=status==='to_me'?'purple':status==='at_warehouse'?'teal':status==='received'?'ok':''"
new = "const cards=pageGroups.map(g=>{const t=purchaseShipmentTotals(g),status=g.status,partial=g.rows.some(x=>purchaseStatus(x)==='received')&&g.rows.some(x=>purchaseStatus(x)!=='received'),label=partial?'Частично в продаже':status==='to_forwarder'?'Едет на склад':status==='to_me'?'Едет ко мне':status==='at_warehouse'?'Поступило на склад':'В продаже',badge=partial?'ok':status==='to_me'?'purple':status==='at_warehouse'?'teal':status==='received'?'ok':''"
if old not in s:
    raise SystemExit('cards header marker not found')
s = s.replace(old, new, 1)

old = "lines=g.rows.map(x=>{const qty=Number(x.qty)||0,buy=Number(x.buyTotal)||((Number(x.unitCost)||0)*qty),unitBuy=qty?buy/qty:0,withDelivery=Number(x.landedUnitCost)||(qty?(buy+(Number(x.delivery)||0))/qty:0);return `<div class=\"purchase-line\"><div class=\"grow\"><b>${esc(productNameById(x.productId,'—'))}</b><div class=\"muted\">${qty} шт. · закуп ${fmt(unitBuy)}/шт.</div></div><div class=\"right\"><div class=\"muted\">с доставкой</div><b>${fmt(withDelivery)}/шт.</b></div></div>`}).join('')"
new = "lines=g.rows.map(x=>{const qty=Number(x.qty)||0,buy=Number(x.buyTotal)||((Number(x.unitCost)||0)*qty),unitBuy=qty?buy/qty:0,withDelivery=Number(x.landedUnitCost)||(qty?(buy+(Number(x.delivery)||0))/qty:0),rs=purchaseStatus(x),released=rs==='received',rowStatus=released?'В продаже':rs==='at_warehouse'?'На складе':rs==='to_me'?'Едет ко мне':'Едет на склад',rowBadge=released?'ok':rs==='at_warehouse'?'teal':rs==='to_me'?'purple':'';return `<div class=\"purchase-line\"${released?' style=\"background:#eef9f0;border-radius:10px;padding:7px 8px;margin-left:-8px;margin-right:-8px\"':''}><div class=\"grow\"><b>${esc(productNameById(x.productId,'—'))}</b><div class=\"muted\">${qty} шт. · закуп ${fmt(unitBuy)}/шт.</div><span class=\"badge ${rowBadge}\" style=\"margin-top:5px\">${rowStatus}</span></div><div class=\"right\"><div class=\"muted\">с доставкой</div><b>${fmt(withDelivery)}/шт.</b></div></div>`}).join('')"
if old not in s:
    raise SystemExit('purchase lines marker not found')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('purchase list row statuses highlighted')
