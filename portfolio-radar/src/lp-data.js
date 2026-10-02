// Public market data only. Symbols are labels; contract + chain establish identity.
export const LP_VERSION=1;
export const HOUR=3600000;
export const chainId=n=>({Solana:'solana',Ethereum:'ethereum',Arbitrum:'arbitrum',Mantle:'mantle',HyperEVM:'hyperevm','Hyperliquid L1':'hyperevm',Ink:'ink',BinanceSmartChain:'bsc',BSC:'bsc',Monad:'monad',Optimism:'optimism',XLayer:'xlayer',Ton:'ton',TON:'ton',Tron:'tron',TRON:'tron',Base:'base',Avalanche:'avalanche',Polygon:'polygon'}[n]||String(n||'').toLowerCase());
export const addressKey=(chain,address)=>/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(address||'')?address.toLowerCase():String(address||'');
export const number=x=>x===null||x===undefined||x===''?null:Number.isFinite(Number(x))?Number(x):null;
export const positive=x=>number(x)!==null&&number(x)>=0?number(x):null;
export function annual(fees,tvl,days=1){const f=positive(fees),t=positive(tvl);return f!==null&&t>0?f/t*365/days*100:null;}
export function compactAsset(a){
 if(!a?.symbol||!/x$/i.test(a.symbol)||!Array.isArray(a.deployments))return null;
 return {symbol:a.symbol,underlying:a.underlyingSymbol||a.underlying?.symbol||null,name:a.name,halted:!!a.isTradingHalted,deployments:a.deployments.map(d=>({network:d.network,chain:chainId(d.network),address:d.address,wrappers:[d.wrapperAddress,d.wrapperAddressV2].filter(Boolean),usdc:(d.stablecoins||[]).filter(s=>s.symbol==='USDC'&&chainId(s.network)===chainId(d.network)).map(s=>s.address)}))};
}
export function identify(asset,chain,tokens){
 if(tokens?.length!==2||!tokens.every(x=>typeof x==='string'&&x))return null;
 chain=chainId(chain);const t=tokens.map(x=>addressKey(chain,x));
 for(const d of asset.deployments.filter(d=>d.chain===chain))for(const stock of [d.address,...d.wrappers]){
  const i=t.indexOf(addressKey(chain,stock));if(i<0)continue;
  if(d.usdc.some(q=>addressKey(chain,q)===t[1-i]))return {asset:asset.symbol,underlying:asset.underlying,network:d.network,chain,wrapped:stock!==d.address,stock_address:stock,usdc_address:tokens[1-i],halted:asset.halted,verified:true};
 }
 return null;
}
export function poolBase(asset,chain,tokens,address,platform,now){
 const identity=identify(asset,chain,tokens);if(!identity||!address)return null;
 return {...identity,key:identity.chain+':'+addressKey(identity.chain,address),address,platform,tvl:null,volume24h:null,fee_apr24h:null,fee_apr7d:null,reward_apr24h:null,basis:null,observed_at:new Date(now).toISOString(),provider_at:null};
}
export function raydiumPool(p,asset,now=Date.now()){
 const row=poolBase(asset,'solana',[p.mintA?.address,p.mintB?.address],p.id,'Raydium',now);if(!row)return null;
 return {...row,tvl:positive(p.tvl),volume24h:positive(p.day?.volume),fee_apr24h:annual(p.day?.volumeFee,p.tvl),fee_apr7d:annual(p.week?.volumeFee,p.tvl,7),reward_apr24h:Array.isArray(p.day?.rewardApr)&&p.day.rewardApr.every(v=>positive(v)!==null)?p.day.rewardApr.reduce((a,b)=>a+Number(b),0):null,fee_tier_pct:number(p.feeRate)!==null?Number(p.feeRate)*100:null,basis:'gross-fees/tvl',concentrated:p.type==='Concentrated',source:'https://api-v3.raydium.io/pools/info/ids?ids='+encodeURIComponent(p.id),url:p.type==='Concentrated'?'https://raydium.io/clmm/create-position/?pool_id='+encodeURIComponent(p.id):'https://raydium.io/liquidity/increase/?mode=add&pool_id='+encodeURIComponent(p.id)};
}
export function orcaPool(p,asset,now=Date.now()){
 const row=poolBase(asset,'solana',[p.tokenA?.address||p.tokenMintA,p.tokenB?.address||p.tokenMintB],p.address,'Orca',now);if(!row)return null;
 return {...row,tvl:positive(p.tvlUsdc),volume24h:positive(p.stats?.['24h']?.volume),fee_apr24h:annual(p.stats?.['24h']?.fees,p.tvlUsdc),fee_apr7d:annual(p.stats?.['7d']?.fees,p.tvlUsdc,7),reward_apr24h:annual(p.stats?.['24h']?.rewards,p.tvlUsdc),fee_tier_pct:number(p.feeRate)!==null?Number(p.feeRate)/10000:null,basis:'gross-fees/tvl',concentrated:true,warning:!!p.hasWarning,provider_at:p.updatedAt||null,source:'https://api.orca.so/v2/solana/pools/'+encodeURIComponent(p.address)+'?stats=24h,7d',url:'https://www.orca.so/pools/'+encodeURIComponent(p.address)};
}
export function meteoraPool(p,asset,now=Date.now()){
 const row=poolBase(asset,'solana',[p.token_x?.address,p.token_y?.address],p.address,'Meteora DLMM',now);if(!row)return null;
 // In this API `apr` is the DAILY fee/TVL percentage. Never annualize it twice
 // or mix it with APY. fees excludes protocol_fees; add them for a gross benchmark.
 const fees=positive(p.fees?.['24h']),protocol=positive(p.protocol_fees?.['24h']);
 return {...row,tvl:positive(p.tvl),volume24h:positive(p.volume?.['24h']),fee_apr24h:annual(fees!==null&&protocol!==null?fees+protocol:null,p.tvl),fee_tier_pct:positive(p.pool_config?.base_fee_pct),basis:'gross-fees/tvl',concentrated:true,warning:!!p.is_blacklisted,source:'https://dlmm.datapi.meteora.ag/pools/'+encodeURIComponent(p.address),url:'https://app.meteora.ag/dlmm/'+encodeURIComponent(p.address)};
}
export function dexPool(p,asset,now=Date.now()){
 const row=poolBase(asset,p.chainId,[p.baseToken?.address,p.quoteToken?.address],p.pairAddress,p.dexId,now);if(!row)return null;
 return {...row,tvl:positive(p.liquidity?.usd),volume24h:positive(p.volume?.h24),source:'https://api.dexscreener.com/latest/dex/pairs/'+row.chain+'/'+encodeURIComponent(p.pairAddress),url:'https://dexscreener.com/'+row.chain+'/'+encodeURIComponent(p.pairAddress)};
}
export function staticFeePool(meta,dex,asset,now=Date.now()){
 // Fixed-fee v3 metadata comes from the protocol adapter, never from a token
 // symbol or an assumed 0.3%. Reverify both sides against live pair metadata.
 const row=poolBase(asset,meta.chain,meta.tokens,meta.address,meta.platform,now),d=dexPool(dex,asset,now);
 if(!row||!d||row.key!==d.key||positive(meta.fee_pct)===null||meta.fee_pct>10||meta.fee_pct===0)return null;
 return {...row,tvl:d.tvl,volume24h:d.volume24h,fee_apr24h:annual(d.volume24h!==null?d.volume24h*meta.fee_pct/100:null,d.tvl),fee_tier_pct:meta.fee_pct,basis:'gross-fees/tvl',estimated_fees:true,concentrated:true,source:d.source,fee_source:meta.source,url:meta.url};
}
export function llamaPool(p,asset,now=Date.now()){
 const identity=identify(asset,p.chain,p.underlyingTokens);if(!identity||p.exposure!=='multi'||p.ilRisk!=='yes')return null;
 // Llama uses UUIDs, not pool addresses. Never infer an address or auto-match an
 // LP screenshot from symbol/fee alone. Its APY fields also contain mixed units.
 return {...identity,key:'llama:'+p.pool,address:null,platform:p.project,tvl:positive(p.tvlUsd),volume24h:positive(p.volumeUsd1d),fee_apr24h:null,fee_apr7d:null,reward_apr24h:null,basis:null,reported_yield:positive(p.apy),reported_label:'показатель агрегатора (методика не унифицирована)',observed_at:new Date(now).toISOString(),provider_at:null,source:'https://defillama.com/yields/pool/'+encodeURIComponent(p.pool),url:'https://defillama.com/yields/pool/'+encodeURIComponent(p.pool),meta:String(p.poolMeta||'').slice(0,100)};
}
export function fresh(p,now=Date.now()){
 const t=Date.parse(p.observed_at);if(!Number.isFinite(t)||now-t>4*HOUR||t>now+60000)return false;
 if(p.provider_at){const s=Date.parse(p.provider_at);if(!Number.isFinite(s)||now-s>4*HOUR||s>now+60000)return false;}
 return true;
}
export function ranked(pools,asset=null,now=Date.now()){
 return pools.filter(p=>(!asset||p.asset===asset)&&p.verified&&!p.halted&&!p.warning&&fresh(p,now)&&p.basis==='gross-fees/tvl'&&p.address&&p.tvl>=10000&&p.volume24h>=1000&&positive(p.fee_apr24h)!==null&&p.fee_apr24h<=1000).sort((a,b)=>b.fee_apr24h-a.fee_apr24h||b.tvl-a.tvl||a.key.localeCompare(b.key));
}
const venueName=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const genericType=s=>/^(CLMM|DLMM|AMM|CPMM)$/i.test(String(s||'').trim())?String(s).trim().toUpperCase():null;
function poolType(p){return p.pool_type||(p.platform==='Meteora DLMM'?'DLMM':p.concentrated?'CLMM':null);}
export function positionCandidates(input,pools){
 const row={...input,platform:genericType(input.platform)?null:input.platform,pool_type:input.pool_type||genericType(input.platform)};
 let candidates=pools.filter(p=>p.verified&&p.asset?.toLowerCase()===row.symbol?.toLowerCase()&&p.address);
 if(row.network)candidates=candidates.filter(p=>p.chain===chainId(row.network));
 if(row.pool_address)candidates=candidates.filter(p=>addressKey(p.chain,p.address)===addressKey(p.chain,row.pool_address));
 else{
  if(row.platform)candidates=candidates.filter(p=>venueName(p.platform)===venueName(row.platform));
  if(row.pool_type)candidates=candidates.filter(p=>!(row.pool_type==='CLMM'&&p.concentrated===false)&&(!poolType(p)||poolType(p)===row.pool_type));
  if(positive(row.fee_tier_pct)!==null)candidates=candidates.filter(p=>positive(p.fee_tier_pct)!==null&&Math.abs(p.fee_tier_pct-row.fee_tier_pct)<0.000001);
 }
 const unique=new Map();for(const p of candidates)if(!unique.has(p.key)||(!unique.get(p.key).basis&&p.basis))unique.set(p.key,p);
 return [...unique.values()].sort((a,b)=>(b.tvl||0)-(a.tvl||0)||a.key.localeCompare(b.key));
}
export function resolvePosition(row,pools){
 const candidates=positionCandidates(row,pools),context=row.pool_address||(row.network&&row.platform&&!genericType(row.platform));
 return {pool:context&&candidates.length===1?candidates[0]:null,candidates:candidates.slice(0,10)};
}
const venueKey=p=>candidateToken({key:venueName(p.platform)+'.'+p.chain});
export function venueSuggestions(rows,pools){
 const groups=new Map();
 for(const row of rows){
  if(resolvePosition(row,pools).pool||row.pool_address)continue;
  const choices=positionCandidates(row,pools),keys=new Set(choices.map(venueKey));
  for(const key of keys){const matches=choices.filter(p=>venueKey(p)===key);if(matches.length!==1)continue;
   const p=matches[0],g=groups.get(key)||{key,platform:p.platform,network:p.network,count:0};g.count++;groups.set(key,g);
  }
 }
 return [...groups.values()].sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key));
}
export function applyVenue(rows,pools,key){
 return rows.map(input=>{
  const row=normalizePosition(input);if(resolvePosition(row,pools).pool||row.pool_address)return row;
  const choices=positionCandidates(row,pools).filter(p=>venueKey(p)===key);
  return choices.length===1?withPool(row,choices[0]):row;
 });
}
export function withPool(row,pool){return {...normalizePosition(row),platform:pool.platform,network:pool.network,pool_address:pool.address,pool_type:poolType(pool)||row.pool_type||null};}
// Stable callback ID: a market refresh must not change the meaning of a button.
// Callers reject collisions, stale imports and candidates that no longer match.
export function candidateToken(pool){let h=2166136261;for(const c of pool.key)h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0).toString(16);}
export function comparison(row,pools,now=Date.now()){
 const current=resolvePosition(row,pools).pool,best=ranked(pools,row.symbol,now)[0]||null;
 if(!current||!best||!fresh(current,now)||current.basis!==best.basis||positive(current.fee_apr24h)===null)return {current,best,delta:null,monthly:null};
 const delta=Math.max(0,best.fee_apr24h-current.fee_apr24h),capital=positive(row.capital_usd);
 return {current,best,delta,monthly:capital!==null?capital*delta/100*30/365:null,cross_chain:current.chain!==best.chain};
}
export function normalizePosition(r){
 const text=(v,n=80)=>typeof v==='string'?v.trim().slice(0,n):null;
 const row={symbol:text(r.symbol,24),network:text(r.network,32),platform:text(r.platform,40),pool_address:text(r.pool_address,100),capital_usd:positive(r.capital_usd),shown_rate:positive(r.shown_rate),rate_type:['APR','APY'].includes(r.rate_type)?r.rate_type:null,rate_window:text(r.rate_window,40),rate_scope:text(r.rate_scope,40),range_status:['in','out','unknown'].includes(r.range_status)?r.range_status:'unknown',range_lower:positive(r.range_lower),range_upper:positive(r.range_upper),fee_tier_pct:positive(r.fee_tier_pct),issue:text(r.issue,160)};
 row.pool_type=genericType(r.pool_type)||genericType(row.platform);
 row.captured_at=typeof r.captured_at==='string'&&Number.isFinite(Date.parse(r.captured_at))?new Date(r.captured_at).toISOString():null;
 if(genericType(row.platform))row.platform=null;
 if(row.capital_usd>1e12)row.capital_usd=null;
 if(row.pool_address&&!/^(?:0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})|[1-9A-HJ-NP-Za-km-z]{32,44}|[A-Za-z0-9_-]{48})$/.test(row.pool_address))row.pool_address=null;
 return row;
}
export function correctPosition(rows,text){
 const match=text.match(/^\/poolfix(?:@\w+)?\s+(\d+)\s+(.+)$/iu);if(!match)return null;
 const index=Number(match[1])-1;if(index<0||index>=rows.length)throw Error('lp_row_missing');
 if(/^(удалить|delete)$/iu.test(match[2]))return rows.filter((_,i)=>i!==index);
 const fields={актив:'symbol',asset:'symbol',сеть:'network',chain:'network',площадка:'platform',platform:'platform',пул:'pool_address',pool:'pool_address',сумма:'capital_usd',capital:'capital_usd',комиссия:'fee_tier_pct',fee:'fee_tier_pct'};
 const edits=[...match[2].matchAll(/([a-zа-я]+)=([^=]+?)(?=\s+[a-zа-я]+=|$)/giu)];if(!edits.length)throw Error('lp_fix_format');
 const next=rows.map(r=>({...r}));for(const e of edits){const field=fields[e[1].toLowerCase()];if(!field)throw Error('lp_fix_format');next[index][field]=['capital_usd','fee_tier_pct'].includes(field)?e[2].trim().replace(',','.'):e[2].trim();}
 next[index]=normalizePosition(next[index]);return next;
}
