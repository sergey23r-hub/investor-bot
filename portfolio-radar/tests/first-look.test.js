import test from 'node:test';
import assert from 'node:assert/strict';
import {Radar} from '../src/app.js';
import {cachedMarket,dailyQuoteKey,rememberQuote} from '../src/first-look.js';
import {dailyResearchKey,newsDay} from '../src/daily.js';
import {entitledPortfolio} from '../src/freemium.js';

const now=new Date(),yesterday=new Date(+now-86400000),iso=now.toISOString();
const asset={key:'isin:RU0000000001',isin:'RU0000000001',provider:'moex',provider_id:'EX',name:'Example',symbol:'EX',kind:'stock',currency:'RUB',quantity:'10',verified:true};
const quote={status:'ok',price:150,currency:'RUB',change_pct:1,as_of:iso};
const news={status:'ok',items:[{fact:'Saved issuer announcement',relevance:'Issuer results',url:'https://issuer.example/news',published_at:yesterday.toISOString(),event_date:yesterday.toISOString()}],events:[],checked_at:yesterday.toISOString(),window_since:new Date(+yesterday-86400000).toISOString()};
const paid={tier:'trial',freemium:true,allowed:true,asset_limit:500};
function fixture(users=[42]){
 const cache=new Map(),jobs=new Map(),reports=[],outbox=[],events=[],reads=[],ledgers=users.map(user_id=>({user_id,job_id:user_id+1000,state:'queued'}));let searches=0,quotes=0,sends=0;
 const match=(row,q)=>Object.entries(q||{}).every(([k,v])=>['limit','order','select','offset'].includes(k)||String(v).startsWith('eq.')?['limit','order','select','offset'].includes(k)||String(row[k])===String(v).slice(3):String(v).startsWith('lte.')?String(row[k])<=String(v).slice(4):true);
 const db={get:async(table,q={})=>{
  reads.push({table,q});
  if(table==='pr_users')return [{chat_id:Number(q.chat_id.slice(3)),subscribed:true,timezone:'Europe/Moscow',digest_time:'22:00:00'}];
  if(table==='pr_accounts')return [{id:'account-'+q.user_id,name:'Personal',updated_at:iso,positions:[asset]}];
  if(table==='pr_initial_reports')return ledgers.filter(r=>match(r,q));
  if(table==='pr_cache'){if(q.key.startsWith('eq.'))return cache.has(q.key.slice(3))?[cache.get(q.key.slice(3))]:[];const keys=JSON.parse('['+q.key.slice(4,-1)+']');return keys.flatMap(k=>cache.has(k)?[cache.get(k)]:[]);}
  if(table==='pr_jobs')return [...jobs.values()].filter(r=>match(r,q));
  if(table==='pr_reports')return reports.filter(r=>match(r,q));
  if(table==='pr_outbox')return structuredClone(outbox.filter(r=>match(r,q)).slice(0,q.limit||outbox.length));
  throw Error(table);
 },post:async(table,body,_q,prefer='')=>{
  if(table==='pr_cache'){if(!cache.has(body.key)||!prefer.includes('ignore-duplicates'))cache.set(body.key,structuredClone(body));return [];}
  if(table==='pr_reports'){const old=reports.find(r=>r.user_id===body.user_id&&r.kind===body.kind&&r.service_day===body.service_day);if(old)Object.assign(old,structuredClone(body));else reports.push({id:crypto.randomUUID(),...structuredClone(body)});return [];}
  if(table==='pr_outbox'){if(!outbox.some(r=>r.dedup_key===body.dedup_key))outbox.push({id:outbox.length+1,state:'pending',method:'sendMessage',attempts:0,available_at:iso,...structuredClone(body)});return [];}
  if(table==='pr_product_events'){events.push(body);return [];}
  throw Error(table);
 },patch:async(table,body,q)=>{const rows=table==='pr_initial_reports'?ledgers:table==='pr_outbox'?outbox:table==='pr_jobs'?[...jobs.values()]:[];const selected=rows.filter(r=>match(r,q));selected.forEach(r=>Object.assign(r,structuredClone(body)));return selected;}};
 const radar=new Radar(db);radar.billing.access=async()=>paid;radar.telegram=async()=>({message_id:++sends});
 radar.queue=async(job_key,kind,payload)=>{if(!jobs.has(job_key))jobs.set(job_key,{id:jobs.size+1,job_key,kind,payload,attempts:1,state:'pending'});};
 radar.providers={news:async()=>{searches++;return {...news,checked_at:iso};},quote:async()=>{quotes++;return quote;},memo:async(key,ttl,fn)=>{if(cache.has(key))return cache.get(key).value;const value=await fn();cache.set(key,{key,value,expires_at:new Date(Date.now()+ttl*1000).toISOString()});return value;}};
 const initial=user=>({id:user+1000,user_id:user,job_key:'initial:'+user,kind:'digest',payload:{initial:true,news_as_of:iso},attempts:1});
 const put=(key,value)=>cache.set(key,{key,value,expires_at:new Date(+now+86400000).toISOString()});
 return {radar,db,cache,jobs,reports,outbox,events,reads,ledgers,initial,put,counts:()=>({searches,quotes,sends})};
}

