import test from 'node:test';
import assert from 'node:assert/strict';
import {comparison,correctPosition,normalizePosition,anchorRange} from '../src/lp-data.js';
import {opportunity,actionable} from '../src/lp-opportunities.js';
import {poolsView,previewText,opportunityLine} from '../src/lp-format.js';
const now=Date.now(),iso=new Date(now).toISOString();
const state={status:'ok',version:1,observed_at:iso,slot:100,token_a:'stock',token_b:'usdc',decimals_a:0,decimals_b:0,liquidity:'10000',sqrt_price_x64:'18446744073709551616',tick_current:0,tick_spacing:1,lp_fee_share:0.84};
const current={key:'solana:'+'A'.repeat(44),address:'A'.repeat(44),asset:'TESTx',stock_address:'stock',usdc_address:'usdc',platform:'Raydium',network:'Solana',chain:'solana',verified:true,concentrated:true,tvl:100000,volume24h:100000,fee_apr24h:36.5,fee_apr7d:36.5,basis:'gross-fees/tvl',observed_at:iso,clmm_state:state,url:'https://raydium.io/',source:'https://api-v3.raydium.io/'};
const candidate={...current,key:'solana:'+'B'.repeat(44),address:'B'.repeat(44),platform:'Orca',fee_apr24h:54.75,fee_apr7d:54.75};
const row={symbol:'TESTx',network:'Solana',platform:'Raydium',pool_address:current.address,capital_usd:100,range_lower:0.25,range_upper:4,range_status:'in'};
test('a missing range cannot turn a higher pool APR into a personal recommendation',()=>{
 const c=comparison({...row,range_lower:null},[current,candidate],now);
 assert.equal(c.delta,null);assert.equal(c.monthly,null);assert.equal(c.reason,'range_missing');
 const text=poolsView({access:{tier:'paid'},profile:{positions:[{...row,range_lower:null}]},markets:[{data:{pools:[current,candidate]}}],now}).text;
 assert.match(text,/диапазон/i);assert.doesNotMatch(text,/Потенциал дополнительного дохода|≈ \+\$/);
});
test('equal capital and equal bounds use active liquidity and LP fees, not fee divided by whole-pool TVL',()=>{
 const c=comparison(row,[current,candidate],now);
 assert.equal(c.method,'clmm-spot-v1');assert.equal(c.best.key,candidate.key);
 // P=1, sqrt bounds=0.5..2: $100 buys about 100 liquidity units.
 // Ray: 100 gross fees * .84 * (100/10000) = .84/day.
 // Orca: 150*.84*(100/10100) = 1.247524752/day; ticks introduce <.01% rounding.
 assert.ok(Math.abs(c.current_estimate.daily-0.84)<0.0001);
 assert.ok(Math.abs(c.best_estimate.daily-1.247524752)<0.0001);
 assert.ok(Math.abs(c.monthly-12.22574256)<0.005);
 assert.equal(c.current_estimate.requested_lower,c.best_estimate.requested_lower);
 assert.equal(c.current_estimate.requested_upper,c.best_estimate.requested_upper);
 assert.equal(c.current_estimate.capital,c.best_estimate.capital);
 const narrower=comparison({...row,range_lower:0.81,range_upper:1.21},[current,candidate],now);
 assert.ok(narrower.current_estimate.daily>c.current_estimate.daily);
});
test('a pool with a higher overall APR can earn less in the requested range',()=>{
 const crowded={...candidate,clmm_state:{...state,liquidity:'100000'}};
 const c=comparison(row,[current,crowded],now);assert.equal(c.best.key,current.key);assert.equal(c.delta,0);
});
test('unknown, stale, unsupported and malformed CLMM state never falls back to pool APR',()=>{
 for(const stateChange of [null,{...state,status:'unavailable'},{...state,observed_at:'2000-01-01'},{...state,liquidity:'0'},{...state,lp_fee_share:null},{...state,token_a:'wrong'},{...state,decimals_a:null}]){
  const c=comparison(row,[{...current,clmm_state:stateChange},candidate],now);assert.equal(c.delta,null);assert.equal(c.monthly,null);
 }
 for(const bad of [{range_upper:0.2},{range_lower:0},{range_lower:Infinity},{capital_usd:null}])assert.equal(comparison({...row,...bad},[current,candidate],now).delta,null);
 assert.equal(comparison(row,[current,{...candidate,clmm_state:null}],now).delta,null);
});
test('token order and decimal scale produce the same economic estimate',()=>{
 const inverted={...candidate,clmm_state:{...state,token_a:'usdc',token_b:'stock'}};
 const a=comparison(row,[current,candidate],now),b=comparison(row,[current,inverted],now);
 assert.ok(Math.abs(a.monthly-b.monthly)<1e-8);
 const scaled=[current,candidate].map(p=>({...p,clmm_state:{...state,decimals_a:6,decimals_b:6,liquidity:'10000000000'}}));
 assert.ok(Math.abs(comparison(row,scaled,now).monthly-a.monthly)<1e-8);
});
test('live price overrides the old screenshot range status and reports zero current fee accrual outside both bounds',()=>{
 const oldOut=comparison({...row,range_status:'out'},[current,candidate],now);assert.ok(oldOut.delta>0);
 const o=opportunity({...row,range_lower:4,range_upper:9},[current,candidate],now);
 assert.equal(o.status,'range');assert.equal(actionable(o),false);assert.equal(o.counted_gain,0);
 assert.equal(o.current_estimate.daily,0);assert.equal(o.monthly,null);
});
test('materially different tick-rounded bounds or pool prices prevent a claimed advantage',()=>{
 assert.equal(comparison({...row,range_lower:0.999,range_upper:1.001},[current,{...candidate,clmm_state:{...state,tick_spacing:128}}],now).delta,null);
 assert.equal(comparison(row,[current,{...candidate,clmm_state:{...state,sqrt_price_x64:'20291418481080506777',tick_current:1906}}],now).delta,null);
});
test('range corrections preserve the other position and reject reversed bounds',()=>{
 const result=correctPosition([row,{...row,symbol:'OTHERx'}],'/poolfix 1 минимум=0,5 максимум=2');
 assert.equal(result[0].range_lower,0.5);assert.equal(result[0].range_upper,2);assert.equal(result[1].range_lower,0.25);
 assert.throws(()=>correctPosition([row],'/poolfix 1 минимум=5 максимум=2'),/range/);
 assert.equal(normalizePosition({...row,range_lower:null}).range_lower,null);
});
test('non-unit prices, inverse quotation and unequal decimals preserve the dollar economics',()=>{
 const rawLiquidity=String(Math.round(10000*Math.sqrt(10**15)));
 for(const invert of [false,true]){
  const s={...state,tick_current:Math.floor(Math.log(invert?.00025:4000)/Math.log(1.0001)),decimals_a:invert?9:6,decimals_b:invert?6:9,token_a:invert?'usdc':'stock',token_b:invert?'stock':'usdc',liquidity:rawLiquidity,sqrt_price_x64:String(BigInt(Math.round(Math.sqrt(invert?.00025:4000)*2**64)))};
  const c=comparison({...row,range_lower:1,range_upper:9},[{...current,clmm_state:s},{...candidate,clmm_state:s}],now);
  // At price 4: value per liquidity = (1/2-1/3)*4+(2-1) = 5/3.
  assert.ok(Math.abs(c.current_estimate.daily-.504)<.0001);
 }
});
test('active status uses on-chain tick at exact boundaries, including inverted quotations',()=>{
 const crossing={...state,tick_current:-1};
 const c=comparison({...row,range_lower:1,range_upper:4},[{...current,clmm_state:crossing},{...candidate,clmm_state:crossing}],now);
 assert.equal(c.reason,'out_of_range');assert.equal(c.current_estimate.daily,0);
 const inverted={...state,token_a:'usdc',token_b:'stock'};
 const inverse=comparison({...row,range_lower:1,range_upper:4},[{...current,clmm_state:inverted},{...candidate,clmm_state:inverted}],now);
 assert.equal(inverse.reason,'out_of_range');assert.equal(inverse.current_estimate.daily,0);
});
test('personal cards display range-specific estimates and identify unavailable comparisons honestly',()=>{
 const o=opportunity(row,[current,candidate],now),card=opportunityLine(o);
 assert.match(card,/0,25.*4.*USDC/);assert.match(card,/Оценка.*диапазон/);assert.doesNotMatch(card,/36,5%|54,75%/);
 assert.match(card,/эффективные границы/i);
 const missing=opportunityLine(opportunity({...row,range_upper:null},[current,candidate],now));assert.match(missing,/не.*границ|границ.*не/i);assert.doesNotMatch(missing,/устарел/);
 const unsupported=opportunityLine(opportunity(row,[{...current,concentrated:false},candidate],now));assert.match(unsupported,/пока не поддерж/i);
 const view=poolsView({access:{tier:'paid'},profile:{positions:[row]},markets:[{data:{pools:[{...current,clmm_state:null},candidate]}}],now});
 assert.match(view.text,/Недостаточно данных/);assert.doesNotMatch(view.text,/Заметной.*прибавки.*не нашли/);
 const preview=previewText({rows:[row]},[current,candidate]);assert.match(preview.text,/0,25.*4.*USDC/);
});
test('scaled xStocks infer quotation from existing ticks and compare the same economic bounds',()=>{
 const s={...state,multiplier_a:2,multiplier_b:1},pools=[current,candidate].map(p=>({...p,clmm_state:s}));
 const lo=1.0001**-10000,hi=1.0001**10000;
 const raw=comparison({...row,range_lower:lo,range_upper:hi},pools,now),saved=anchorRange({...row,captured_at:iso,range_lower:lo/2,range_upper:hi/2},pools,now),scaled=comparison(saved,pools,now);
 assert.equal(raw.current_estimate.range_quote,'raw');assert.equal(scaled.current_estimate.range_quote,'scaled');
 assert.ok(Math.abs(raw.monthly-scaled.monthly)<1e-6);
 assert.equal(scaled.best_estimate.range_quote,'scaled');assert.equal(scaled.current_estimate.price,.5);
 const ambiguous=pools.map(p=>({...p,clmm_state:{...s,multiplier_a:1.0001**100}}));
 assert.equal(comparison({...row,range_lower:lo,range_upper:hi},ambiguous,now).reason,'range_quote_missing');
 assert.equal(comparison({...row,range_lower:lo,range_upper:hi,range_quote:'raw'},ambiguous,now).delta>0,true);
 const expired=pools.map(p=>({...p,clmm_state:{...s,multiplier_valid_until:Math.floor(now/1000)-1}}));
 assert.equal(comparison({...row,range_lower:lo,range_upper:hi},expired,now).reason,'range_data_stale');
});
test('a multiplier change preserves captured scaled position ticks and does not reinterpret old screenshots',()=>{
 const lo=1.0001**-10000,hi=1.0001**10000,twice=[current,candidate].map(p=>({...p,clmm_state:{...state,multiplier_a:2,multiplier_b:1}}));
 const input={...row,range_quote:'scaled',range_lower:lo/2,range_upper:hi/2,captured_at:iso},saved=normalizePosition(anchorRange(input,twice,now));
 assert.equal(saved.range_basis_multiplier,2);assert.equal(saved.range_basis_stock,'stock');
 const a=comparison(saved,twice,now),four=twice.map(p=>({...p,clmm_state:{...p.clmm_state,multiplier_a:4}})),b=comparison(saved,four,now);
 assert.equal(b.current_estimate.tick_lower,a.current_estimate.tick_lower);assert.equal(b.current_estimate.tick_upper,a.current_estimate.tick_upper);
 assert.equal(b.current_estimate.in_range,true);assert.ok(Math.abs(b.monthly-a.monthly)<1e-6);assert.equal(b.current_estimate.requested_lower,lo/4);
 assert.equal(comparison(input,four,now).reason,'range_quote_missing');
 assert.equal(anchorRange({...input,captured_at:'2000-01-01'},four,now).range_basis_multiplier,undefined);
 const edited=correctPosition([saved],'/poolfix 1 минимум=0.3 максимум=1.4');assert.equal(edited[0].range_basis_multiplier,null);
});
test('legacy scaled ranges can be anchored only if the on-chain multiplier was already active when captured',()=>{
 const captured=Math.floor(now/1000)-86400,lo=1.0001**-10000,hi=1.0001**10000;
 const input={...row,range_lower:lo/2,range_upper:hi/2,captured_at:new Date(captured*1000).toISOString()};
 const pools=[current,candidate].map(p=>({...p,clmm_state:{...state,multiplier_a:2,multiplier_b:1,multiplier_effective_since_a:captured-10000}}));
 const anchored=anchorRange(input,pools,now);assert.equal(anchored.range_quote,'scaled');assert.equal(anchored.range_basis_multiplier,2);assert.ok(comparison(anchored,pools,now).delta>0);
 for(const since of [null,undefined,captured+10000]){const bad=pools.map(p=>({...p,clmm_state:{...p.clmm_state,multiplier_effective_since_a:since}}));assert.equal(anchorRange(input,bad,now).range_basis_multiplier,undefined);}
});
