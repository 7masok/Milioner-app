const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/android.js','utf8');
function context(prompt){const calls=[];const c={window:null,prompt,alert:s=>calls.push(['error',s]),atob:s=>Buffer.from(s,'base64').toString('binary'),Uint8Array,TextEncoder,btoa:s=>Buffer.from(s,'binary').toString('base64'),File:class{constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}},openView:v=>calls.push(['view',v]),financeProcessStatementFile:async(f,o)=>calls.push(['preview',f,o]),financeConsumeSharedStatement:null};c.window=c;vm.createContext(c);vm.runInContext(source,c);return {c,calls};}
test('shared PDF reaches preview with unchanged filename and bytes',async()=>{const bytes=Buffer.from('%PDF-1.7\nfixture');const {c,calls}=context(()=>JSON.stringify({name:'Банк 2026.pdf',base64:bytes.toString('base64')}));assert.equal(await c.financeConsumeSharedStatement(),true);assert.equal(calls[1][0],'preview');assert.equal(calls[1][1].name,'Банк 2026.pdf');assert.deepEqual(Buffer.from(calls[1][1].parts[0]),bytes);assert.equal(calls[1][2].shared,true);});
test('empty/error shares do not reach import preview',async()=>{const empty=context(()=>null);assert.equal(await empty.c.financeConsumeSharedStatement(),false);assert.equal(empty.calls.length,0);const bad=context(()=>JSON.stringify({error:'PDF слишком большой'}));await bad.c.financeConsumeSharedStatement();assert.equal(bad.calls.length,1);assert.equal(bad.calls[0][0],'error');});
function native(failChunk=false){
  const messages=[],saved=[];let transfer=null,pending=false;
  const prompt=original=>{
    messages.push(original);
    // Reproduce the phone's truncation of a large prompt; old adapter fails here.
    const message=original.slice(0,10217);
    const colon=message.indexOf(':');const action=message.slice(13,colon);const d=JSON.parse(message.slice(colon+1));
    if(action==='begin'){
      if(pending)return 'Сначала завершите сохранение предыдущего файла';
      transfer={...d,id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chunks:[],next:0};return transfer.id;
    }
    if(action==='abort'){if(transfer?.id===d.id)transfer=null;return 'ok';}
    assert.equal(d.id,transfer.id);
    if(action==='chunk'){
      if(failChunk&&d.index===1)return 'Не удалось передать файл';
      assert.equal(d.index,transfer.next++);assert.ok(d.data.length<=4000);transfer.chunks.push(d.data);return 'ok';
    }
    assert.equal(action,'finish');const base64=transfer.chunks.join('');assert.equal(base64.length,transfer.length);
    saved.push({name:transfer.name,mime:transfer.mime,bytes:Buffer.from(base64,'base64')});transfer=null;pending=true;return 'ok';
  };
  return {prompt,messages,saved,get transfer(){return transfer;},cancel(){pending=false;}};
}
test('large Excel survives prompt truncation and saves exact binary bytes',async()=>{
  const n=native(),{c}=context(n.prompt);const bytes=Buffer.alloc(250003);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;bytes.set([80,75,3,4]);
  await c.AndroidFinances.saveExcel(bytes.toString('base64'),'statement.xlsx');
  assert.deepEqual(n.saved[0].bytes,bytes);assert.equal(n.saved[0].mime,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(n.messages.length>80);assert.ok(n.messages.every(m=>m.length<5000));
});
test('Unicode JSON backup and CSV preserve UTF-8 across multiple chunks',async()=>{
  for(const kind of ['backup','csv']){
    const n=native(),{c}=context(n.prompt);const text=kind==='backup'?JSON.stringify({format:'luxar-finance-backup',note:'Счёт 🧾 \"перевод\"'.repeat(3000)}):'\uFEFFДата;Счёт;Сумма\r\n'+'Kaspi 💰;902700\r\n'.repeat(3000);
    if(kind==='backup')await c.AndroidFinances.saveBackup(text,'finances.json');else await c.AndroidFinances.saveStatement(text,'statement.csv','text/csv');
    assert.equal(n.saved[0].bytes.toString('utf8'),text);assert.equal(n.saved[0].mime,kind==='backup'?'application/json':'text/csv');assert.ok(n.messages.every(m=>m.length<5000));
  }
});
test('interrupted transfer aborts before any save dialog; raw parser payload is hidden',async()=>{
  const n=native(true),{c}=context(n.prompt);
  await assert.rejects(c.AndroidFinances.saveExcel(Buffer.alloc(10000).toString('base64'),'statement.xlsx'),/Не удалось передать/);
  assert.equal(n.saved.length,0);assert.equal(n.transfer,null);assert.ok(n.messages.at(-1).startsWith('finance-file-abort:'));
  const bad=context(()=> 'Unterminated string '+ 'PRIVATE'.repeat(2000));
  await assert.rejects(bad.c.AndroidFinances.saveBackup('{}','finances.json'),e=>e.message.length<100&&!e.message.includes('PRIVATE'));
});
test('pending save prevents overlapping exports; cancelled dialog permits retry',async()=>{
  const n=native(),{c}=context(n.prompt);await c.AndroidFinances.saveStatement('Данные','statement.csv','text/csv');
  await assert.rejects(c.AndroidFinances.saveStatement('Данные','statement.csv','text/csv'),/предыдущего/);assert.equal(n.saved.length,1);
  n.cancel();await c.AndroidFinances.saveStatement('Повтор','statement.csv','text/csv');assert.equal(n.saved.length,2);
});
