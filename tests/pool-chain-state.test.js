import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRangeStates,decodePoolState,decodeMint} from '../src/lp-chain-state.js';
import {PoolProvider} from '../src/lp-provider.js';
import {Pools} from '../src/pools.js';
const RAY='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',ORCA='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
// Public keys with known literal base58 encodings; independent binary fixtures.
const a='11111111111111111111111111111112',b='11111111111111111111111111111113',config='11111111111111111111111111111114';
const acct=(buf,owner)=>({owner,executable:false,data:[buf.toString('base64'),'base64']});
function ray(){const x=Buffer.alloc(1544);Buffer.from([247,237,227,245,215,195,222,70]).copy(x);x[40]=3;x[104]=1;x[136]=2;x[233]=6;x[234]=9;x.writeUInt16LE(8,235);x.writeBigUInt64LE(1000000000n,237);x.writeBigUInt64LE(1n,261);return acct(x,RAY);}
function orca(){const x=Buffer.alloc(653);Buffer.from([63,149,209,12,225,128,99,9]).copy(x);x.writeUInt16LE(64,41);x.writeUInt16LE(1600,47);x.writeBigUInt64LE(2000000000n,49);x.writeBigUInt64LE(1n,73);x[132]=1;x[212]=2;return acct(x,ORCA);}
function mint(d=6,owner=TOKEN,extension=null){const x=Buffer.alloc(extension===null?82:202);x[44]=d;x[45]=1;if(extension!==null){x[165]=1;x.writeUInt16LE(extension,166);x.writeUInt16LE(32,168);}return acct(x,owner);}
function cfg(){const x=Buffer.alloc(117);Buffer.from([218,244,33,104,203,203,43,111]).copy(x);x.writeUInt32LE(120000,43);x.writeUInt16LE(8,51);x.writeUInt32LE(40000,53);return acct(x,RAY);}
const pool=(platform,address)=>({key:'solana:'+address,chain:'solana',platform,address,verified:true,concentrated:true,stock_address:a,usdc_address:b});
const rp=pool('Raydium','11111111111111111111111111111115'),op=pool('Orca','11111111111111111111111111111116');
test('chain parser reads verified Raydium and Orca liquidity, mints and tick spacing',()=>{
 const r=decodePoolState(rp,ray()),o=decodePoolState(op,orca());
 assert.equal(r.config,config);assert.equal(r.token_a,a);assert.equal(r.token_b,b);assert.equal(r.liquidity,'1000000000');assert.equal(r.sqrt_price_x64,'18446744073709551616');assert.equal(r.tick_spacing,8);assert.equal(r.decimals_b,9);
 assert.equal(o.tick_spacing,64);assert.equal(o.liquidity,'2000000000');assert.equal(o.lp_fee_share,.84);
 assert.throws(()=>decodePoolState(rp,{...ray(),owner:ORCA}));assert.throws(()=>decodePoolState({...rp,stock_address:'fake'},ray()));
 const corrupt=Buffer.from(ray().data[0],'base64');corrupt[0]=0;assert.throws(()=>decodePoolState(rp,acct(corrupt,RAY)));
 assert.throws(()=>decodePoolState(rp,acct(Buffer.alloc(20),RAY)));
 for(const flag of [1,2,4,16]){const paused=Buffer.from(ray().data[0],'base64');paused[389]=flag;assert.throws(()=>decodePoolState(rp,acct(paused,RAY)),/paused/);}
});
test('mint validation allows metadata and rejects transfer fees, unknown extensions and non-mints',()=>{
 assert.equal(decodeMint(mint(9)).decimals,9);assert.equal(decodeMint(mint(6,TOKEN22,12)).decimals,6);
 for(const extension of [1,10,14,25,26,999])assert.throws(()=>decodeMint(mint(6,TOKEN22,extension)));
 assert.throws(()=>decodeMint({...mint(),owner:RAY}));const bad=Buffer.from(mint().data[0],'base64');bad[45]=0;assert.throws(()=>decodeMint(acct(bad,TOKEN)));
});
test('collector batches public accounts, verifies configs and records a coherent fresh slot',async()=>{
 const accounts=new Map([[rp.address,ray()],[op.address,orca()],[a,mint(6)],[b,mint(9)],[config,cfg()]]),calls=[];
 const get=async(url,options)=>{calls.push(options.body);assert.equal(url,'https://api.mainnet-beta.solana.com');return {result:{context:{slot:100+calls.length},value:options.body.params[0].map(k=>accounts.get(k)||null)}};};
 const result=await collectRangeStates([rp,op],get);
 assert.equal(calls.length,2);assert.equal(calls[0].method,'getMultipleAccounts');assert.equal(calls[1].params[1].minContextSlot,101);
 assert.equal(result.states[rp.key].status,'ok');assert.equal(result.states[rp.key].lp_fee_share,.84);assert.equal(result.states[rp.key].slot,102);
 assert.equal(result.states[op.key].decimals_b,9);assert.equal(result.states[rp.key].observed_at,result.states[op.key].observed_at);
 accounts.set(config,{...cfg(),owner:ORCA});const bad=await collectRangeStates([rp,op],get);
 assert.equal(bad.states[rp.key].status,'unavailable');assert.equal(bad.states[op.key].status,'ok');
});
test('RPC errors cannot fabricate liquidity or keep a cached success fresh',async()=>{
 await assert.rejects(collectRangeStates([rp],async()=>({error:{code:429}})),/lp_source_rpc/);
 const result=await collectRangeStates([rp],async()=>({result:{context:{slot:5},value:[null]}}));
 assert.equal(result.states[rp.key].status,'unavailable');assert.equal(result.states[rp.key].liquidity,undefined);
});
test('range snapshots and RPC failures are shared per asset and hour across users',async()=>{
 const rows=[],db={post:async(t,r)=>{if(rows.some(x=>x.cache_key===r.cache_key&&x.bucket===r.bucket))return [];rows.push({...r});return [r];},get:async(t,q)=>rows.filter(r=>r.cache_key===q.cache_key.slice(3)&&r.bucket===q.bucket.slice(3)),patch:async(t,b,q)=>Object.assign(rows.find(r=>r.cache_key===q.cache_key.slice(3)&&r.bucket===q.bucket.slice(3)),b)};
 let calls=0;const p=new PoolProvider(db,async()=>{calls++;throw Error('lp_source_http_429');});
 const first=await p.rangeStates('TESTx',[rp,op]),second=await p.rangeStates('TESTx',[rp,op]);
 assert.equal(calls,1);assert.equal(first.error,'lp_source_http_429');assert.equal(second.error,'source_unavailable');
});
test('scheduled rollout enriches one existing snapshot without refreshing its fees or quotes',async()=>{
 const iso=new Date().toISOString(),names=['MSFTx','TSLAx','NVDAx','SPYx','QQQx','COINx','AAPLx'];
 const markets=names.map(symbol=>({symbol,updated_at:iso,data:{symbol,checked_at:iso,schema_version:symbol==='MSFTx'?1:2,pools:[{...rp,observed_at:iso}],coverage:[]}}));
 const writes=[],radar={db:{rpc:async(name)=>name==='pr_lp_lock'?true:[],get:async()=>markets,post:async(t,row)=>writes.push(row)}};
 const p=new Pools(radar);let reads=0;p.provider.collect=async()=>{throw Error('no market refresh required');};p.provider.rangeStates=async(symbol,rows)=>{reads++;assert.equal(symbol,'MSFTx');return {states:{[rp.key]:{status:'ok'}}};};
 await p.work();assert.equal(reads,1);assert.equal(writes.length,1);assert.equal(writes[0].updated_at,iso);assert.equal(writes[0].data.checked_at,iso);assert.equal(writes[0].data.pools[0].observed_at,iso);assert.equal(writes[0].data.schema_version,2);
 assert.equal(writes[0].data.pools[0].clmm_state.status,'ok');
});
