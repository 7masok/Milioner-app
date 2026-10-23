// The owner requested the full 2025 calendar year (Almaty). Keep the usual
// rolling minimum too, and never shorten a previously requested older target.
export const REPORT_HISTORY_FROM=Date.parse('2025-01-01T00:00:00+05:00');
const DAY=86400000,OFFSET=18000000;
export const WB_REPORT_HISTORY_FROM=Date.parse('2024-01-01T00:00:00+05:00');
export function reportHistoryGoal(now,requestedFrom=REPORT_HISTORY_FROM){return Math.min(requestedFrom,Math.floor((now+OFFSET)/DAY)*DAY-OFFSET-364*DAY)}
export function historyBackfillWake(state,now,slot){
 const next=Number(state.nextAllowedAt)||0;
 // Provider cooldowns are authoritative. Only the clean daily idle delay may
 // be shortened; retain at least one ordinary slot after its last request.
 return state.lastError?next:Math.min(next,Math.max(now,next-DAY+slot));
}

// warehouse_state.payload is TEXT in the existing database; tolerate JSONB
// fixtures as well, without applying PostgreSQL JSON operators to a TEXT column.
export function reportStoreStartDate(payload,market){
 let state;try{state=typeof payload==='string'?JSON.parse(payload):payload}catch{return ''}
 const value=state?.settings?.reportStoreStarts?.[market];if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '';
 const t=Date.parse(value+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===value&&t<=Date.now()?value:'';
}
