import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const root=new URL('../../',import.meta.url);
const runtime=await fs.readFile(new URL('finances/runtime.js',root),'utf8');
const html=await fs.readFile(new URL('finances/index.html',root),'utf8');
const core=await fs.readFile(new URL('finances/core.js',root),'utf8');

function exportHarness(pending=[]){
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,{disabled:false,textContent:''});return elements.get(id)};
  let blob,clicks=0;
  const context={location:{origin:'https://finance.example',href:'https://finance.example/finances/'},localStorage:{getItem(){return null}},window:{fetch:async()=>({status:200}),addEventListener(){}},document:{getElementById:element,createElement:()=>({click(){clicks++}})},Headers,Intl,Blob,JSON,Error,String,Date,URL:{createObjectURL(value){blob=value;return 'blob:fixture'},revokeObjectURL(){}},setTimeout(){},console};
  context.financeSyncOutbox=async()=>{};context.financeOutboxRead=async()=>pending;context.financeStorageHealthy=true;
  context.normalizeFinanceSnapshot=value=>({accounts:value.accounts,categories:value.categories,transactions:value.transactions,imports:value.imports});
  const snapshot={revision:17,updatedAt:2000,accounts:[{id:'acc',balance:500,currency:'KZT'}],categories:[{id:'cat',name:'Расходы'}],transactions:[{id:'bank-op',amount:25,title:'Длинный платёж '.repeat(80),statementFingerprint:'fingerprint',bankOperationKey:'bank-key',statementLinks:[{statementAccountId:'other',bankOperationKey:'other-key'}]}],imports:{old:{importedAt:1}}};
  context.financeLedgerRequest=async()=>snapshot;
  vm.createContext(context);vm.runInContext(runtime,context);
  return {context,elements,snapshot,getBlob:()=>blob,getClicks:()=>clicks};
}

test('finance export preserves balances, long titles, bank identities and import history',async()=>{
  const h=exportHarness();await h.context.financeExportSnapshot();const out=JSON.parse(await h.getBlob().text());
  assert.equal(h.getClicks(),1);assert.equal(out.format,'luxar-finance-backup');assert.equal(out.source.revision,17);
  for(const key of ['accounts','categories','transactions','imports'])assert.deepEqual(out[key],h.snapshot[key]);
  assert.equal(h.elements.get('financeExportButton').disabled,false);
});

test('finance export refuses a stale server snapshot while local commands are pending',async()=>{
  const h=exportHarness([{id:'pending-command'}]);await h.context.financeExportSnapshot();
  assert.equal(h.getClicks(),0);assert.equal(h.getBlob(),undefined);
  assert.match(h.elements.get('exportStatus').textContent,/несинхронизированные/);
  assert.equal(h.elements.get('financeExportButton').disabled,false);
});

test('independent finance entry loads only finance scripts and has its own PWA/cache namespace',async()=>{
  assert.doesNotMatch(html,/cloud-sync-v3|warehouse-insights|wb-variants|kaspi-ads|ozon-fbo/);
  assert.doesNotMatch(runtime,/bootstrapWarehouse|loadSharedOrderCache|startWarehouseServerWatcher/);
  assert.match(core,/luxar-finance-cache-v1/);assert.match(core,/Транзит · ушло/);
  const manifest=JSON.parse(await fs.readFile(new URL('finances/manifest.webmanifest',root),'utf8'));
  assert.equal(manifest.scope,'/finances/');assert.equal(manifest.start_url,'/finances/');assert.equal(manifest.share_target.action,'/finances/share/finance-statement');
  new vm.Script(runtime);new vm.Script(core);
});
