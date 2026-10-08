// Layouts: raydium-io/raydium-clmm states/{pool,config}.rs and
// orca-so/whirlpools programs/whirlpool/src/state/whirlpool.rs.
// Public account reads only; no wallet, signing, or transaction submission.
const RAY='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',ORCA='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RPC='https://api.mainnet-beta.solana.com',ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const unavailable=reason=>({status:'unavailable',reason});
function bytes(account,owner,min){
 if(!account||account.executable||account.owner!==owner||account.data?.[1]!=='base64')throw Error('range_account');
 const b=Uint8Array.from(atob(account.data[0]),c=>c.charCodeAt(0));if(b.length<min||b.length>100000)throw Error('range_account');return b;
}
function discriminator(b,expected){if(!expected.every((n,i)=>b[i]===n))throw Error('range_account_type');}
function uint(b,offset,size){let n=0n;for(let i=offset+size-1;i>=offset;i--)n=n*256n+BigInt(b[i]);return n;}
const small=(b,o,n)=>Number(uint(b,o,n));
function key(b,offset){const part=b.slice(offset,offset+32);let n=0n;for(const x of part)n=n*256n+BigInt(x);let s='';while(n){s=ALPHABET[Number(n%58n)]+s;n/=58n;}for(const x of part){if(x)break;s='1'+s;}return s;}
export function decodePoolState(pool,account){
 let b,s;
 if(pool.platform==='Raydium'){
  b=bytes(account,RAY,397);discriminator(b,[247,237,227,245,215,195,222,70]);
  if(b[389]&23)throw Error('range_pool_paused'); // deposits, withdrawals, fee collection, swaps
  s={config:key(b,9),token_a:key(b,73),token_b:key(b,105),decimals_a:b[233],decimals_b:b[234],tick_spacing:small(b,235,2),liquidity:uint(b,237,16).toString(),sqrt_price_x64:uint(b,253,16).toString(),tick_current:new DataView(b.buffer).getInt32(269,true)};
 }else if(pool.platform==='Orca'){
  b=bytes(account,ORCA,653);discriminator(b,[63,149,209,12,225,128,99,9]);
  s={token_a:key(b,101),token_b:key(b,181),tick_spacing:small(b,41,2),liquidity:uint(b,49,16).toString(),sqrt_price_x64:uint(b,65,16).toString(),tick_current:new DataView(b.buffer).getInt32(81,true),lp_fee_share:1-small(b,47,2)/10000};
 }else throw Error('range_unsupported');
 if(!((s.token_a===pool.stock_address&&s.token_b===pool.usdc_address)||(s.token_b===pool.stock_address&&s.token_a===pool.usdc_address)))throw Error('range_identity');
 if(!(Number(s.liquidity)>0)||!(Number(s.sqrt_price_x64)>0)||s.tick_spacing<1||s.tick_spacing>=32768||Math.abs(s.tick_current)>443636)throw Error('range_empty');
 return s;
}
export function decodeMint(account){
 if(![TOKEN,TOKEN22].includes(account?.owner))throw Error('range_mint');
 const b=bytes(account,account.owner,82);if(b[45]!==1||b[44]>18)throw Error('range_mint');
 if(account.owner===TOKEN&&b.length!==82)throw Error('range_mint');
 if(b.length>82){
  if(b.length<166||b[165]!==1||b.slice(82,165).some(n=>n!==0))throw Error('range_mint');
  // Metadata/authority extensions do not alter token units or swap fee math.
  // Unknown, transfer-fee, hook, scaled-amount, interest and pausable mints
  // are excluded until their economics/availability have a dedicated model.
  const allowed=new Set([3,12,18,19,20,21,22,23]);
  for(let o=166;o+2<=b.length;){const type=small(b,o,2);if(type===0)break;if(o+4>b.length)throw Error('range_mint');const len=small(b,o+2,2);if(!allowed.has(type)||o+4+len>b.length)throw Error('range_mint_extension');o+=4+len;}
 }
 return {decimals:b[44]};
}
function feeShare(account,spacing){
 const b=bytes(account,RAY,117);discriminator(b,[218,244,33,104,203,203,43,111]);
 if(small(b,51,2)!==spacing)throw Error('range_config');
 const share=1-(small(b,43,4)+small(b,53,4))/1000000;
 if(share<0||share>1)throw Error('range_config');return share;
}
async function readAccounts(addresses,get,minContextSlot){
 const r=await get(RPC,{maxBytes:1500000,timeout:10000,body:{jsonrpc:'2.0',id:1,method:'getMultipleAccounts',params:[addresses,{encoding:'base64',commitment:'confirmed',...(minContextSlot?{minContextSlot}:{})}]}});
 if(r.error||!Number.isSafeInteger(r.result?.context?.slot)||!Array.isArray(r.result?.value)||r.result.value.length!==addresses.length||r.result.context.slot<(minContextSlot||0))throw Error('lp_source_rpc');
 return {slot:r.result.context.slot,accounts:new Map(addresses.map((k,i)=>[k,r.result.value[i]]))};
}
export async function collectRangeStates(pools,get){
 const eligible=pools.filter(p=>p.chain==='solana'&&p.verified&&p.concentrated&&['Raydium','Orca'].includes(p.platform)&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.address||''));
 const states={};
 // At most 96 pool accounts per asset per hourly job. Typical assets have <20.
 // Three bounded batches leave room for config/mint accounts in each RPC read.
 for(let start=0;start<Math.min(eligible.length,96);start+=32){
  const chunk=eligible.slice(start,start+32),first=await readAccounts(chunk.map(p=>p.address),get),valid=[];
  for(const p of chunk){try{valid.push({p,s:decodePoolState(p,first.accounts.get(p.address))});}catch(e){states[p.key]=unavailable(e.message);}}
  if(!valid.length)continue;
  const addresses=[...new Set(valid.flatMap(({p,s})=>[p.address,s.token_a,s.token_b,...(s.config?[s.config]:[])]))];
  if(addresses.length>100)throw Error('lp_source_rpc_size');
  // Re-read pools with their dependencies so liquidity, fees and mint decimals
  // belong to the same confirmed slot, rather than mixing successive states.
  const second=await readAccounts(addresses,get,first.slot),observed_at=new Date().toISOString();
  for(const {p} of valid){try{
   const s=decodePoolState(p,second.accounts.get(p.address)),da=decodeMint(second.accounts.get(s.token_a)).decimals,db=decodeMint(second.accounts.get(s.token_b)).decimals;
   if(s.decimals_a!==undefined&&(s.decimals_a!==da||s.decimals_b!==db))throw Error('range_mint');
   const lp_fee_share=s.config?feeShare(second.accounts.get(s.config),s.tick_spacing):s.lp_fee_share;
   if(!(lp_fee_share>=0&&lp_fee_share<=1))throw Error('range_config');
   states[p.key]={...s,decimals_a:da,decimals_b:db,lp_fee_share,status:'ok',version:1,slot:second.slot,observed_at,source:RPC};
  }catch(e){states[p.key]=unavailable(e.message);}}
 }
 for(const p of eligible.slice(96))states[p.key]=unavailable('range_batch_limit');
 return {states};
}
