import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectedGroupState } from '../src/wb-card-groups.js';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('WB price control sources have valid JavaScript syntax',()=>{
  for(const rel of ['../src/prices.js','../src/wb-promotions.js','../src/wb-price-protection.js','../src/wb-card-groups.js','../src/wb-stock-sync.js']){
    const path=fileURLToPath(new URL(rel,import.meta.url));
    const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
    assert.equal(result.status,0,rel+'\n'+result.stderr);
  }
  const ui=fileURLToPath(new URL('../../prices-v1.js',import.meta.url));
  const uiResult=spawnSync(process.execPath,['--check',ui],{encoding:'utf8'});
  assert.equal(uiResult.status,0,'prices-v1.js\n'+uiResult.stderr);
});

test('migration stores protection, group snapshots, history and WB stock cache',()=>{
  const sql=read('../migrations/136_wb_price_controls.sql');
  for(const token of ['wb_price_protection','wb_card_group_snapshots','wb_control_history','wb_stock_snapshots',"'protection'"])assert.match(sql,new RegExp(token));
});

test('manual and automatic price protection guard all price automation paths',()=>{
  const prices=read('../src/prices.js');
  const protection=read('../src/wb-price-protection.js');
  const promo=read('../src/wb-promotions.js');
  assert.match(prices,/protection\.priceProtected && input\?\.overrideProtection !== true/);
  assert.match(prices,/updateProtectionBaseline/);
  assert.match(prices,/source NOT IN \('manual','protection'\)/);
  assert.match(prices,/await syncWbPriceProtection\(market, now\);\s*await syncWbNightSchedules/);
  assert.match(prices,/if \(row\.priceProtected\)/);
  assert.match(promo,/promo_block=true OR manual_price_lock=true OR auto_zero_lock=true/);
  assert.match(promo,/manual_price_lock=true OR auto_zero_lock=true/);
  assert.match(protection,/pref\.autoZeroEnabled&&known&&available===0&&!autoLock/);
  assert.match(protection,/auto_zero_lock=false/);
  assert.match(protection,/source IN \('promo','schedule'\)/);
});

test('night raise cannot strand a temporary high price when protection is enabled',()=>{
  const protection=read('../src/wb-price-protection.js');
  const prices=read('../src/prices.js');
  assert.match(protection,/SELECT base_price AS "basePrice" FROM wb_price_schedules/);
  assert.match(protection,/number\(schedule\?\.basePrice\)>0\?number\(schedule\.basePrice\)/);
  assert.match(protection,/source='protection'/);
  assert.match(protection,/function protectedReturnPrice\(currentPrice,lockedPrice\)/);
  assert.match(protection,/Math\.ceil\(current\/1\.9\)/);
  assert.match(prices,/phase = Number\(schedule\.basePrice\) > 0 \? 'restoring' : 'locked'/);
});

test('auto zero uses confirmed own availability and preserves manual protection',()=>{
  const source=read('../src/wb-price-protection.js');
  assert.match(source,/available=cleanText\(row\.productId\)\?inventory\.amount\(row\.productId\):null/);
  assert.match(source,/const known=available!==null/);
  assert.match(source,/pref\.manualPriceLock\s*\? \{lockedPrice:pref\.lockedPrice,lockedDiscount:pref\.lockedDiscount\}/);
  assert.match(source,/protectedNow=pref\.manualPriceLock\|\|autoLock/);
});

test('WB card grouping is user initiated, verifies actual result and separates one-by-one',()=>{
  const groups=read('../src/wb-card-groups.js');
  assert.match(groups,/\/content\/v2\/cards\/moveNm/);
  assert.match(groups,/ids\.length>30/);
  assert.match(groups,/ensureSameSubject/);
  assert.match(groups,/await moveCards\(market,\{nmIDs:\[ids\[i\]\]\}\)/);
  assert.match(groups,/const createNewGroup=req\.body\?\.createNewGroup===true/);
  assert.match(groups,/liveState\.exactGroup/);
  assert.match(groups,/liveState\.sameGroup/);
  assert.match(groups,/await carveSelectedGroup\(market,ids,liveState\.imtId\)/);
  assert.match(groups,/await moveCards\(market,\{nmIDs:ids\}\)/);
  assert.match(groups,/targetIMT:Number\(targetImt\),nmIDs:moving/);
  assert.match(groups,/refreshed=await fetchWbCardGroupsRemote\(market\)/);
  assert.match(groups,/if\(!verified\)return res\.status\(409\)/);
  assert.match(groups,/card-groups\/recheck/);
  assert.match(groups,/retryAt:Number\(error\?\.retryAt\)\|\|0/);
  assert.match(groups,/wb_control_history/);
});

test('Prices UI isolates WB shops and exposes group and protection controls',()=>{
  const ui=read('../../prices-v1.js');
  assert.match(ui,/priceSelection\(priceUi\.market\)\.clear\(\)/);
  assert.match(ui,/priceUi\.groupFilter='all';priceUi\.groupId=''/);
  assert.match(ui,/openPriceGroupMerge/);
  assert.match(ui,/createNewGroup:true/);
  assert.match(ui,/Объединить выбранные/);
  assert.doesNotMatch(ui,/Итоговая группа/);
  assert.doesNotMatch(ui,/priceGroupTarget/);
  assert.match(ui,/submitPriceGroupDetach\(true\)/);
  assert.match(ui,/recheckPriceGroups/);
  assert.match(ui,/Повторно проверить в WB/);
  assert.match(ui,/manualPriceLock/);
  assert.match(ui,/promoBlock/);
  assert.match(ui,/autoZeroEnabled/);
  assert.match(ui,/overrideProtection=true/);
});

test('WB stock display uses the current Analytics warehouse inventory API and cache',()=>{
  const prices=read('../src/prices.js');
  assert.match(prices,/seller-analytics-api\.wildberries\.ru/);
  assert.match(prices,/\/api\/analytics\/v1\/stocks-report\/wb-warehouses/);
  assert.match(prices,/wb_stock_snapshots/);
  assert.doesNotMatch(read('../../prices-v1.js'),/stocks-report\/wb-warehouses/);
});


test('selected-only WB grouping distinguishes exact, subgroup and mixed states',()=>{
  const cards=[
    {nmId:'1',imtId:'10',subjectId:'5'},
    {nmId:'2',imtId:'10',subjectId:'5'},
    {nmId:'3',imtId:'10',subjectId:'5'},
    {nmId:'4',imtId:'20',subjectId:'5'}
  ];
  const exact=selectedGroupState(cards,['1','2','3']);
  assert.equal(exact.sameGroup,true);
  assert.equal(exact.exactGroup,true);
  assert.equal(exact.imtId,'10');

  const subgroup=selectedGroupState(cards,['1','2']);
  assert.equal(subgroup.sameGroup,true);
  assert.equal(subgroup.exactGroup,false);
  assert.equal(subgroup.members.length,3);

  const mixed=selectedGroupState(cards,['1','4']);
  assert.equal(mixed.sameGroup,false);
  assert.equal(mixed.exactGroup,false);
});
