import test from 'node:test';
import assert from 'node:assert/strict';
import {compactAsset,identify,annual,raydiumPool,orcaPool,meteoraPool,dexPool,staticFeePool,llamaPool,ranked,comparison,resolvePosition,normalizePosition,correctPosition,HOUR} from '../src/lp-data.js';
import {PoolProvider,publicJson} from '../src/lp-provider.js';
import {lpPaid,poolsView,teaser,previewText} from '../src/lp-format.js';
import {Pools} from '../src/pools.js';
import {Radar,createHandler} from '../src/app.js';
const now=Date.now(),iso=new Date(now).toISOString();
const sol='StockTokenCASE123456789abcdefghijkL',usdc='USDCtokenCASE123456789abcdefghijkL',evm='0x'+'a'.repeat(40),wrap='0x'+'b'.repeat(40),usd='0x'+'c'.repeat(40);
const asset=compactAsset({symbol:'MSFTx',name:'Microsoft xStock',underlyingSymbol:'MSFT',deployments:[{network:'Solana',address:sol,stablecoins:[{symbol:'USDC',network:'Solana',address:usdc}]},{network:'Ethereum',address:evm,wrapperAddressV2:wrap,stablecoins:[{symbol:'USDC',network:'Ethereum',address:usd}]}]});
const base={key:'solana:pool1',address:'pool1',asset:'MSFTx',underlying:'MSFT',chain:'solana',network:'Solana',platform:'Raydium',verified:true,tvl:100000,volume24h:100000,fee_apr24h:10,fee_apr7d:9,reward_apr24h:0,basis:'gross-fees/tvl',observed_at:iso,provider_at:null,url:'https://raydium.io/',source:'https://api-v3.raydium.io/'};
const other={...base,key:'solana:pool2',address:'pool2',platform:'Orca',fee_apr24h:20};

