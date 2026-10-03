import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyResearchKey,quoteCacheKey} from '../src/daily.js';
import {Radar} from '../src/app.js';
const msft={key:'moex:MSFT-RM',name:'Microsoft',symbol:'MSFT-RM',isin:'US5949181045',kind:'stock',verified:true};
test('news uses a shared Moscow calendar day and ISIN, while quotes expire every 15 minutes',()=>{
 const a=new Date('2026-09-13T00:00:00Z'),b=new Date('2026-09-13T20:59:59Z'),c=new Date('2026-09-13T21:00:00Z');
 assert.equal(dailyResearchKey(msft,a),dailyResearchKey({...msft,key:'other:MSFT',symbol:'MSFT'},b));
 assert.notEqual(dailyResearchKey(msft,b),dailyResearchKey(msft,c));
 assert.notEqual(quoteCacheKey(msft,a),quoteCacheKey(msft,b));
 assert.notEqual(dailyResearchKey({key:'cg:one',provider:'coingecko',provider_id:'one',symbol:'ABC'},a),dailyResearchKey({key:'cg:two',provider:'coingecko',provider_id:'two',symbol:'ABC'},a));
});
test('100 portfolios with the same asset enqueue one asset analysis and one shared market analysis',async()=>{
 const jobs=new Map(),cache=new Map();let starts=0,delivered=0,quotes=0;
 const db={get:async(table,q)=>{
  if(table==='pr_users')return [{subscribed:true}];
  if(table==='pr_accounts')return [{name:'Основной',updated_at:new Date(),positions:[msft]}];
  if(table==='pr_cache'){const c=cache.get(q.key.slice(3));return c?[c]:[];}
  if(table==='pr_jobs'){const j=jobs.get(q.job_key.slice(3));return j?[j]:[];}
  throw new Error(table);
 },post:async(table,body)=>{assert.equal(table,'pr_cache');cache.set(body.key,body);},patch:async()=>[]};
 const radar=new Radar(db);radar.billing.access=async()=>({allowed:true,asset_limit:20});
 radar.queue=async(key,kind,payload)=>{if(!jobs.has(key))jobs.set(key,{id:jobs.size+1,job_key:key,kind,payload,attempts:1,state:'pending'});};
 radar.insights.daily=async()=>{delivered++;};
 radar.providers={news:async()=>{starts++;return {status:'ok',items:[],events:[],checked_at:new Date().toISOString()};},quote:async()=>{quotes++;return {price:1};},memo:async(_key,_ttl,fn)=>fn()};
 const digests=Array.from({length:100},(_,i)=>({id:1000+i,user_id:i+1,job_key:'daily:'+(i+1)+':2026-09-13',payload:{daily:true}}));
 await Promise.all(digests.map(d=>radar.handleDigest(d)));
 assert.equal(jobs.size,2);assert.equal(delivered,0);
 for(const job of jobs.values()){await radar.handleResearch(job);job.state='done';}
 await Promise.all(digests.map(d=>radar.handleDigest(d)));
 assert.equal(starts,2);assert.ok(delivered>=100);assert.equal(quotes,100); // quote work never starts AI research
});
test('an ambiguous search POST is never restarted for the same daily key',async()=>{
 let starts=0,cached;const radar=new Radar({patch:async()=>[],post:async(_t,body)=>{cached=body;}});
 radar.providers={news:async()=>{starts++;throw new Error('network_timeout');}};
 const job={id:1,job_key:dailyResearchKey(msft),payload:{asset:msft},attempts:1};
 await radar.handleResearch(job);await radar.handleResearch(job);
 assert.equal(starts,1);assert.equal(cached.value.news.status,'unavailable');
});
