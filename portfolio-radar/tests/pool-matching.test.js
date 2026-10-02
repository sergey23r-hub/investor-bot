import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePosition,resolvePosition,positionCandidates,venueSuggestions,applyVenue,candidateToken,comparison} from '../src/lp-data.js';
import {poolsView,matchingButtons,candidatesView} from '../src/lp-format.js';
import {Pools} from '../src/pools.js';
import {Insights} from '../src/insights.js';
import {PoolProvider} from '../src/lp-provider.js';
const now=Date.now(),iso=new Date(now).toISOString(),id='11111111-1111-4111-8111-111111111111';
const address='A'.repeat(44),otherAddress='B'.repeat(44);
const pool={key:'solana:'+address,address,asset:'MSFTx',chain:'solana',network:'Solana',platform:'Raydium',verified:true,concentrated:true,fee_tier_pct:0.25,tvl:100000,volume24h:10000,fee_apr24h:25,basis:'gross-fees/tvl',observed_at:iso,url:'https://raydium.io/',source:'https://api-v3.raydium.io/'};
const row={symbol:'MSFTx',platform:'CLMM',network:null,fee_tier_pct:0.25,capital_usd:123,shown_rate:9,rate_type:'APR',rate_scope:'personal',range_status:'out',range_lower:100,range_upper:120,captured_at:'2026-09-01T00:00:00.000Z'};

