import crypto from 'node:crypto';
export const STATUS_ENDPOINT='/adv/v1/promotion/count';
// Conservative limits for the seller's base token, per method. Never sleep
// while holding a command queue; a persisted lease schedules the next attempt.
const intervals=new Map([['/api/advert/v2/adverts',3601000],[STATUS_ENDPOINT,901000],['/adv/v0/start',721000],['/adv/v0/pause',721000]]);
export const adTokenHash=token=>crypto.createHash('sha256').update(String(token)).digest('hex');
const path=url=>new URL(url).pathname;
export function adApiLimited(endpoint,retryAt){return Object.assign(Error('WB ограничил частоту запросов. Ожидаем разрешённого времени.'),{status:429,endpoint,retryAt});}
export async function reserveAdApiRequest(db,url,token,now=Date.now()){
 const endpoint=path(url),interval=intervals.get(endpoint);if(!interval)return;
 const key=adTokenHash(token),r=await db.query(`INSERT INTO wb_ad_api_windows(token_hash,endpoint,next_allowed_at) VALUES($1,$2,$3) ON CONFLICT(token_hash,endpoint) DO UPDATE SET next_allowed_at=$3 WHERE wb_ad_api_windows.next_allowed_at <= $4 RETURNING next_allowed_at`,[key,endpoint,now+interval,now]);
 if(!r.rows.length){const current=(await db.query('SELECT next_allowed_at FROM wb_ad_api_windows WHERE token_hash=$1 AND endpoint=$2',[key,endpoint])).rows[0];throw adApiLimited(endpoint,Number(current?.next_allowed_at)||now+interval);}
}
export async function saveAdApiRetry(db,url,token,retryAt){
 const endpoint=path(url);if(!intervals.has(endpoint))return;
 await db.query(`INSERT INTO wb_ad_api_windows(token_hash,endpoint,next_allowed_at) VALUES($1,$2,$3) ON CONFLICT(token_hash,endpoint) DO UPDATE SET next_allowed_at=GREATEST(wb_ad_api_windows.next_allowed_at,$3)`,[adTokenHash(token),endpoint,retryAt]);
}
export async function readAdStatusCache(db,token){return(await db.query('SELECT observed_at,next_allowed_at,payload FROM wb_ad_api_windows WHERE token_hash=$1 AND endpoint=$2',[adTokenHash(token),STATUS_ENDPOINT])).rows[0]||null;}
export async function saveAdStatusCache(db,token,rows,now=Date.now()){
 await db.query('UPDATE wb_ad_api_windows SET payload=$3,observed_at=$4 WHERE token_hash=$1 AND endpoint=$2',[adTokenHash(token),STATUS_ENDPOINT,JSON.stringify(rows),now]);
}
