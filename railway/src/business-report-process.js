import {fork} from 'node:child_process';

let child=null,retry=null,stopping=false,installed=false;
export function startBusinessReportProcess(){
 if(child||retry||stopping)return;
 if(!installed){
  installed=true;
  const stop=()=>{
   stopping=true;
   clearTimeout(retry);
   child?.kill('SIGTERM');
  };
  process.once('SIGTERM',stop);
  process.once('SIGINT',stop);
  process.once('exit',stop);
 }
 child=fork(new URL('./business-report-process-entry.js',import.meta.url),[],{
  stdio:['ignore','inherit','inherit','ipc'],
  env:{...process.env,PGPOOL_MAX:'2'}
 });
 child.once('error',error=>console.error('BUSINESS_REPORT_PROCESS_ERROR',error.message));
 child.once('exit',(code,signal)=>{
  child=null;
  if(stopping)return;
  console.warn('BUSINESS_REPORT_PROCESS_RESTART',JSON.stringify({code,signal}));
  retry=setTimeout(()=>{retry=null;startBusinessReportProcess()},30000);
  retry.unref();
 });
}
