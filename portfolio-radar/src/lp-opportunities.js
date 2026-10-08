import {normalizePosition,resolvePosition,venueSuggestions,applyVenue,candidateToken,fresh,comparison,positive,HOUR} from './lp-data.js';

export const MIN_MONTHLY_GAIN=1;
export function portfolioProposals(rows,pools,now=Date.now()){
 const normalized=rows.map(normalizePosition),available=pools.filter(p=>fresh(p,now));
 const missing=normalized.filter(r=>!resolvePosition(r,available).pool).length;
 if(!missing)return [];
 // Present complete interpretations, not a venue chosen from the highest APR.
 return venueSuggestions(normalized,available).filter(g=>g.count===missing).slice(0,3).map(g=>{
  const proposed=applyVenue(normalized,available,g.key);
  if(!proposed.every(r=>resolvePosition(r,available).pool))return null;
  return {...g,rows:proposed,token:candidateToken({key:JSON.stringify({venue:g.key,rows:proposed})})};
 }).filter(Boolean);
}

export function opportunity(input,pools,now=Date.now()){
 const row=normalizePosition(input),c=comparison(row,pools,now),cost=positive(row.switch_cost_usd);
 if(c.current?.fee_apr24h>1000)Object.assign(c,{delta:null,monthly:null});
 const current7=positive(c.current?.fee_apr7d),best7=positive(c.best?.fee_apr7d);
 const weekly_delta=current7!==null&&best7!==null?best7-current7:null;
 const after_cost=c.monthly!==null&&cost!==null?c.monthly-cost:null;
 let status='no_data';
 if(c.delta!==null){
  status=c.delta<=0?'keep':c.monthly===null?'amount_needed':c.monthly<MIN_MONTHLY_GAIN?'small':weekly_delta!==null&&weekly_delta<=0?'spike':'opportunity';
  if(c.delta>0&&after_cost!==null&&after_cost<=0)status='costs';
 }
 if(row.range_status==='out')status='range';
 if(c.current?.warning||c.current?.halted||c.current?.fee_apr24h>1000)status='review';
 return {...c,row,cost,weekly_delta,after_cost,status,
  daily:c.monthly===null?null:c.monthly/30,
  payback_days:cost!==null&&c.monthly>0?cost/(c.monthly/30):null,
  range_warning:row.range_status==='out',
  // An unknown cost is never silently replaced by zero.
  counted_gain:status==='opportunity'?(after_cost??c.monthly):0};
}
export function opportunitySummary(rows,pools,now=Date.now()){
 const all=rows.map((r,index)=>({...opportunity(r,pools,now),index}));
 const order={opportunity:0,amount_needed:1,spike:2,costs:3,small:4,range:5,review:6,keep:7,no_data:8};
 const sorted=[...all].sort((a,b)=>order[a.status]-order[b.status]||(b.monthly??-1)-(a.monthly??-1)||a.index-b.index);
 return {all,sorted,offers:all.filter(o=>o.status==='opportunity'),keep:all.filter(o=>o.status==='keep'),
  range:all.filter(o=>o.range_warning),pending:all.filter(o=>!o.current),
  comparable:all.filter(o=>o.delta!==null),gain:all.reduce((sum,o)=>sum+o.counted_gain,0)};
}
export const actionable=o=>o.status==='opportunity'&&o.delta>=5&&o.counted_gain>=MIN_MONTHLY_GAIN;
export function stableOpportunity(row,previous,latest,now=Date.now()){
 const earlier=Date.parse(previous?.checked_at),later=Date.parse(latest?.checked_at);
 if(!Number.isFinite(earlier)||!Number.isFinite(later)||later-earlier<30*60000||now-later>4*HOUR||later>now+60000)return false;
 const a=opportunity(row,previous.pools||[],Date.parse(previous.checked_at)),b=opportunity(row,latest.pools||[],now);
 return actionable(a)&&actionable(b)&&a.best.key===b.best.key&&Date.parse(b.best.observed_at)>Date.parse(a.best.observed_at)&&Date.parse(b.current.observed_at)>Date.parse(a.current.observed_at);
}
