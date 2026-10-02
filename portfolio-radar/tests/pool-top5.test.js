import test from 'node:test';
import assert from 'node:assert/strict';
import {globalTopPools} from '../src/lp-data.js';
import {poolsView,top5Summary,top5View} from '../src/lp-format.js';
import {Pools} from '../src/pools.js';
import {Insights} from '../src/insights.js';
const now=Date.now(),iso=new Date(now).toISOString();
const pool=(i,apr=100-i)=>({key:'solana:pool'+i,address:String.fromCharCode(65+i).repeat(44),asset:'STOCK'+i+'x',platform:i%2?'Orca':'Raydium',chain:'solana',network:'Solana',verified:true,tvl:100000,volume24h:10000,fee_apr24h:apr,fee_apr7d:apr/2,reward_apr24h:0,fee_tier_pct:0.25,basis:'gross-fees/tvl',observed_at:iso,url:'https://example.com/pool/'+i,source:'https://example.com/data/'+i});
const pools=Array.from({length:8},(_,i)=>pool(i)),markets=pools.map(p=>({symbol:p.asset,data:{pools:[p]}}));
test('top five ranks all cached assets, not the portfolio; distinct pools of one stock may both enter',()=>{
 const view=poolsView({access:{tier:'paid'},profile:{positions:[{symbol:'STOCK7x',capital_usd:123}]},markets,section:'top',now});
 for(let i=0;i<5;i++)assert.match(view.text,new RegExp('STOCK'+i+'x'));
 assert.doesNotMatch(view.text,/STOCK7x/);assert.equal(globalTopPools(pools,now).pools.length,5);
 const repeated=[{...pool(0),asset:'MSFTx'},{...pool(1),asset:'MSFTx'}];assert.equal(globalTopPools(repeated,now).pools.length,2);
 assert.equal(view.text,poolsView({access:{tier:'paid'},profile:null,markets,section:'top',now}).text);
});
test('duplicate sources use the newest comparable observation; low liquidity, stale and anomalous rows are excluded',()=>{
 const newest={...pool(0,20),observed_at:new Date(now-1000).toISOString()},older={...pool(0,900),observed_at:new Date(now-3600000).toISOString()};
 const invalid=[{verified:false},{basis:null,reported_yield:9999},{fee_apr24h:1001},{fee_apr24h:0},{fee_apr24h:null},{tvl:9999},{volume24h:999},{halted:true},{warning:true},{observed_at:new Date(now-5*3600000).toISOString()},{observed_at:new Date(now+2*3600000).toISOString()}].map((v,i)=>({...pool(i+1),...v}));
 const r=globalTopPools([older,newest,...invalid],now);assert.equal(r.eligible,1);assert.equal(r.pools[0].fee_apr24h,20);
});
test('top view works without uploaded pools and is included in the personal summary',()=>{
 assert.match(poolsView({access:{tier:'paid'},profile:null,markets,now}).text,/Топ-5 пулов сейчас/);
 const home=poolsView({access:{tier:'paid'},profile:{positions:[{symbol:'STOCK7x',network:'Solana',pool_address:pools[7].address,capital_usd:100}],updated_at:iso,version:1},markets,now});
 assert.match(home.text,/Топ-5 пулов xStocks/);for(let i=0;i<5;i++)assert.match(home.text,new RegExp('STOCK'+i+'x'));
 assert.ok(home.keyboard.flat().some(b=>b.callback_data==='lp:top:0'));assert.ok(home.text.length<4096);
});
test('limited coverage never fabricates five rows and rankings remain within Telegram limits',()=>{
 assert.match(top5View([],now),/Свежих подходящих пулов пока нет/);
 const limited=[{data:{pools:pools.slice(0,2)}}];assert.match(top5View(limited,now),/доступны 2 из 5/);
 for(const text of [top5View(markets,now),top5Summary(markets,now)])assert.ok(text.length<4096);
 const html=poolsView({access:{tier:'paid'},markets:[{data:{pools:[{...pool(0),asset:'<bad>',platform:'<bad>'}]}}],section:'top',now}).text;
 assert.doesNotMatch(html,/<bad>/);assert.match(html,/&lt;bad&gt;/);
});
test('paid top callbacks are cache-only and delivery removes the ranking after downgrade',async()=>{
 let tier='paid';const out=[];
 const radar={db:{get:async t=>t==='pr_lp_market'?markets:[],post:async(t,r)=>{if(t==='pr_outbox')out.push(r);return [r];}},billing:{access:async()=>({tier})}};
 radar.pools=new Pools(radar);radar.insights=new Insights(radar);radar.pools.provider.collect=()=>assert.fail('button must not refresh providers');
 await radar.pools.callback({id:1},42,'top','0');assert.equal(out.length,1);assert.match((await radar.insights.deliveryBody(out[0])).text,/Raydium/);
 for(const t of ['free','trial','pending','test']){tier=t;const b=await radar.insights.deliveryBody(out[0]);assert.doesNotMatch(b.text,/Raydium|Orca|example.com|Топ-5/);assert.ok(b.reply_markup.inline_keyboard.flat().some(k=>k.callback_data==='lp:upgrade'));}
});
