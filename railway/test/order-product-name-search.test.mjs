import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const start=html.indexOf('function filterMarketplaceOrdersBySearch('),end=html.indexOf('\nfunction ',start+10);
function fixture(){const ctx={Map,Set,String,Array,state:{products:[{id:'p',name:'Скелет золотой',kaspi:'123',kaspiAliases:['old']},{id:'other',name:'Ангел',wb:'123'},{id:'inferno:child',name:'Череп',wb3:'123'},{id:'group',name:'Кольцо дракон'},{id:'size',name:'Размер 18',variantGroupId:'group',ozon:'456'}]},orderSearchText:'',normalizeName:s=>String(s||'').toLowerCase().replace(/ё/g,'е').trim()};ctx.prod=id=>ctx.state.products.find(p=>p.id===id);vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);return ctx;}
test('search resolves warehouse names from exact store SKU and aliases before productId arrives',()=>{
 const c=fixture(),orders=[{market:'Kaspi',lines:[{sku:'123',productName:'Брелок'}]},{market:'WB',lines:[{sku:'123',productName:'Брелок'}]},{market:'Kaspi',lines:[{sku:'old'}]}];c.orderSearchText='скелет';assert.deepEqual(Array.from(c.filterMarketplaceOrdersBySearch(orders)),[orders[0],orders[2]]);c.orderSearchText='череп';assert.equal(c.filterMarketplaceOrdersBySearch(orders).length,0);
});
test('search supports warehouse names, size group names, original titles and words in any order',()=>{
 const c=fixture(),orders=[{market:'Kaspi',code:'001-abc',lines:[{productId:'p',orderedProductName:'Брелок костяк',sku:'new'}]},{market:'Ozon',lines:[{sku:'456'}]}];
 for(const q of ['золотой скелет','костяк','001-abc','new']){c.orderSearchText=q;assert.equal(c.filterMarketplaceOrdersBySearch(orders)[0],orders[0]);}
 c.orderSearchText='дракон 18';assert.equal(c.filterMarketplaceOrdersBySearch(orders)[0],orders[1]);assert.equal(c.state.products[0].kaspi,'123');assert.equal(orders[1].lines[0].productId,undefined);
});
