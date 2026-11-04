import {credentialFor} from './connections.js';
const snapshots=new Map();
export async function readWb3Supplies({fetchImpl=fetch,tokenFor=credentialFor,now=Date.now()}={}){
 const old=snapshots.get('WB');
 if(old&&now<old.nextAt)return old;
 const token=await tokenFor('WB');
 if(!token)return {ok:false,error:'Магазин WB3 не подключён',supplies:[]};
 const response=await fetchImpl('https://supplies-api.wildberries.ru/api/v1/supplies?limit=1000&offset=0',{
  method:'POST',headers:{Authorization:token,'Content-Type':'application/json',Accept:'application/json'},
  body:JSON.stringify({dates:[],statusIDs:[]}),signal:AbortSignal.timeout(30000)
 });
 const retry=Number(response.headers.get('x-ratelimit-retry')||response.headers.get('retry-after'))||1800;
 if(!response.ok){
  const error=response.status===403?'Ключ WB3 не имеет доступа к категории «Поставки»':response.status===401?'WB отклонил ключ WB3':response.status===429?'Лимит запросов поставок WB':'Поставки WB: HTTP '+response.status;
  const result={ok:false,error,status:response.status,supplies:old?.supplies||[],fetchedAt:old?.fetchedAt||0,nextAt:now+Math.max(60,retry)*1000};
  snapshots.set('WB',result);return result;
 }
 const supplies=await response.json();
 if(!Array.isArray(supplies))throw Error('WB вернул некорректный список поставок');
 const result={ok:true,supplies,fetchedAt:now,nextAt:now+30*60000};
 snapshots.set('WB',result);return result;
}
