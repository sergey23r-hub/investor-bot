import {compactAsset,raydiumPool,orcaPool,meteoraPool,dexPool,llamaPool,staticFeePool,identify,HOUR,chainId,positive} from './lp-data.js';
import {collectRangeStates} from './lp-chain-state.js';

const HOSTS=new Set(['api.xstocks.fi','api.dexscreener.com','api-v3.raydium.io','api.orca.so','dlmm.datapi.meteora.ag','yields.llama.fi','subgraph-api.mantle.xyz','blaze.nest.aegas.it','api.mainnet-beta.solana.com']);
export async function publicJson(url,{maxBytes=18000000,timeout=14000,body}={}){
 const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password)throw Error('lp_source_not_allowed');
 const r=await fetch(u,{signal:AbortSignal.timeout(timeout),redirect:'error',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
 if(!r.ok)throw Error('lp_source_http_'+r.status);
 if(Number(r.headers.get('content-length'))>maxBytes)throw Error('lp_source_too_large');
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('lp_source_too_large');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
const canonical=s=>String(s||'').trim().replace(/^w(?=[A-Z].*x$)/,'').replace(/x$/i,'').toUpperCase()+'x';
export class PoolProvider{
 constructor(db,get=publicJson){this.db=db;this.get=get;}
 async rangeStates(symbol,pools){return this.once('clmm-state-v3:'+canonical(symbol),1,()=>collectRangeStates(pools,this.get));}
 async once(key,hours,fn,now=Date.now()){
  const bucket=new Date(Math.floor(now/(hours*HOUR))*hours*HOUR).toISOString();
  const reserved=await this.db.post('pr_lp_fetches',{cache_key:key,bucket,state:'working'},{on_conflict:'cache_key,bucket'},'resolution=ignore-duplicates,return=representation');
  if(!reserved?.length){const old=(await this.db.get('pr_lp_fetches',{cache_key:'eq.'+key,bucket:'eq.'+bucket,limit:1}))[0];return old?.state==='done'?old.value:{error:old?.state==='working'?'source_pending':'source_unavailable'};}
  try{const value=await fn();await this.db.patch('pr_lp_fetches',{state:'done',value},{cache_key:'eq.'+key,bucket:'eq.'+bucket});return value;}
  catch(e){const code=/^lp_source_/.test(e.message)?e.message:'source_unavailable';await this.db.patch('pr_lp_fetches',{state:'failed',value:{error:code}},{cache_key:'eq.'+key,bucket:'eq.'+bucket});return {error:code};}
 }
 async asset(symbol){
  const key=canonical(symbol);if(!/^[A-Z0-9.\-]{1,20}x$/.test(key))return null;
  const result=await this.once('registry:'+key,24,async()=>{
   const a=compactAsset(await this.get('https://api.xstocks.fi/api/v2/public/assets/'+encodeURIComponent(key),{maxBytes:150000}));
   if(!a||a.symbol.toLowerCase()!==key.toLowerCase())throw Error('lp_source_identity');return {asset:a,checked_at:new Date().toISOString()};
  });return result.asset||null;
 }
 async inventory(){
  return this.once('llama-inventory',6,async()=>{
   const data=await this.get('https://yields.llama.fi/pools');if(!Array.isArray(data.data))throw Error('lp_source_schema');
   return {pools:data.data.filter(p=>/USDC/i.test(p.symbol)&&/X(?:-|$)/i.test(p.symbol)&&p.underlyingTokens?.length===2).map(p=>({pool:p.pool,chain:p.chain,project:p.project,symbol:p.symbol,tvlUsd:p.tvlUsd,volumeUsd1d:p.volumeUsd1d,apy:p.apy,underlyingTokens:p.underlyingTokens,exposure:p.exposure,ilRisk:p.ilRisk,poolMeta:p.poolMeta})),checked_at:new Date().toISOString()};
  });
 }
 async evmMetadata(){
  const fluxion='https://subgraph-api.mantle.xyz/api/public/346c94bd-5254-48f7-b71c-c7fa427ae0a8/subgraphs/uni-v3/v0.0.1/gn',nest='https://blaze.nest.aegas.it/api/defillama/pools';
  const results=await Promise.all([
   this.once('fluxion-metadata',6,async()=>{
    const pools=[];let partial=false;
    for(let skip=0;skip<3000;skip+=1000){
     const r=await this.get(fluxion,{maxBytes:2000000,body:{query:`{ pools(first:1000,skip:${skip},orderBy:totalValueLockedUSD,orderDirection:desc,where:{totalValueLockedUSD_gt:"1000"}) { id feeTier token0 { id } token1 { id } } }`}});
     if(r.errors||!Array.isArray(r.data?.pools))throw Error('lp_source_schema');
     pools.push(...r.data.pools.map(p=>({address:p.id,tokens:[p.token0?.id,p.token1?.id],chain:'mantle',platform:'Fluxion',fee_pct:positive(p.feeTier)!==null?Number(p.feeTier)/10000:null,source:fluxion,url:'https://app.fluxion.network/pool/'+p.id})));
     if(r.data.pools.length<1000)break;if(skip===2000)partial=true;
    }return {metadata:pools,partial};
   }),
   this.once('nest-metadata',6,async()=>{
    const r=await this.get(nest,{maxBytes:2000000});if(!Array.isArray(r))throw Error('lp_source_schema');
    return {metadata:r.filter(p=>p.poolType==='v3'&&/^0x[0-9a-f]{40}-hyperevm$/i.test(p.pool)&&/^\d+(?:\.\d+)?%$/.test(p.poolMeta||'')).map(p=>({address:p.pool.slice(0,42),tokens:p.underlyingTokens,chain:'hyperevm',platform:'Nest',fee_pct:Number(p.poolMeta.slice(0,-1)),source:nest,url:'https://app.usenest.xyz/liquidity'}))};
   })
  ]);
  return {metadata:results.flatMap(r=>r.metadata||[]),coverage:results.map((r,i)=>({source:i?'Nest':'Fluxion',status:r.error?'unavailable':r.partial?'partial':'ok'}))};
 }
 async collect(symbol){
  const asset=await this.asset(symbol),started=new Date().toISOString();
  if(!asset)return {symbol:canonical(symbol),asset:null,pools:[],coverage:[{source:'xStocks',status:'unavailable'}],checked_at:started};
  const coverage=[],rows=[],tasks=[];
  const add=(name,fn)=>tasks.push(async()=>{try{const r=await fn();coverage.push({source:name,status:r.error?'unavailable':r.partial?'partial':'ok',detail:r.error||null});if(r.pools)rows.push(...r.pools);}catch{coverage.push({source:name,status:'unavailable'});}});
  // DEX discovery covers every registered chain and official wrapper for this
  // asset. It is cached per contract, never per user, and carries no invented APR.
  for(const d of asset.deployments){
   if(!d.usdc.length){coverage.push({source:d.network,status:'no_verified_usdc'});continue;}
   for(const address of [d.address,...d.wrappers])add('DEX Screener · '+d.network+(address!==d.address?' · wrapper':''),()=>this.once('discovery:'+d.chain+':'+address,6,async()=>{
    const raw=await this.get('https://api.dexscreener.com/token-pairs/v1/'+d.chain+'/'+encodeURIComponent(address),{maxBytes:2000000});
    if(!Array.isArray(raw))throw Error('lp_source_schema');
    return {pools:raw.map(p=>dexPool(p,asset)).filter(Boolean)};
   }));
  }
  const sol=asset.deployments.find(d=>d.chain==='solana'&&d.usdc.length);
  if(sol){
   add('Raydium',()=>this.once('raydium:'+asset.symbol,1,async()=>{
    const pools=[];let partial=false;
    for(let page=1;page<=5;page++){
     const query=new URLSearchParams({mint1:sol.address,mint2:sol.usdc[0],poolType:'all',poolSortField:'liquidity',sortType:'desc',pageSize:'100',page:String(page)});
     const r=await this.get('https://api-v3.raydium.io/pools/info/mint?'+query,{maxBytes:3000000});
     if(r.success!==true||!Array.isArray(r.data?.data))throw Error('lp_source_schema');
     pools.push(...r.data.data.map(p=>raydiumPool(p,asset)).filter(Boolean));
     if(!r.data.hasNextPage)break;if(page===5)partial=true;
    }return {pools,partial};
   }));
   add('Orca',()=>this.once('orca:'+asset.symbol,1,async()=>{
    const pools=[];let next=null,partial=false;
    for(let page=0;page<5;page++){
     const q=new URLSearchParams({tokensBothOf:sol.address+','+sol.usdc[0],size:'100',stats:'24h,7d',sortBy:'tvl',sortDirection:'desc'});if(next)q.set('next',next);
     const r=await this.get('https://api.orca.so/v2/solana/pools?'+q,{maxBytes:3000000});
     if(!Array.isArray(r.data))throw Error('lp_source_schema');pools.push(...r.data.map(p=>orcaPool(p,asset)).filter(Boolean));
     next=r.meta?.cursor?.next||r.meta?.next;if(!next)break;if(page===4)partial=true;
    }return {pools,partial};
   }));
   add('Meteora DLMM',()=>this.once('meteora:'+asset.symbol,1,async()=>{
    const pools=[];let partial=false;
    for(let page=1;page<=5;page++){
     const q=new URLSearchParams({query:sol.address,page:String(page),page_size:'100',sort_by:'tvl:desc'});
     const r=await this.get('https://dlmm.datapi.meteora.ag/pools?'+q,{maxBytes:3000000});
     if(!Array.isArray(r.data))throw Error('lp_source_schema');pools.push(...r.data.map(p=>meteoraPool(p,asset)).filter(Boolean));
     if(page>=r.pages)break;if(page===5)partial=true;
    }return {pools,partial};
   }));
  }
  add('DeFiLlama',async()=>{const r=await this.inventory();return {error:r.error,pools:(r.pools||[]).map(p=>llamaPool(p,asset,Date.parse(r.checked_at))).filter(Boolean)};});
  // Conservative concurrency: no retry loops against rate-limited providers.
  let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<tasks.length)await tasks[cursor++]();}));
  if(asset.deployments.some(d=>['mantle','hyperevm'].includes(d.chain))){
   const meta=await this.evmMetadata();coverage.push(...meta.coverage);
   const candidates=meta.metadata.filter(p=>identify(asset,p.chain,p.tokens));
   for(let i=0;i<candidates.length;i+=3)await Promise.all(candidates.slice(i,i+3).map(async m=>{
    const r=await this.once('evm-pool:'+m.chain+':'+m.address,1,async()=>{
     const data=await this.get('https://api.dexscreener.com/latest/dex/pairs/'+m.chain+'/'+m.address,{maxBytes:2000000});
     if(data.pairs===null)return {pools:[],not_indexed:true};
     if(!Array.isArray(data.pairs))throw Error('lp_source_schema');
     return {pools:data.pairs.map(d=>staticFeePool(m,d,asset)).filter(Boolean)};
    });if(r.not_indexed)coverage.push({source:m.platform+' · '+m.address,status:'not_indexed'});else if(r.pools)rows.push(...r.pools);else coverage.push({source:m.platform+' · '+m.address,status:'unavailable'});
   }));
  }
  const map=new Map();for(const p of rows){const old=map.get(p.key);if(!old||p.basis&&!old.basis||p.basis===old.basis&&p.observed_at>old.observed_at)map.set(p.key,p);}
  const pools=[...map.values()],targets=pools.filter(p=>p.chain==='solana'&&p.concentrated&&['Raydium','Orca'].includes(p.platform));
  if(targets.length){
   const result=await this.rangeStates(asset.symbol,targets);let usable=0;
   for(const p of targets){p.clmm_state=result.states?.[p.key]||{status:'unavailable',reason:result.error||'range_data_missing'};if(p.clmm_state.status==='ok')usable++;}
   coverage.push({source:'Диапазоны Raydium / Orca · Solana',status:usable===targets.length?'ok':usable?'partial':'unavailable',checked:usable,total:targets.length});
  }
  return {symbol:asset.symbol,asset,pools,coverage,checked_at:new Date().toISOString(),schema_version:4};
 }
}
export {canonical as canonicalXStock};

