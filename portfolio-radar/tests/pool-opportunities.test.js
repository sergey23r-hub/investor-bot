import test from 'node:test';
import assert from 'node:assert/strict';
import {opportunity,opportunitySummary,stableOpportunity,portfolioProposals,actionable} from '../src/lp-opportunities.js';
import {poolsView,opportunityLine} from '../src/lp-format.js';
import {correctPosition} from '../src/lp-data.js';
const now=Date.now(),iso=new Date(now).toISOString(),oldIso=new Date(now-3600000).toISOString();
const current={key:'solana:'+'A'.repeat(44),address:'A'.repeat(44),platform:'Raydium',network:'Solana',chain:'solana',asset:'MSFTx',verified:true,tvl:100000,volume24h:10000,basis:'gross-fees/tvl',fee_apr24h:10,fee_apr7d:8,fee_tier_pct:0.25,concentrated:true,observed_at:iso,url:'https://raydium.io/',source:'https://api-v3.raydium.io/'};
const best={...current,key:'solana:'+'B'.repeat(44),address:'B'.repeat(44),platform:'Orca',fee_apr24h:20,fee_apr7d:18,url:'https://www.orca.so/'};
const row={symbol:'MSFTx',network:'Solana',platform:'Raydium',pool_address:current.address,capital_usd:3650,shown_rate:999,rate_type:'APY',range_status:'in',fee_tier_pct:0.25};
test('opportunities use comparable pool fees, show dollar difference and a cost ceiling without inventing zero costs',()=>{
 const o=opportunity(row,[current,best],now);assert.equal(o.status,'opportunity');assert.equal(o.monthly,30);assert.equal(o.daily,1);assert.equal(o.cost,null);assert.equal(o.after_cost,null);assert.equal(o.payback_days,null);assert.equal(o.weekly_delta,10);
 assert.match(opportunityLine(o),/ниже \$30/);assert.doesNotMatch(opportunityLine(o),/999/);assert.equal(opportunitySummary([row],[current,best],now).gain,30);
 const corrected=correctPosition([row],'/poolfix 1 расходы=5,50');assert.equal(corrected[0].switch_cost_usd,5.5);
});
test('known costs, no advantage, tiny amounts and a contradictory weekly window produce distinct decisions',()=>{
 const cost=opportunity({...row,switch_cost_usd:40},[current,best],now);assert.equal(cost.status,'costs');assert.equal(cost.after_cost,-10);assert.equal(cost.payback_days,40);assert.equal(cost.counted_gain,0);
 assert.equal(opportunity({...row,switch_cost_usd:0},[current,best],now).after_cost,30);
 assert.equal(opportunity({...row,switch_cost_usd:5},[current,best],now).counted_gain,25);
 assert.equal(opportunity(row,[current],now).status,'keep');
 assert.equal(opportunity({...row,capital_usd:1},[current,best],now).status,'small');
 assert.equal(opportunity(row,[current,{...best,fee_apr7d:3}],now).status,'spike');
 assert.equal(opportunity({...row,capital_usd:null},[current,best],now).status,'amount_needed');
});
test('unidentified, stale, anomalous and out-of-range positions do not inflate the actionable total',()=>{
 const missing=opportunity({...row,network:null,platform:null,pool_address:null},[current,best],now);assert.equal(missing.monthly,null);assert.equal(missing.status,'no_data');
 assert.equal(opportunity(row,[{...current,observed_at:'2020-01-01'},best],now).counted_gain,0);
 const out=opportunity({...row,range_status:'out'},[current,best],now);assert.equal(out.status,'range');assert.equal(out.counted_gain,0);assert.equal(actionable(out),false);
 assert.equal(opportunity(row,[{...current,fee_apr24h:10001},best],now).status,'review');
});
test('automatic opportunities require two fresh source observations, practical upside and the same alternative',()=>{
 const previous={checked_at:oldIso,pools:[current,best].map(p=>({...p,observed_at:oldIso}))},latest={checked_at:iso,pools:[current,best]};
 assert.equal(stableOpportunity(row,previous,latest,now),true);
 assert.equal(stableOpportunity({...row,range_status:'out'},previous,latest,now),false);
 assert.equal(stableOpportunity({...row,capital_usd:10},previous,latest,now),false);
 assert.equal(stableOpportunity({...row,switch_cost_usd:50},previous,latest,now),false);
 assert.equal(stableOpportunity(row,previous,{...latest,pools:[current,{...best,observed_at:oldIso}]},now),false);
 assert.equal(stableOpportunity(row,previous,{...latest,checked_at:new Date(now-1800001).toISOString()},now),false);
 assert.equal(stableOpportunity(row,previous,{...latest,pools:[current,{...best,key:'other',address:'C'.repeat(44)}]},now),false);
 assert.equal(stableOpportunity(row,previous,{...latest,checked_at:'invalid'},now),false);
});
test('provisional suggestions are labelled, free users cannot access them, and proposals do not follow APR reordering',()=>{
 const unknown={...row,pool_address:null,network:null,platform:'CLMM'},pools=[current,{...best,fee_tier_pct:1}],profile={version:2,positions:[unknown],updated_at:iso},markets=[{data:{pools}}];
 const proposal=portfolioProposals([unknown],pools,now)[0];assert.equal(proposal.platform,'Raydium');
 assert.equal(portfolioProposals([unknown],[{...current,fee_apr24h:999},best].map(p=>p.platform==='Orca'?{...p,fee_tier_pct:1}:p),now)[0].token,proposal.token);
 const v=poolsView({access:{tier:'paid'},profile,markets,now});assert.match(v.text,/предварительный расчёт/);assert.match(v.text,/≈ \+\$30/);
 assert.equal(v.keyboard[0][0].callback_data,`lp:accept:2:${proposal.token}`);
 const free=poolsView({access:{tier:'free'},profile,markets,now});assert.doesNotMatch(JSON.stringify(free),/lp:accept|Raydium|Orca/);
 assert.equal(portfolioProposals([unknown],[current,best],now).length,2);
});
test('all opportunities remain reachable across pages and within Telegram limits',()=>{
 const positions=Array.from({length:30},(_,i)=>({...row,symbol:'TEST'+i+'x',capital_usd:10000})),pools=positions.flatMap(r=>[current,best].map(p=>({...p,asset:r.symbol})));
 for(let page=0;page<15;page++){
  const v=poolsView({access:{tier:'paid'},profile:{positions,version:1,updated_at:iso},markets:[{data:{pools}}],page,now});assert.ok(v.text.length<4096,v.text.length);
  for(const b of v.keyboard.flat())assert.ok(Buffer.byteLength(b.callback_data)<=64);
  assert.match(v.text,new RegExp('TEST'+page*2+'x'));
 }
});