test('a brand-new user receives yesterday shared quotes and news with dates and no new provider calls',async()=>{
 const f=fixture();f.put(dailyResearchKey(asset,yesterday),{news});f.put(dailyResearchKey({key:'market'},yesterday),{news});
 f.put(dailyQuoteKey(asset,yesterday),{...quote,as_of:yesterday.toISOString()});
 await f.radar.handleDigest(f.initial(42));
 assert.deepEqual(f.counts(),{searches:0,quotes:0,sends:0});assert.equal(f.reports[0].snapshot.news[asset.key].items[0].fact,news.items[0].fact);
 assert.equal(f.reports[0].snapshot.quotes[asset.key].price,150);assert.equal(f.ledgers[0].cached_assets,1);assert.equal(f.ledgers[0].state,'ready');
 await f.radar.flush();assert.equal(f.counts().sends,1);assert.equal(f.events.filter(e=>e.event==='initial_delivered').length,1);
 await f.radar.handleDigest(f.initial(42));assert.equal(f.outbox.length,1);assert.equal(f.counts().quotes,0);
});

test('two cold first portfolios share research and quote cache and each get one automatic report',async()=>{
 const f=fixture([42,43]),first=f.initial(42),second=f.initial(43);
 assert.equal(await f.radar.handleDigest(first),'deferred');assert.equal(await f.radar.handleDigest(second),'deferred');
 assert.equal(f.jobs.size,2);for(const job of f.jobs.values()){assert.equal(job.payload.asset.quantity,undefined);await f.radar.handleResearch(job);job.state='done';}
 await f.radar.handleDigest(first);await f.radar.handleDigest(second);await f.radar.flush();
 assert.deepEqual(f.counts(),{searches:2,quotes:1,sends:2});assert.ok(f.cache.has(dailyQuoteKey(asset)));assert.equal(f.reports.length,2);
 assert.ok(f.ledgers.every(l=>l.state==='ready'));assert.equal(f.events.filter(e=>e.event==='initial_ready').length,2);
});

test('forged initial flags or a mismatching reservation cannot start providers',async()=>{
 const f=fixture();for(const job of [{...f.initial(42),id:999},{...f.initial(42),job_key:'manual:42'},{...f.initial(42),job_key:'daily:42:'+newsDay(now),payload:{initial:true,daily:true}},f.initial(99)])await f.radar.handleDigest(job);
 assert.equal(f.jobs.size,0);assert.deepEqual(f.counts(),{searches:0,quotes:0,sends:0});
 assert.equal(f.reads.some(r=>r.table==='pr_accounts'),false);
});

test('shared fallback prefers today but skips yesterday failures and rejects stale quotes',async()=>{
 const f=fixture();f.put(dailyResearchKey(asset,yesterday),{news:{status:'unavailable',items:[]}});
 f.put(dailyQuoteKey(asset,yesterday),{...quote,as_of:new Date(+now-8*86400000).toISOString()});
 let result=await cachedMarket(f.db,[asset],now);assert.equal(result.cache_keys[asset.key],undefined);assert.deepEqual(result.quotes,{});
 f.put(dailyResearchKey(asset,now),{news:{...news,checked_at:iso,items:[{...news.items[0],fact:'Today'}]}});
 f.put(dailyResearchKey(asset,yesterday),{news});f.put(dailyQuoteKey(asset,now),quote);
 result=await cachedMarket(f.db,[asset],now);assert.equal(result.news[asset.key].items[0].fact,'Today');assert.equal(result.cache_keys[asset.key],dailyResearchKey(asset,now));
});

test('free first look only asks the cache for its first three canonical assets',async()=>{
 const f=fixture(),accounts=[{name:'Main',positions:Array.from({length:20},(_,i)=>({...asset,isin:null,key:'asset-'+i}))}];
 const view=entitledPortfolio(accounts,{tier:'free',asset_limit:3});await cachedMarket(f.db,view.assets,now);
 const queries=JSON.stringify(f.reads);assert.match(queries,/asset-2/);assert.doesNotMatch(queries,/asset-(?:[3-9]|1\d)/);
});

test('failed quotes never replace a reusable shared quote',async()=>{
 const f=fixture();await rememberQuote(f.db,asset,quote,now);await rememberQuote(f.db,asset,{status:'unavailable',price:null},now);
 assert.equal(f.cache.get(dailyQuoteKey(asset,now)).value.price,150);
});