test('CLMM is a pool type; incomplete identity gets candidates without claiming ownership',()=>{
 const r=normalizePosition(row);assert.equal(r.platform,null);assert.equal(r.pool_type,'CLMM');
 assert.equal(resolvePosition(row,[pool]).pool,null);assert.equal(resolvePosition(r,[pool]).pool,null);
 assert.deepEqual(positionCandidates(row,[pool,{...pool,key:'meteora',platform:'Meteora DLMM',address:otherAddress}]),[pool]);
 assert.equal(positionCandidates(row,[{...pool,verified:false}]).length,0);
 assert.equal(positionCandidates(row,[{...pool,concentrated:false}]).length,0);
 assert.equal(comparison(row,[pool],now).delta,null);
});
test('venue confirmation uniquely binds fee tiers, preserves screenshot facts, and never picks the top APR',()=>{
 const a=normalizePosition(row),b=normalizePosition({...row,symbol:'AAPLx',capital_usd:234,fee_tier_pct:0.1});
 const pools=[pool,{...pool,key:'solana:'+otherAddress,address:otherAddress,asset:'AAPLx',fee_tier_pct:0.1}, {...pool,key:'expensive',address:'C'.repeat(44),fee_tier_pct:1,fee_apr24h:999}];
 const [g]=venueSuggestions([a,b],pools);assert.equal(g.count,2);
 const fixed=applyVenue([a,b],pools,g.key);assert.equal(fixed[0].pool_address,address);assert.equal(fixed[1].pool_address,otherAddress);
 for(const field of ['capital_usd','shown_rate','rate_type','rate_scope','range_status','range_lower','range_upper','fee_tier_pct','captured_at'])assert.equal(fixed[0][field],a[field]);
 const ambiguous=[...pools,{...pool,key:'duplicate',address:'D'.repeat(44)}];
 assert.equal(venueSuggestions([a],ambiguous).length,0);assert.equal(applyVenue([a],ambiguous,g.key)[0].pool_address,null);
 assert.equal(applyVenue([normalizePosition({...row,pool_address:address})],pools,g.key)[0].platform,null);
});
test('overview highlights historical out-of-range status and shows the whole small portfolio',()=>{
 const positions=Array.from({length:9},(_,i)=>({...row,symbol:'TEST'+i+'x'}));
 const v=poolsView({access:{tier:'paid'},profile:{positions,updated_at:iso},markets:[{data:{pools:[pool]}}],now});
 for(let i=0;i<9;i++)assert.match(v.text,new RegExp('TEST'+i+'x'));
 assert.match(v.text,/Вне диапазона на скриншоте/);assert.match(v.text,/01.09/);assert.doesNotMatch(v.text,/Условно.*за 30/);
 assert.ok(v.keyboard.flat().some(b=>b.callback_data==='lp:match:0'));assert.ok(v.text.length<4096);
});
function harness(){
 const records={pr_lp_profiles:[{user_id:42,positions:[{...row}],version:3,enabled:true,updated_at:iso}],pr_lp_imports:[],pr_lp_market:[{data:{pools:[pool]}}],pr_outbox:[],pr_lp_events:[],pr_users:[{chat_id:42,subscribed:true}]};
 let tier='paid',commits=0,fetches=0;
 const matches=(r,q)=>Object.entries(q).every(([k,v])=>['limit','order','offset','on_conflict'].includes(k)||String(v).startsWith('eq.')?['limit','order','offset','on_conflict'].includes(k)||String(r[k])===String(v).slice(3):String(v).startsWith('in.(')?String(v).slice(4,-1).split(',').includes(String(r[k])):true);
 const radar={db:{get:async(t,q={})=>(records[t]||[]).filter(r=>matches(r,q)).map(r=>structuredClone(r)),post:async(t,r)=>{const saved=structuredClone(t==='pr_lp_imports'?{id,files:[],warnings:[],created_at:iso,...r}:r);(records[t]||=[]).push(saved);return [structuredClone(saved)];},patch:async(t,b,q)=>{const rows=(records[t]||[]).filter(r=>matches(r,q));rows.forEach(r=>Object.assign(r,structuredClone(b)));return rows;},rpc:async(name,args)=>{if(name!=='pr_lp_commit')throw Error(name);commits++;const imp=records.pr_lp_imports.find(i=>i.id===args.p_import&&i.user_id===args.p_user),p=records.pr_lp_profiles[0];assert.equal(imp.base_version,p.version);p.positions=structuredClone(imp.rows);p.version++;imp.status='committed';return {}; }},billing:{access:async()=>({tier})},reply:async()=>{},currentImport:async()=>null};
 radar.pools=new Pools(radar);radar.pools.provider.collect=async()=>{fetches++;throw Error('unexpected provider fetch');};radar.insights=new Insights(radar);
 return {records,radar,get commits(){return commits;},get fetches(){return fetches;},set tier(t){tier=t;}};
}
test('saved positions recover without reupload, remain a preview until save, and paid access is rechecked at delivery',async()=>{
 const h=harness(),p=h.radar.pools;
 await p.callback({id:1},42,'match','0');const imp=h.records.pr_lp_imports[0];
 assert.equal(imp.base_version,3);assert.equal(imp.rows[0].platform,null);assert.equal(h.records.pr_lp_profiles[0].positions[0].platform,'CLMM');
 const g=venueSuggestions(imp.rows,[pool])[0];await p.callback({id:2},42,'venue',id,g.key);
 assert.equal(imp.rows[0].pool_address,address);assert.equal(h.commits,0);assert.equal(h.records.pr_lp_profiles[0].version,3);
 await p.callback({id:3},42,'choose',id,'0.0');const out=h.records.pr_outbox.at(-1);
 assert.match((await h.radar.insights.deliveryBody(out)).text,/Raydium/);
 h.tier='free';assert.doesNotMatch((await h.radar.insights.deliveryBody(out)).text,/Raydium|AAAA/);
 await p.callback({id:4},42,'save',id);assert.equal(h.commits,0);
 h.tier='paid';await p.callback({id:5},42,'save',id);assert.equal(h.commits,1);assert.equal(h.records.pr_lp_profiles[0].version,4);assert.equal(h.records.pr_lp_profiles[0].positions[0].capital_usd,123);
 await p.callback({id:6},42,'venue',id,g.key);assert.equal(imp.last_edit_key,'2');assert.equal(h.fetches,0);
});
test('candidate callbacks retain exact identity across reordering and are ownership-scoped',async()=>{
 const h=harness(),p=h.radar.pools;await p.callback({id:10},42,'match','0');
 const second={...pool,key:'solana:'+otherAddress,address:otherAddress,tvl:200000};
 h.records.pr_lp_market[0].data.pools=[pool,second];
 const imp=h.records.pr_lp_imports[0],view=candidatesView(imp,[pool,second],'0.0');
 assert.ok(view.keyboard.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
 await p.callback({id:11},99,'pick',id,'0.'+candidateToken(pool));assert.equal(imp.rows[0].pool_address,null);
 h.records.pr_lp_market[0].data.pools=[{...pool,tvl:999999},second];
 await p.callback({id:12},42,'pick',id,'0.'+candidateToken(second));assert.equal(imp.rows[0].pool_address,otherAddress);
 const long={...pool,platform:'A'.repeat(40),chain:'B'.repeat(32),network:'C'.repeat(32)};
 assert.ok(matchingButtons({id,rows:[{symbol:'MSFTx'}]},[long]).flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
});
test('automatic alerts open the relevant comparison page after overview is introduced',async()=>{
 const h=harness();await h.radar.pools.automatic(42,'alert:test','alert',h.records.pr_lp_profiles[0],2);
 assert.equal(h.records.pr_outbox[0].body._portfolius.section,'positions');assert.equal(h.records.pr_outbox[0].body._portfolius.page,2);
});
test('DEX Screener null pairs are a cached no-data result rather than a broken schema',async()=>{
 const h=harness(),stock='0x'+'a'.repeat(40),usdc='0x'+'b'.repeat(40),addr='0x'+'c'.repeat(40);
 const provider=new PoolProvider(h.radar.db,async url=>url.includes('/token-pairs/')?[]:{pairs:null});
 provider.asset=async()=>({symbol:'MSFTx',deployments:[{chain:'mantle',network:'Mantle',address:stock,wrappers:[],usdc:[usdc]}]});
 provider.inventory=async()=>({pools:[]});
 provider.evmMetadata=async()=>({metadata:[{chain:'mantle',address:addr,tokens:[stock,usdc],platform:'Fluxion',fee_pct:0.1}],coverage:[]});
 const r=await provider.collect('MSFTx');assert.deepEqual(r.pools,[]);assert.ok(r.coverage.some(c=>c.status==='not_indexed'));
 assert.ok(h.records.pr_lp_fetches.every(r=>r.state==='done'));
});