test('official xStocks identity requires both verified contracts and the correct chain',()=>{
 assert.ok(identify(asset,'solana',[usdc,sol]));assert.equal(identify(asset,'solana',[usdc,sol.toLowerCase()]),null);
 assert.equal(identify(asset,'Ethereum',[evm,'FAKE_USDC']),null);assert.equal(identify(asset,'mantle',[evm,usd]),null);
 assert.ok(identify(asset,'ethereum',[evm.toUpperCase().replace('0X','0x'),usd]));assert.equal(identify(asset,'ethereum',[wrap,usd]).wrapped,true);
 assert.equal(identify(asset,'solana',[sol,usdc,'third']),null);
});
test('annualization preserves unknowns and zero; Meteora daily apr is never mistaken for annual APR',()=>{
 assert.equal(annual(null,100),null);assert.equal(annual(1,0),null);assert.equal(annual(0,100),0);assert.equal(annual(1,100),365);
 const m=meteoraPool({address:'pool',token_x:{address:sol},token_y:{address:usdc},tvl:100000,fees:{'24h':90},protocol_fees:{'24h':10},volume:{'24h':100000},apr:0.09,apy:999},asset,now);
 assert.equal(m.fee_apr24h,36.5);assert.equal(m.reward_apr24h,null);
 assert.equal(meteoraPool({address:'pool',token_x:{address:sol},token_y:{address:usdc},tvl:100000,fees:{'24h':90}},asset,now).fee_apr24h,null);
});
test('Raydium and Orca use actual rolling fees and current TVL, with separate rewards',()=>{
 const r=raydiumPool({id:'r',mintA:{address:sol},mintB:{address:usdc},tvl:100000,day:{volumeFee:100,volume:100000,feeApr:999,rewardApr:[2,3]},week:{volumeFee:700},feeRate:0.001,type:'Concentrated'},asset,now);
 assert.equal(r.fee_apr24h,36.5);assert.ok(Math.abs(r.fee_apr7d-36.5)<1e-10);assert.equal(r.reward_apr24h,5);assert.equal(r.fee_tier_pct,0.1);
 const o=orcaPool({address:'o',tokenA:{address:sol},tokenB:{address:usdc},tvlUsdc:'100000',stats:{'24h':{fees:'100',rewards:'10',volume:'100000'}},updatedAt:iso},asset,now);
 assert.equal(o.fee_apr24h,36.5);assert.ok(Math.abs(o.reward_apr24h-3.65)<1e-10);
});
test('discovery does not invent APR; mixed Llama APY never participates in comparable ranking',()=>{
 const d=dexPool({chainId:'solana',pairAddress:'pool',dexId:'example',baseToken:{address:sol},quoteToken:{address:usdc},liquidity:{usd:100000},volume:{h24:100000},apr:999},asset,now);assert.equal(d.fee_apr24h,null);
 const l=llamaPool({pool:'uuid',chain:'Solana',project:'anything',underlyingTokens:[sol,usdc],exposure:'multi',ilRisk:'yes',apy:999,tvlUsd:100000},asset,now);assert.equal(l.address,null);assert.deepEqual(ranked([d,l],null,now),[]);
 assert.equal(llamaPool({pool:'uuid',chain:'Solana',underlyingTokens:[sol,usdc],exposure:'single',ilRisk:'no'},asset,now),null);
});
test('ranking excludes stale, future, halted, warned, illiquid and extreme pools',()=>{
 const invalid=[{observed_at:new Date(now-5*HOUR).toISOString()},{provider_at:new Date(now-5*HOUR).toISOString()},{observed_at:new Date(now+2*HOUR).toISOString()},{halted:true},{warning:true},{verified:false},{tvl:500},{volume24h:5},{fee_apr24h:1001},{basis:null},{fee_apr24h:null}].map(p=>({...base,...p}));
 assert.deepEqual(ranked([...invalid,base,other],null,now).map(p=>p.key),[other.key,base.key]);
});
test('same-asset comparisons never use a different stock or the screenshot APY as a current baseline',()=>{
 const row={symbol:'MSFTx',pool_address:'pool1',network:'Solana',capital_usd:3650,shown_rate:999,rate_type:'APY'};
 const c=comparison(row,[base,other,{...other,asset:'TSLAx',fee_apr24h:900}],now);
 assert.equal(c.best.key,other.key);assert.equal(c.delta,10);assert.equal(c.monthly,30);
 assert.equal(comparison({...row,capital_usd:null},[base,other],now).monthly,null);
 assert.equal(comparison(row,[{...base,observed_at:new Date(now-5*HOUR).toISOString()},other],now).delta,null);
});
test('ambiguous platform + symbol is not silently assigned to the highest yielding pool',()=>{
 assert.equal(resolvePosition({symbol:'MSFTx',network:'Solana',platform:'Raydium'},[base,{...other,platform:'Raydium'}]).pool,null);
 assert.equal(resolvePosition({symbol:'MSFTx'},[base]).pool,null);
 assert.equal(resolvePosition({symbol:'MSFTx',network:'Ethereum',pool_address:'pool1'},[base]).pool,null);
});
test('free, pending, trial and test tiers receive only a scenario, never a paid pool list',()=>{
 for(const tier of ['free','pending','trial','test']){
  assert.equal(lpPaid({tier}),false);const v=poolsView({access:{tier},profile:{positions:[{symbol:'MSFTx',pool_address:'secret'}]},markets:[{data:{pools:[base,other]}}],now});
  assert.match(v.text,/сценарий/);assert.doesNotMatch(v.text,/secret|Raydium|Orca/);assert.ok(v.keyboard.flat().some(b=>b.callback_data==='lp:upgrade'));
 }
 assert.equal(lpPaid({tier:'paid'}),true);assert.match(teaser([{...base,observed_at:new Date(now-5*HOUR).toISOString()}],now),/пока нет/);
});
test('corrections preserve unknown amounts, support deletion, and do not treat wallet/URL as pool address',()=>{
 const rows=[normalizePosition({symbol:'MSFTx',capital_usd:null}),normalizePosition({symbol:'TSLAx',capital_usd:20})];
 const out=correctPosition(rows,'/poolfix 1 сумма=1000,50 сеть=Ethereum площадка=Uniswap V3');assert.equal(out[0].capital_usd,1000.5);assert.equal(out[0].platform,'Uniswap V3');assert.equal(out[1].capital_usd,20);
 assert.equal(correctPosition(rows,'/poolfix 1 удалить').length,1);assert.equal(normalizePosition({pool_address:'https://evil.example'}).pool_address,null);
 assert.equal(normalizePosition({capital_usd:-2}).capital_usd,null);assert.equal(normalizePosition({capital_usd:''}).capital_usd,null);
});
test('all report and preview pages stay within Telegram message limits and escape screenshot text',()=>{
 const pools=Array.from({length:30},(_,i)=>({...base,key:'pool'+i,address:'Z'.repeat(44),asset:'MSFTx',platform:'Raydium'}));
 const positions=Array.from({length:30},()=>normalizePosition({symbol:'MSFTx',platform:'<b>fake</b>',network:'Solana',capital_usd:100000,shown_rate:999,rate_type:'APY',issue:'x'.repeat(160)}));
 for(const section of ['home','positions','market','unrated','coverage'])for(let page=0;page<15;page++){
  const v=poolsView({access:{tier:'paid'},profile:{positions,updated_at:iso},markets:[{data:{symbol:'MSFTx',pools,checked_at:iso,coverage:[]}}],section,page,now});assert.ok(v.text.length<4096,section+' '+v.text.length);
 }
 const v=previewText({rows:positions,warnings:[],id:'id'},pools);assert.ok(v.text.length<4096);assert.match(v.text,/&lt;b&gt;/);
});
function cacheDb(){const rows=[];return {rows,post:async(_t,r)=>{if(rows.some(x=>x.cache_key===r.cache_key&&x.bucket===r.bucket))return [];rows.push(structuredClone(r));return [r];},get:async(_t,q)=>rows.filter(r=>r.cache_key===q.cache_key.slice(3)&&r.bucket===q.bucket.slice(3)),patch:async(_t,b,q)=>{Object.assign(rows.find(r=>r.cache_key===q.cache_key.slice(3)&&r.bucket===q.bucket.slice(3)),b);}};}
test('two customers and concurrent workers share one provider fetch; failed sources are cached too',async()=>{
 const db=cacheDb(),p=new PoolProvider(db);let calls=0;
 const fn=async()=>{calls++;return {pools:[base]};};await Promise.all([p.once('same',1,fn,now),p.once('same',1,fn,now)]);await p.once('same',1,fn,now);assert.equal(calls,1);
 await p.once('fail',1,async()=>{calls++;throw Error('lp_source_http_429');},now);await p.once('fail',1,fn,now);assert.equal(calls,2);
 await p.once('same',1,fn,now+HOUR);assert.equal(calls,3);
});
test('market clients reject user URLs and metadata endpoints',async()=>{
 await assert.rejects(()=>publicJson('http://127.0.0.1/'),/not_allowed/);await assert.rejects(()=>publicJson('https://example.com/'),/not_allowed/);await assert.rejects(()=>publicJson('https://user:pass@api.orca.so/'),/not_allowed/);
});
test('opening the paid section is cache-only and downgrade is checked at delivery',async()=>{
 let fetches=0;const out=[];const radar={db:{get:async table=>table==='pr_lp_market'?[{data:{pools:[base,other]}}]:table==='pr_lp_profiles'?[{version:1,enabled:true,positions:[],updated_at:iso}]:table==='pr_users'?[{subscribed:true}]:[],post:async(t,b)=>{if(t==='pr_outbox')out.push(b);}},billing:{access:async()=>({tier:'paid'})}};
 const p=new Pools(radar);p.provider.collect=async()=>{fetches++;};await p.open({id:1},42);await p.open({id:2},42);assert.equal(fetches,0);
 const row=out[0];const body=await p.deliveryBody(row,row.body._portfolius,{tier:'free'});assert.doesNotMatch(body.text,/Raydium|Orca/);
 assert.equal(await p.deliveryBody(row,{pools:true,automatic:true,version:1},{tier:'free'}),null);
 assert.equal(await p.deliveryBody(row,{pools:true,automatic:true,version:2},{tier:'paid'}),null);
});
test('LP callbacks are ownership-scoped before saving and forged imports cannot commit',async()=>{
 let commits=0,replies=0;const queries=[];const radar={db:{get:async(t,q)=>{queries.push(q);return [];},rpc:async()=>{commits++;}},reply:async()=>{replies++;},billing:{access:async()=>({tier:'paid'})}};
 await new Pools(radar).callback({id:1},42,'save','11111111-1111-4111-8111-111111111111');assert.equal(commits,0);assert.equal(replies,1);assert.equal(queries[0].user_id,'eq.42');
});
test('worker endpoints reject unauthenticated manual refresh before scheduling any market job',async()=>{
 let runs=0;const handler=createHandler({},()=>{runs++;},{rpc:async()=>({worker_secret:'expected'})});
 const r=await handler(new Request('https://example.com/pools-work',{method:'POST'}));assert.equal(r.status,401);assert.equal(runs,0);
});

test('fixed-fee EVM comparisons require the same verified pair and never assume a missing fee',()=>{
 const meta={chain:'ethereum',address:'0x'+'d'.repeat(40),tokens:[wrap,usd],fee_pct:0.3,platform:'Example V3',source:'https://source.example',url:'https://pool.example'};
 const dex={chainId:'ethereum',pairAddress:meta.address,dexId:'example',baseToken:{address:wrap},quoteToken:{address:usd},liquidity:{usd:100000},volume:{h24:100000}};
 const p=staticFeePool(meta,dex,asset,now);assert.equal(p.wrapped,true);assert.equal(p.fee_apr24h,109.5);assert.equal(p.estimated_fees,true);
 assert.equal(staticFeePool({...meta,fee_pct:null},dex,asset,now),null);assert.equal(staticFeePool(meta,{...dex,chainId:'mantle'},asset,now),null);
 assert.equal(staticFeePool(meta,{...dex,quoteToken:{address:'fake'}},asset,now),null);
 assert.equal(normalizePosition({pool_address:'0x'+'e'.repeat(64)}).pool_address.length,66);
});

