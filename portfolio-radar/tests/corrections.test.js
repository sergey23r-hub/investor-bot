import test from 'node:test';
import assert from 'node:assert/strict';
import {Radar} from '../src/app.js';
import {parseCorrection,correctionCode} from '../src/corrections.js';
import {internationalQuote,internationalResolve} from '../src/international.js';
import {newsWindow,validateNews} from '../src/core.js';
const position={key:'old',name:'Example Corp',kind:'stock',quantity:'2',average_price:null,observed_value:'40',currency:'USD',verified:false};
test('ticker-only correction keeps the observed quantity and value',async()=>{
 const parsed=await parseCorrection('/fix 1 EX',[position],'unused');
 const raw=correctionCode(position,parsed.changes[0]);
 assert.equal(raw.quantity,'2');assert.equal(raw.observed_value,'40');assert.equal(raw.symbol,'EX');
 const selected=await parseCorrection('EX',[position],'unused',0);assert.equal(selected.changes[0].row,1);
});
test('explicit quantity correction invalidates stale observed value',()=>{
 const r=correctionCode(position,{code:null,quantity:'3',quantity_supplied:true});
 assert.equal(r.quantity,'3');assert.equal(r.observed_value,null);
});
test('correction after saving creates a complete review draft and preserves every other row',async()=>{
 let inserted;const oldRows=[position,{...position,key:'other',name:'Other'}];
 const db={patch:async()=>[],post:async(table,body)=>{assert.equal(table,'pr_imports');inserted=body;return [{id:'draft',...body}];}};
 const radar=new Radar(db);radar.config={openai_key:'unused'};radar.billing.require=async()=>({allowed:true});
 radar.currentImport=async()=>null;radar.account=async()=>({id:'account',version:7,positions:oldRows});
 radar.providers={resolve:async r=>({...r,key:'new',verified:true})};
 radar.reply=async()=>{};radar.flush=async()=>{};radar.preview=async()=>{};
 await radar.handleCorrection({id:42,payload:{}},{chat_id:1},'/fix 1 EX');
 assert.equal(inserted.mode,'replace');assert.equal(inserted.base_version,7);assert.equal(inserted.correction,true);
 assert.deepEqual(inserted.rows.map(r=>r.key),['new','other']);assert.equal(inserted.rows[0].quantity,'2');
 assert.equal(oldRows[0].key,'old');
});
test('ordinary text with an ambiguous row asks a question without editing the account',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({intent:'correct',changes:[],question:'Первая или вторая строка?'})}]}]});
 try{
  const db={patch:async()=>[]};const radar=new Radar(db);radar.config={openai_key:'test'};radar.billing.require=async()=>({allowed:true});
  radar.currentImport=async()=>null;radar.account=async()=>({positions:[position,position]});radar.flush=async()=>{};
  const replies=[];radar.reply=async(_job,_user,text)=>replies.push(text);
  await radar.handleCorrection({id:2,payload:{}},{chat_id:1},'Example — EX');
  assert.equal(replies.at(-1),'Первая или вторая строка?');
 }finally{globalThis.fetch=old;}
});
test('international quotes use the previous session rather than the start of the chart range',async()=>{
 const meta={longName:'Example Corporation',symbol:'EX',currency:'USD',regularMarketPrice:110,regularMarketTime:Math.floor(Date.now()/1000),chartPreviousClose:80,fullExchangeName:'Nasdaq'};
 const fetcher=async()=>({chart:{result:[{meta,indicators:{quote:[{close:[80,90,100,110]}]}}]}});
 const q=await internationalQuote({...position,name:'Example Corp',symbol:'EX-RM',isin:'US0000000001'},fetcher);
 assert.ok(Math.abs(q.change_pct-10)<1e-8);assert.equal(q.currency,'USD');assert.match(q.url,/\/EX\//);
 assert.equal(await internationalQuote({...position,name:'Different',provider:'yahoo',provider_id:'EX'},fetcher),null);
 meta.regularMarketTime-=8*86400;assert.equal(await internationalQuote({...position,provider:'yahoo',provider_id:'EX'},fetcher),null);
});
test('foreign name lookup distinguishes primary shares from depositary receipts',async()=>{
 const fetcher=async url=>url.includes('/search?')?{quotes:[
 {symbol:'EX.PA',quoteType:'EQUITY',longname:'Example Corp',shortname:'Example',exchange:'PAR'},
 {symbol:'EXY',quoteType:'EQUITY',longname:'Example Corp',shortname:'Example ADR',exchange:'PNK'}
 ]}:{chart:{result:[{meta:{longName:'Example Corporation',currency:'EUR'}}]}};
 const r=await internationalResolve({...position,currency:'EUR'},fetcher);
 assert.equal(r.provider_id,'EX.PA');assert.equal(r.verified,true);
 assert.equal(await internationalResolve({...position,currency:'USD'},fetcher),null);
});
test('weekend stock summaries include Friday with an explicit period; crypto stays at 24 hours',()=>{
 const now=new Date('2026-09-12T22:00:00Z');const w=newsWindow('stock',now);
 assert.equal(w.since,'2026-09-11T00:00:00.000Z');assert.equal(newsWindow('crypto',now).hours,24);
 const item={url:'https://issuer.example/news',fact:'Report',relevance:'Earnings',published_at:'2026-09-11T12:00:00Z',event_date:'2026-09-11T12:00:00Z'};
 assert.equal(validateNews([item],[item.url],now).length,0);
 assert.equal(validateNews([item],[item.url],now,w.hours).length,1);
});
test('concurrent flushes cannot send the same outbox row twice',async()=>{
 let state='pending',sent=0;const db={get:async()=>[{id:1,attempts:0,user_id:1,method:'sendMessage',body:{}}],patch:async(_t,body,query)=>{
 if(query.state){if(state!=='pending')return [];state=body.state;return [{id:1}];}
 state=body.state;return [{id:1}];
 }};
 const radar=new Radar(db);radar.telegram=async()=>{sent++;return {message_id:1};};
 await Promise.all([radar.flush(),radar.flush()]);assert.equal(sent,1);assert.equal(state,'sent');
});
test('background research resumes the same response and does not fetch quotes',async()=>{
 let starts=0,quotes=0,stored;const requests=[];
 const radar=new Radar({patch:async()=>[],post:async(_t,body)=>{stored=body;}});
 radar.providers={
  quote:async()=>{quotes++;return {price:10,status:'ok'};},
  news:async(_asset,_now,{response})=>{if(!response){starts++;return {pending:true,response_id:'resp_test'};}return {status:'ok',items:[],events:[]};},
  newsResponse:async(id,method='GET')=>{requests.push([id,method]);return {status:'completed'};}
 };
 const job={id:1,job_key:'research:test',attempts:1,payload:{asset:{key:'asset',kind:'stock'}}};
 assert.equal(await radar.handleResearch(job),'deferred');
 await radar.handleResearch(job);
 assert.equal(starts,1);assert.equal(quotes,0);assert.equal(stored.value.news.status,'ok');
 assert.deepEqual(requests,[['resp_test','GET'],['resp_test','DELETE']]);
});
