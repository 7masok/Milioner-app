import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('report process is isolated, bounded, restarted and stopped with the parent',()=>{
 const source=readFileSync(new URL('../src/business-report-process.js',import.meta.url),'utf8')
  .replace("import {fork} from 'node:child_process';",'')
  .replace('export function','function').replace('import.meta.url',"'file:///app/railway/src/business-report-process.js'");
 const parent={},children=[],timers=[];
 const context={URL,console,process:{env:{EXAMPLE:'kept'},once:(event,fn)=>parent[event]=fn},
  fork:(url,args,options)=>{const events={},child={options,once:(event,fn)=>events[event]=fn,kill:signal=>child.signal=signal,events};children.push(child);return child},
  setTimeout:fn=>{const timer={fn,unref(){}};timers.push(timer);return timer},clearTimeout(){}};
 vm.createContext(context);vm.runInContext(source,context);
 context.startBusinessReportProcess();context.startBusinessReportProcess();
 assert.equal(children.length,1);
 assert.equal(children[0].options.env.PGPOOL_MAX,'2');
 assert.equal(children[0].options.env.EXAMPLE,'kept');
 children[0].events.exit(1,null);
 assert.equal(timers.length,1);timers[0].fn();
 assert.equal(children.length,2);
 parent.SIGTERM();
 assert.equal(children[1].signal,'SIGTERM');
 children[1].events.exit(0,'SIGTERM');
 assert.equal(timers.length,1);
});
