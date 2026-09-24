import {DAY,FINAM_FEEDS,CBR_SURVEY,parseFeed,parseOpinion,consensus,parseSurvey,parseBond,parseFunding,PERPETUALS} from './outlook-data.js';
import {newsDay,newsIdentity} from './daily.js';
import {cachedMarket,rememberQuote,fxCacheKey,usableQuote} from './first-look.js';
import {parseCbr} from './asset-facts.js';

const HOSTS=new Set(['www.finam.ru','www.cbr.ru','iss.moex.com','fapi.binance.com','api.coingecko.com']);
export async function publicText(url){
 const u=new URL(url);if(u.protocol!=='https:'||!HOSTS.has(u.hostname)||u.username||u.password)throw new Error('source_not_allowed');
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(9000),headers:{Accept:'application/json,application/rss+xml,application/xml,text/html'}});
 if(!r.ok)throw new Error('source_http_'+r.status);
 const reader=r.body.getReader(),chunks=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>2500000)throw new Error('source_too_large');chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(total);let i=0;for(const c of chunks){bytes.set(c,i);i+=c.length;}return new TextDecoder().decode(bytes);
}
const safeError=e=>/^source_(http_\d{3}|too_large|not_allowed)$/.test(e?.message||'')?e.message:'source_unavailable';
const rows=b=>b?.columns&&Array.isArray(b.data)?b.data.map(r=>Object.fromEntries(b.columns.map((c,i)=>[c.toLowerCase(),r[i]]))):[];
export function moexOutlookQuote(data,asset,now){
 const securities=rows(data.securities).filter(s=>s.secid===asset.provider_id&&(!asset.isin||s.isin===asset.isin));
 const m=rows(data.marketdata).filter(m=>m.secid===asset.provider_id&&securities.some(s=>s.boardid===m.boardid)&&Number(m.last)>0).sort((a,b)=>String(b.systime).localeCompare(String(a.systime)))[0];
 const s=securities.find(s=>s.boardid===m?.boardid);if(!m||!s)return null;
 const as_of=String(m.systime||m.tradedate||'').replace(' ','T')+(String(m.systime||'').includes('T')?'':'+03:00');
 const q={status:'ok',price:Number(m.last),currency:asset.kind==='bond'?'% номинала':s.currencyid==='SUR'?'RUB':s.currencyid,as_of,url:'https://www.moex.com/ru/issue.aspx?code='+encodeURIComponent(asset.provider_id)};
 if(asset.kind==='bond'&&Number(s.facevalue)>0&&Number.isFinite(Number(s.accruedint))){q.unit_price=Number(s.facevalue)*q.price/100+Number(s.accruedint);q.unit_currency=s.faceunit==='SUR'?'RUB':s.faceunit;}
 return usableQuote(q,now)?q:null;
}
export class OutlookProvider{
 constructor(db,{fetcher=publicText,now=new Date()}={}){this.db=db;this.fetcher=fetcher;this.now=now;this.day=newsDay(now);}
 // A durable reservation precedes network I/O. Failed and interrupted attempts are
 // also cached for the day; user clicks cannot bypass this gate or enqueue work.
 async once(key,loader){
  const query={source_key:'eq.'+key,service_day:'eq.'+this.day,limit:1};
  const old=(await this.db.get('pr_outlook_sources',query))[0];if(old)return old;
  const created=await this.db.post('pr_outlook_sources',{source_key:key,service_day:this.day,status:'pending'},{on_conflict:'source_key,service_day'},'resolution=ignore-duplicates,return=representation');
  if(!created?.length)return (await this.db.get('pr_outlook_sources',query))[0]||{status:'pending'};
  let record;try{const data=await loader();record={status:data===null?'empty':'ok',data};}catch(e){record={status:'unavailable',error:safeError(e),data:null};}
  await this.db.patch('pr_outlook_sources',record,{source_key:'eq.'+key,service_day:'eq.'+this.day});return record;
 }
 async collect(asset,previous=null){
  const key=newsIdentity(asset),now=this.now,source_statuses={};
  const result={asset_key:key,checked_at:now.toISOString(),opinions:[],consensus:null,quote:null};
  const [macro,fx,market]=await Promise.all([
   this.once('cbr:survey',async()=>parseSurvey(await this.fetcher(CBR_SURVEY),now)),
   this.once('cbr:fx',async()=>parseCbr(await this.fetcher('https://www.cbr.ru/scripts/XML_daily.asp'))),
   cachedMarket(this.db,[asset],now)
  ]);
  source_statuses.macro=macro.status;source_statuses.fx=fx.status;
  result.macro=macro.data||null;result.fx=fx.data||market.fx||null;
  if(fx.data)await this.db.post('pr_cache',{key:fxCacheKey(now),value:fx.data,expires_at:new Date(+now+7*DAY).toISOString()},{on_conflict:'key'},'resolution=ignore-duplicates,return=minimal');
  result.quote=market.quotes[key]||null;
  if(asset.provider==='moex'&&asset.verified){
   const source=await this.once('moex:'+key,async()=>{
    const d=JSON.parse(await this.fetcher('https://iss.moex.com/iss/engines/stock/markets/'+(asset.kind==='bond'?'bonds':'shares')+'/securities/'+encodeURIComponent(asset.provider_id)+'.json?iss.meta=off'));
    return {quote:moexOutlookQuote(d,asset,now),bond:asset.kind==='bond'?parseBond(d,asset,now):null};
   });source_statuses.moex=source.status;result.bond=source.data?.bond||null;result.quote ||= source.data?.quote||null;
  }
  if(asset.provider==='coingecko'&&asset.verified){
   if(!result.quote){const spot=await this.once('spot:'+key,async()=>{
    const d=JSON.parse(await this.fetcher('https://api.coingecko.com/api/v3/simple/price?ids='+encodeURIComponent(asset.provider_id)+'&vs_currencies=usd&include_last_updated_at=true'))?.[asset.provider_id];
    if(!d?.last_updated_at||!Number.isFinite(d.usd)||d.usd<=0)return null;
    const q={status:'ok',price:d.usd,currency:'USD',as_of:new Date(d.last_updated_at*1000).toISOString(),url:'https://www.coingecko.com/en/coins/'+encodeURIComponent(asset.provider_id)};return usableQuote(q,now)?q:null;
   });source_statuses.spot=spot.status;result.quote=spot.data;}
   if(PERPETUALS[asset.provider_id]){const crypto=await this.once('funding:'+key,async()=>parseFunding(JSON.parse(await this.fetcher('https://fapi.binance.com/fapi/v1/premiumIndex?symbol='+PERPETUALS[asset.provider_id])),asset,now));result.crypto=crypto.data;source_statuses.funding=crypto.status;}
  }
  // Only public, commercially reusable RSS is consumed. Access-denied article
  // pages and feeds licensed for personal use are deliberately not retried.
  if(asset.verified&&['stock','fund','crypto'].includes(asset.kind)){
   const feeds=await Promise.all(FINAM_FEEDS.map((url,i)=>this.once('finam:feed:'+i,async()=>parseFeed(await this.fetcher(url),now))));
   const opinions=feeds.flatMap((f,i)=>{source_statuses['finam'+i]=f.status;return (f.data||[]).flatMap(item=>{const o=parseOpinion(asset,item,{text:item.description,author:item.author},now);return o?[o]:[];});});
   const retained=(previous?.opinions||[]).filter(o=>o.asset_key===key&&Number.isFinite(Date.parse(o.published_at))&&+now-Date.parse(o.published_at)<90*DAY&&Date.parse(o.published_at)<=+now);
   const latest=new Map();for(const o of [...opinions,...retained].sort((a,b)=>b.published_at.localeCompare(a.published_at))){const id=o.house+'|'+o.currency+'|'+o.horizon;if(!latest.has(id))latest.set(id,o);}
   result.opinions=[...latest.values()].slice(0,40);result.consensus=consensus(result.opinions,now);
  }
  if(result.quote)await rememberQuote(this.db,asset,result.quote,now);
  result.source_statuses=source_statuses;
  const context=result.bond||result.crypto||(result.macro&&(['bond','fund','cash','currency'].includes(asset.kind)||asset.provider==='cash'));
  result.status=result.consensus?'consensus':result.opinions.length?'opinions':context?'context':'unavailable';
  return result;
 }
}
