import test from 'node:test';
import assert from 'node:assert/strict';
import {entitledPortfolio,upgradeOffer} from '../src/freemium.js';
import {Radar} from '../src/app.js';
const positions=Array.from({length:20},(_,i)=>({key:'asset'+i,name:'ASSET_'+i,symbol:'S'+i,provider:'yahoo',provider_id:'S'+i,kind:'stock',verified:true}));
const accounts=[{id:'a',name:'Main',positions,updated_at:new Date().toISOString()}];
const free={allowed:true,freemium:true,tier:'free',asset_limit:3},paid={allowed:true,freemium:true,tier:'paid',asset_limit:500};
test('free plan always uses the first three unique assets, with no selection UI',()=>{
 const view=entitledPortfolio([...accounts,{name:'Other',positions:[positions[0]]}],free);
 assert.deepEqual(view.keys,positions.slice(0,3).map(x=>x.key));assert.equal(view.hidden,17);assert.equal(view.assets.length,3);
 const offer=upgradeOffer(free,{hidden:view.hidden});assert.match(offer.text,/17/);assert.match(offer.text,/290 ₽/);assert.doesNotMatch(JSON.stringify(offer),/free:menu|\/free|выбрать/i);
 assert.equal(entitledPortfolio(accounts,paid).assets.length,20);assert.equal(upgradeOffer(paid).text,'');
});
test('frozen daily selection never expands when a portfolio changes during processing',()=>{
 const view=entitledPortfolio(accounts,free),changed=[{...accounts[0],positions:[positions[19],...positions]}];
 assert.deepEqual(entitledPortfolio(changed,free,view.keys).keys,view.keys);
 assert.deepEqual(entitledPortfolio(accounts,free,positions.map(x=>x.key)).keys,view.keys);
});
test('free digest limits news scheduling before any provider work',async()=>{
 let frozen=false;const jobs=[];
 const radar=new Radar({get:async table=>table==='pr_users'?[{subscribed:true}]:table==='pr_accounts'?accounts:[],patch:async(_t,b)=>{if(b.payload?.entitled_keys)frozen=true;return [];}});
 radar.billing.access=async()=>free;radar.queue=async(_key,kind,p)=>{assert.equal(frozen,true);jobs.push(p.asset.key);};
 radar.providers={quote:async()=>assert.fail('wait for scheduled shared news')};
 const result=await radar.handleDigest({id:1,user_id:42,job_key:'daily:42:2026-09-13',payload:{daily:true}});
 assert.equal(result,'deferred');assert.deepEqual(jobs,['market','asset0','asset1','asset2']);
});
test('downgrade at delivery hides other quotes, news and events even when all 20 are cached',async()=>{
 let checks=0;const replies=[];
 const now=new Date().toISOString();
 const radar=new Radar({get:async table=>table==='pr_users'?[{subscribed:true}]:table==='pr_accounts'?accounts:table==='pr_cache'?[{expires_at:'2100-01-01',value:{news:{status:'ok',items:[],events:[]}}}]:[],patch:async()=>[]});
 radar.billing.access=async()=>++checks===1?paid:free;
 radar.reply=async(_j,_u,text,k)=>replies.push({text,k});
 const quotes=Object.fromEntries(positions.map(p=>[p.key,{price:1,currency:'RUB',as_of:now,url:'https://example.com'}]));
 await radar.handleDigest({id:1,user_id:42,job_key:'daily:42:2026-09-13',payload:{daily:true,digest_quotes:quotes}});
 const text=replies.map(x=>x.text).join('');assert.match(text,/ASSET_2/);assert.doesNotMatch(text,/ASSET_(?:[3-9]|1\d)/);assert.match(text,/Ещё 17/);assert.equal(replies.at(-1).k[0][0].callback_data,'billing:upgrade');
});
