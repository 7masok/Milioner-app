import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
process.env.APP_ADMIN_TOKEN='planner-test-code-fixture-only';
const {plannerRouter}=await import('../src/ozon-planner/router.js');
const {pool}=await import('../src/db.js');
const {createSessionToken}=await import('../src/auth.js');
const {emptyConfiguration,configurationHash}=await import('../src/ozon-planner/model.js');
const origin='https://7masok.github.io';
function vault(value){const key=crypto.createHash('sha256').update('millioner-marketplace-vault:'+process.env.APP_ADMIN_TOKEN).digest(),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(p=>p.toString('base64url')).join('.');}
test('actual planner routes: pair requires owner auth; read is cached, config safe; revocation and origin enforced',async()=>{
 let device=null,source={account:'Ozon',client_id:'100',updated_at:Date.now(),attempt_at:Date.now()-1,last_error:'',payload:{asOf:'2026-10-17',updatedAt:new Date().toISOString(),rows:[{sku:'123',name:'Товар',cluster:'Уфа',clusterId:'42',stock:10,daily:1}],supplies:[],stockRequestedSkus:['123'],missingOrderIds:[]}},queries=[];
 const original=pool.query;pool.query=async(sql,params=[])=>{
  queries.push(sql);if(sql.includes("WHERE provider='OZON'"))return {rows:[{id:'Ozon',label:'Первый магазин'}]};
  if(sql.startsWith('SELECT encrypted_token'))return {rows:[{encrypted_token:vault({clientId:'100',apiKey:'fixture-only-not-real'})}]};
  if(sql.startsWith('INSERT INTO ozon_planner_devices')){device={id:params[0],token_hash:params[1],account:params[2],client_id:params[3],configuration:JSON.parse(params[4]),config_hash:params[5],prepared:null,source_updated_at:0,revision:0,revoked:false};return {rows:[],rowCount:1};}
  if(sql.startsWith('SELECT * FROM ozon_planner_devices'))return {rows:device&&!device.revoked&&device.token_hash===params[0]?[structuredClone(device)]:[]};
  if(sql.startsWith('SELECT * FROM ozon_planner_sources'))return {rows:source?[structuredClone(source)]:[]};
  if(sql.startsWith('UPDATE ozon_planner_devices SET configuration')){device.configuration=JSON.parse(params[1]);device.config_hash=params[2];return {rows:[structuredClone(device)]};}
  if(sql.startsWith('UPDATE ozon_planner_devices SET prepared')){if(params[4]!==device.config_hash)return {rows:[]};device.prepared=JSON.parse(params[1]);device.source_updated_at=params[2];device.calculated_day=params[3];device.revision++;return {rows:[structuredClone(device)]};}
  if(sql.startsWith('UPDATE ozon_planner_devices SET last_used_at'))return {rows:[],rowCount:1};
  if(sql.startsWith('UPDATE ozon_planner_devices SET revoked')){device.revoked=true;return {rows:[],rowCount:1};}
  throw Error('Unexpected query '+sql);
 };
 const app=express();app.use(express.json());app.use('/api/ozon-planner',plannerRouter);app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/ozon-planner';
 const request=(path,{token='',body,origin:requestOrigin=origin,method='POST'}={})=>fetch(base+path,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await request('/pair',{body:{}})).status,401);
  const owner=createSessionToken().token;
  assert.equal((await request('/pair',{token:owner,body:{clientId:'999'}})).status,400);
  const paired=await request('/pair',{token:owner,body:{clientId:'100',configuration:emptyConfiguration()}});assert.equal(paired.status,200);const data=await paired.json(),token=data.token;assert.equal(token.length,43);assert.notEqual(device.token_hash,token);
  const config=emptyConfiguration();config.routes=[{cluster:'Уфа',travel:5,prepare:0,accept:0}];config.productNames={'123':'Своё имя'};
  assert.equal(configurationHash(config),configurationHash({...Object.fromEntries(Object.entries(config).reverse()),settings:Object.fromEntries(Object.entries(config.settings).reverse())}),'JSONB top-level order does not change hash');
  let response=await request('/read',{token,body:{configuration:config,plans:[{qty:999}],rows:[{stock:999}]}});assert.equal(response.status,200);let result=await response.json();assert.equal(result.state.items[0].stock,10);assert.equal(result.plans[0].qty,28);assert.equal(result.state.productNames['123'],'Своё имя');
  const revision=result.revision;response=await request('/read',{token,body:{configuration:config}});result=await response.json();assert.equal(result.revision,revision,'ready result reused without recalculation');
  assert.equal((await request('/read',{token,origin:'https://untrusted.invalid',body:{}})).status,403);
  assert.equal((await request('/read',{token:owner,body:{}})).status,401,'warehouse session is not a planner device token');
  source=null;assert.equal((await request('/read',{token,body:{}})).status,202);
  assert.equal((await request('/device',{token,method:'DELETE'})).status,200);assert.equal((await request('/read',{token,body:{}})).status,401);
  assert.ok(queries.every(sql=>!/^UPDATE (warehouse|products|sales|purchases)/i.test(sql)),'no warehouse stock writes');
 }finally{await new Promise(r=>server.close(r));pool.query=original;await pool.end();}
});
