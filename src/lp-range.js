// Counterfactual CLMM estimate at the current price/liquidity and the observed
// average fee flow. This is NOT a historical position backtest or realized APR.
// Bounds are USDC per stock token; pool order/decimals are normalized below.
const HOUR=3600000,Q64=2**64;
const n=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
const fail=reason=>({status:'unavailable',reason});
export function rangeEstimate(row,pool,{existing=false,now=Date.now()}={}){
 const lower=n(row.range_lower),upper=n(row.range_upper),capital=n(row.capital_usd);
 if(lower===null||upper===null)return fail('range_missing');
 if(!(lower>0&&upper>lower))return fail('range_invalid');
 if(!(capital>0))return fail('amount_needed');
 if(pool?.chain!=='solana'||!['Raydium','Orca'].includes(pool?.platform)||pool.concentrated!==true)return fail('range_unsupported');
 const s=pool.clmm_state,time=Date.parse(s?.observed_at);
 if(s?.status!=='ok'||s.version!==1)return fail('range_data_missing');
 if(!Number.isFinite(time)||now-time>2*HOUR||time>now+60000)return fail('range_data_stale');
 const da=n(s.decimals_a),db=n(s.decimals_b),spacing=n(s.tick_spacing),liquidity=n(s.liquidity),root=n(s.sqrt_price_x64),lpShare=n(s.lp_fee_share);
 if(![da,db].every(d=>Number.isInteger(d)&&d>=0&&d<=18)||!Number.isInteger(spacing)||spacing<1||spacing>=32768||!(liquidity>0)||!(root>0)||lpShare===null||lpShare<0||lpShare>1)return fail('range_data_missing');
 const stockA=s.token_a===pool.stock_address&&s.token_b===pool.usdc_address;
 if(!stockA&&!(s.token_b===pool.stock_address&&s.token_a===pool.usdc_address))return fail('range_identity');
 const scale=10**(da-db),sqrt=root/Q64,priceAB=sqrt*sqrt*scale,price=stockA?priceAB:1/priceAB;
 const rawLow=(stockA?lower:1/upper)/scale,rawHigh=(stockA?upper:1/lower)/scale;
 const tickLower=Math.round(Math.log(rawLow)/Math.log(1.0001)/spacing)*spacing,tickUpper=Math.round(Math.log(rawHigh)/Math.log(1.0001)/spacing)*spacing;
 if(!Number.isFinite(price)||!(price>0)||tickLower>=tickUpper||tickLower< -443636||tickUpper>443636)return fail('range_rounding');
 const sa=1.0001**(tickLower/2),sb=1.0001**(tickUpper/2);
 const a=sa*sa*scale,b=sb*sb*scale,actualLower=stockA?a:1/b,actualUpper=stockA?b:1/a;
 if(Math.abs(actualLower-lower)>Math.min(lower*.01,(upper-lower)*.05)||Math.abs(actualUpper-upper)>Math.min(upper*.01,(upper-lower)*.05))return fail('range_rounding');
 const tick=n(s.tick_current),impliedTick=Math.log(sqrt*sqrt)/Math.log(1.0001);
 // At a downward crossing, price may equal a boundary while tick_current is
 // the tick immediately below it. The protocol's tick, not displayed price,
 // determines whether the position earns fees (also for inverted quotations).
 if(!Number.isInteger(tick)||Math.abs(tick-Math.floor(impliedTick+1e-8))>1)return fail('range_data_missing');
 const inRange=tick>=tickLower&&tick<tickUpper,requestedIn=stockA?price>=lower&&price<upper:price>lower&&price<=upper;
 const inRoundingStrip=(x,y)=>Math.abs(x-y)>Math.abs(y)*1e-10&&price>=Math.min(x,y)&&price<=Math.max(x,y);
 if(inRange!==requestedIn&&(inRoundingStrip(actualLower,lower)||inRoundingStrip(actualUpper,upper)))return fail('range_rounding');
 const p=Math.min(sb,Math.max(sa,sqrt)),amountA=(1/p-1/sb)/10**da,amountB=(p-sa)/10**db;
 const unitValue=amountA*(stockA?price:1)+amountB*(stockA?1:price),positionLiquidity=capital/unitValue;
 if(!(unitValue>0)||!Number.isFinite(positionLiquidity))return fail('range_data_missing');
 // Existing position's liquidity is already included. A new alternative adds
// its liquidity; do not overstate its share in a thin competing pool.
 const share=inRange?positionLiquidity/(liquidity+(existing?0:positionLiquidity)):0;
 if(share>.1)return fail('position_too_large');
 const fees=n(pool.fees24h)??(n(pool.fee_apr24h)!==null&&n(pool.tvl)>0?pool.fee_apr24h/100*pool.tvl/365:null);
 const fees7=n(pool.fees7d)??(n(pool.fee_apr7d)!==null&&n(pool.tvl)>0?pool.fee_apr7d/100*pool.tvl/365*7:null);
 if(fees===null||fees<0||pool.estimated_fees)return fail('range_fees_missing');
 const daily=fees*lpShare*share,daily7=fees7!==null&&fees7>=0?fees7/7*lpShare*share:null;
 return {status:'ok',method:'clmm-spot-v1',capital,requested_lower:lower,requested_upper:upper,lower:actualLower,upper:actualUpper,tick_lower:tickLower,tick_upper:tickUpper,price,in_range:inRange,share,position_liquidity:positionLiquidity,daily,apr:daily/capital*365*100,daily7,apr7:daily7===null?null:daily7/capital*365*100,observed_at:s.observed_at,slot:s.slot,rounded:Math.abs(actualLower/lower-1)>1e-6||Math.abs(actualUpper/upper-1)>1e-6};
}
export function compareRanges(row,current,candidates,now=Date.now()){
 const result={current,best:null,delta:null,monthly:null,method:'clmm-spot-v1',reason:null,current_estimate:null,best_estimate:null,coverage:{checked:0,total:candidates.filter(p=>p.key!==current?.key).length}};
 if(!current)return {...result,reason:'pool_missing'};
 const estimate=rangeEstimate(row,current,{existing:true,now});result.current_estimate=estimate;
 if(estimate.status!=='ok')return {...result,reason:estimate.reason};
 let best={pool:current,estimate};
 for(const pool of candidates){
  if(pool.key===current.key)continue;
  if(pool.chain!==current.chain||pool.stock_address!==current.stock_address||pool.usdc_address!==current.usdc_address)continue;
  const e=rangeEstimate(row,pool,{now});
  if(e.status!=='ok'||Math.abs(e.price/estimate.price-1)>.005||e.in_range!==estimate.in_range)continue;
  if(Math.abs(Date.parse(e.observed_at)-Date.parse(estimate.observed_at))>10*60000)continue;
  if(Math.abs(Date.parse(pool.observed_at)-Date.parse(current.observed_at))>10*60000)continue;
  result.coverage.checked++;
  if(e.daily>best.estimate.daily)best={pool,estimate:e};
 }
 if(!estimate.in_range)return {...result,best:best.pool,best_estimate:best.estimate,reason:'out_of_range'};
 if(!result.coverage.checked)return {...result,reason:'alternatives_missing'};
 const delta=Math.max(0,best.estimate.apr-estimate.apr);
 return {...result,best:best.pool,best_estimate:best.estimate,delta,monthly:Math.max(0,best.estimate.daily-estimate.daily)*30,cross_chain:false};
}
