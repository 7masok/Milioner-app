const KEY='luxar_finance_v1';
const MILLIONER_API=location.origin;
const APP_SESSION_KEY=KEY+'_owner_session';
const nativeFetch=window.fetch.bind(window);
let ownerSessionToken=localStorage.getItem(APP_SESSION_KEY)||'';
let state={settings:{}};
let financeAppStarted=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const fmt=n=>new Intl.NumberFormat('ru-RU').format(Math.round(n||0))+' ₸';
function saveLocalOnly(){} // Finance snapshots/outbox are persisted atomically in IndexedDB.
function render(){renderFinanceIfActive()}
function showSheet(html){document.getElementById('sheet').innerHTML='<button class="sheet-close" aria-label="Закрыть" onclick="closeModal()">×</button>'+html;document.getElementById('modal').classList.add('open')}
function closeModal(){document.getElementById('modal').classList.remove('open')}
function openView(view){const settings=view==='settings';document.getElementById('finance').classList.toggle('active',!settings);document.getElementById('settings').classList.toggle('active',settings);document.querySelectorAll('[data-app-view]').forEach(b=>b.classList.toggle('active',b.dataset.appView===view));localStorage.setItem(KEY+'_view',view);if(!settings)renderFinanceIfActive()}
function loginState(mode,error=''){document.body.className='auth-'+mode;document.getElementById('ownerLoginError').textContent=error}
window.fetch=async function(input,options={}){
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  const headers=new Headers(options.headers||{});
  if(url.origin===location.origin&&url.pathname.startsWith('/api/')&&ownerSessionToken)headers.set('Authorization','Bearer '+ownerSessionToken);
  const response=await nativeFetch(input,{...options,headers});
  if(response.status===401&&url.pathname.startsWith('/api/')){ownerSessionToken='';localStorage.removeItem(APP_SESSION_KEY);loginState('locked','Сеанс закончился. Войдите снова.')}
  return response;
};
async function ownerAuthSubmit(event){
  event.preventDefault();const button=document.getElementById('ownerLoginButton');button.disabled=true;
  try{const response=await nativeFetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('ownerPassword').value})});const data=await response.json();if(!response.ok)throw Error(data.error==='wrong-password'?'Неверный код доступа':data.error||'Ошибка входа');ownerSessionToken=data.token;localStorage.setItem(APP_SESSION_KEY,ownerSessionToken);document.getElementById('ownerPassword').value='';await startFinanceApp()}
  catch(error){loginState('locked',String(error.message||error))}finally{button.disabled=false}
}
function ownerLogout(){ownerSessionToken='';localStorage.removeItem(APP_SESSION_KEY);loginState('locked')}
async function startFinanceApp(){
  loginState('ready');
  if(financeAppStarted){await financeRefresh();return}
  financeAppStarted=true;openView(localStorage.getItem(KEY+'_view')==='settings'?'settings':'finance');
  try{const cached=await financeCacheRead();if(cached&&financeSnapshotHasData(cached)){applyFinanceSnapshot(cached);financeHydrated=true;renderFinanceIfActive()}
    const loaded=await bootstrapFinanceFromServer(cached||financeStateSnapshot());if(!loaded&&!financeSnapshotHasData(financeStateSnapshot()))throw Error('Не удалось загрузить финансовую базу. Нажми ↻ для повторной загрузки.');financeHydrated=true;renderFinanceIfActive();await financeConsumeSharedStatement();startFinanceServerWatcher();
  }catch(error){financeAppStarted=false;financeHydrated=financeSnapshotHasData(financeStateSnapshot());renderFinanceIfActive();financeSyncStatus('ошибка загрузки','bad');document.getElementById('appError').textContent=String(error.message||error)}
}
async function initFinanceAuth(){
  try{if(ownerSessionToken){const response=await fetch('/api/auth/session',{cache:'no-store'});if(response.ok)return startFinanceApp()}
    const response=await nativeFetch('/api/auth/config',{cache:'no-store'});if(!response.ok)throw Error('Сервер недоступен');const data=await response.json();if(!data.enabled)throw Error('Код доступа не настроен на сервере');loginState('locked');
  }catch(error){loginState('locked',String(error.message||error))}
}
async function financeExportSnapshot(){
  const button=document.getElementById('financeExportButton');button.disabled=true;
  try{await financeSyncOutbox();const pending=await financeOutboxRead();if(!financeStorageHealthy)throw Error('Не удалось проверить локальную очередь');if(pending.length)throw Error('Есть несинхронизированные операции. Дождитесь сохранения перед выгрузкой.');
    const data=await financeLedgerRequest('/api/finance-state');
    const backup={format:'luxar-finance-backup',version:1,createdAt:new Date().toISOString(),source:{app:'Milioner-app',revision:data.revision,updatedAt:data.updatedAt},...normalizeFinanceSnapshot(data)};
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='finances-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    document.getElementById('exportStatus').textContent='Выгружено: '+backup.accounts.length+' счетов, '+backup.categories.length+' категорий, '+backup.transactions.length+' операций.';
  }catch(error){document.getElementById('exportStatus').textContent=String(error.message||error)}finally{button.disabled=false}
}
let installPrompt=null;
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;document.getElementById('installButton').hidden=false});
async function installFinanceApp(){if(!installPrompt)return;await installPrompt.prompt();installPrompt=null;document.getElementById('installButton').hidden=true}
window.addEventListener('online',()=>{if(ownerSessionToken)financeRefresh()});
