import {dailyResearchKey,quoteCacheKey,newsDay,newsIdentity} from './daily.js';

const WEEK=7*86400000;
export const dailyQuoteKey=(asset,now=new Date())=>'quote:daily:v1:'+newsDay(now)+':'+newsIdentity(asset);
export const fxCacheKey=(now=new Date())=>'fx:daily:v1:'+newsDay(now);
export function usableQuote(q,now=new Date()){
 const age=+now-Date.parse(q?.as_of);
 return q?.status==='ok'&&q.price!==null&&q.price!==undefined&&Number.isFinite(Number(q.price))&&age>=-86400000&&age<=WEEK;
}
export async function rememberQuote(db,asset,quote,now=new Date()){
 if(!usableQuote(quote,now))return;
 await db.post('pr_cache',{key:dailyQuoteKey(asset,now),value:quote,expires_at:new Date(+now+WEEK).toISOString()},{on_conflict:'key'},'resolution=ignore-duplicates,return=minimal');
}
// Only shared market records are read. Portfolio positions never come from another user.
export async function cachedMarket(db,assets,now=new Date(),previous=null){
 const dates=Array.from({length:7},(_,i)=>new Date(+now-i*86400000)),all=[{key:'market'},...assets];
 const assetKeys=all.flatMap(a=>{
  const research=dates.map(d=>dailyResearchKey(a,d));
  const quotes=a.key==='market'?[]:[quoteCacheKey(a,now),quoteCacheKey(a,new Date(+now-15*60000)),...dates.map(d=>dailyQuoteKey(a,d))];
  return [...research,...quotes];
 });
 const keys=[...new Set([...dates.map(fxCacheKey),...assetKeys])];
 const cache=[];
 for(let offset=0;offset<keys.length;offset+=200){
  const tasks=[];for(let i=offset;i<Math.min(offset+200,keys.length);i+=50)tasks.push(db.get('pr_cache',{key:'in.('+keys.slice(i,i+50).map(k=>'"'+k.replaceAll('"','\\"')+'"').join(',')+')'}));
  const batches=await Promise.all(tasks);for(const rows of batches)cache.push(...rows);
 }
 const byKey=new Map(cache.filter(c=>Date.parse(c.expires_at)>+now).map(c=>[c.key,c.value]));
 const previousAge=+now-Date.parse(previous?.as_of),saved=previousAge>=0&&previousAge<=WEEK?previous:null;
 const result={quotes:{},news:{},facts:{},cache_keys:{}},oldDates=[];
 const note=date=>{if(Number.isFinite(Date.parse(date))&&newsDay(new Date(date))<newsDay(now))oldDates.push(new Date(date).toISOString());};
 for(const a of all){
  const candidates=dates.map(d=>({key:dailyResearchKey(a,d),date:d,value:byKey.get(dailyResearchKey(a,d))})).filter(c=>c.value);
  const chosen=candidates.find(c=>c.value.news?.status==='ok')||candidates[0];
  const previousNews=a.key==='market'?saved?.market:saved?.news?.[a.key];
  const n=chosen?.value.news||previousNews,f=chosen?.value.facts||saved?.facts?.[a.key];
  if(chosen){if(n?.status==='ok'||newsDay(chosen.date)===newsDay(now))result.cache_keys[a.key]=chosen.key;if(n?.status==='ok'||f?.status==='ok')note(n?.checked_at||chosen.date.toISOString());}
  else if(n?.status==='ok'||f?.status==='ok')note(saved.as_of);
  if(a.key==='market'){
   result.market=n;result.fx=chosen?.value.facts?.fx||dates.map(d=>byKey.get(fxCacheKey(d))).find(f=>f?.status==='ok')||saved?.fx;continue;
  }
  if(n)result.news[a.key]=n;
  if(f||n)result.facts[a.key]={...(f||{}),sector:f?.sector||n?.profile?.sector||null,issuer_name:f?.issuer_name||n?.profile?.issuer_name||null,profile_source:f?.profile_source||n?.profile?.url||null};
  const quotes=[byKey.get(quoteCacheKey(a,now)),byKey.get(quoteCacheKey(a,new Date(+now-15*60000))),...dates.map(d=>byKey.get(dailyQuoteKey(a,d))),saved?.quotes?.[a.key]];
  const q=quotes.find(q=>usableQuote(q,now));if(q){result.quotes[a.key]=q;note(q.as_of);if(q===saved?.quotes?.[a.key])note(saved.as_of);}
 }
 if(oldDates.length)result.reused_market_as_of=oldDates.sort()[0];
 else if(saved&&assets.some(a=>result.quotes[a.key]===saved.quotes?.[a.key]&&result.quotes[a.key]))result.reused_market_as_of=saved.as_of;
 return result;
}
