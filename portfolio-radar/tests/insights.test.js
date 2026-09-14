import test from 'node:test';
import assert from 'node:assert/strict';
import {Radar} from '../src/app.js';
import {filterSnapshot,reportPages,reportKeyboard,summaryText,structureText,calendarItems,calendarText,weeklySnapshot,stories,storyId,valuation} from '../src/report-format.js';
import {parseCbr,bondEvents,dividendEvents} from '../src/asset-facts.js';
import {Providers,newsSchema} from '../src/providers.js';
import {answerPortfolioQuestion} from '../src/portfolio-qa.js';
import {newsDay,dailyResearchKey} from '../src/daily.js';

const paid={tier:'paid',freemium:true,allowed:true,asset_limit:500},free={tier:'free',freemium:true,allowed:true,asset_limit:3};
const id='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const now=new Date(),today=newsDay(now),tomorrow=new Date(+now+86400000).toISOString().slice(0,10);
const positions=Array.from({length:20},(_,i)=>({key:'a'+i,name:'Holding_'+i,symbol:'H'+i,quantity:'10',currency:'RUB',kind:'stock',provider:'yahoo',provider_id:'H'+i,verified:true}));
const accounts=[{id:'account',name:'Main',positions,updated_at:now.toISOString()}];
const snapshot=()=>({accounts,as_of:now.toISOString(),total_assets:20,
 quotes:Object.fromEntries(positions.map((p,i)=>[p.key,{status:'ok',price:100+i,currency:'RUB',change_pct:i,as_of:now.toISOString(),url:'https://issuer.example/quote'}])),
 news:Object.fromEntries(positions.map(p=>[p.key,{status:'ok',items:[{fact:'News for '+p.name,relevance:'Explanation',url:'https://issuer.example/'+p.key,published_at:now.toISOString(),event_date:now.toISOString()}],events:[{title:'Event '+p.name,date:tomorrow,url:'https://issuer.example/event/'+p.key}]}])),facts:{}});

function fixture(){
 const reports=[],outbox=[],events=[],replies=[];let access=paid;
 const db={get:async(table,q={})=>{
  if(table==='pr_accounts')return accounts;
  if(table==='pr_reports'){
   let result=reports.filter(r=>['id','user_id','kind','service_day'].every(k=>!q[k]||(q[k].startsWith('eq.')?String(r[k])===q[k].slice(3):q[k].startsWith('gte.')?r[k]>=q[k].slice(4):q[k].startsWith('lt.')?r[k]<q[k].slice(3):true)));
   if(q.order?.includes('desc'))result=result.toSorted((a,b)=>b.service_day.localeCompare(a.service_day));
   return result.slice(q.offset||0,(q.offset||0)+(q.limit||result.length));
  }
  return [];
 },post:async(table,body,_query,prefer)=>{
  if(table==='pr_reports'){
   const old=reports.find(r=>r.user_id===body.user_id&&r.kind===body.kind&&r.service_day===body.service_day);
   if(old){if(prefer.includes('merge-duplicates'))Object.assign(old,body);}else reports.push({id:crypto.randomUUID(),...structuredClone(body)});
  }else if(table==='pr_outbox'){if(!outbox.some(o=>o.dedup_key===body.dedup_key))outbox.push(body);}
  else if(table==='pr_product_events')events.push(body);
  return [];
 },patch:async()=>[]};
 const radar=new Radar(db);radar.billing.access=async()=>access;radar.reply=async(_j,_u,text,keyboard)=>replies.push({text,keyboard});
 radar.providers={news:()=>assert.fail('manual research'),quote:()=>assert.fail('manual quotes')};
 return {radar,db,reports,outbox,events,replies,setAccess:a=>access=a};
}

test('all report sections re-check a downgrade at actual delivery and never expose asset four',async()=>{
 const f=fixture();f.reports.push({id,user_id:42,kind:'daily',service_day:today,snapshot:snapshot()});
 for(const section of ['summary','assets','news','calendar','structure']){
  await f.radar.insights.sendReport({id:section},42,f.reports[0],section);
 }
 f.setAccess(free);
 for(const row of f.outbox){
  const body=await f.radar.insights.deliveryBody(row);assert.ok(body);assert.equal(body._portfolius,undefined);
  assert.doesNotMatch(body.text,/Holding_(?:[3-9]|1\d)\b/);assert.doesNotMatch(JSON.stringify(body),/issuer\.example\/a(?:[3-9]|1\d)\b/);
 }
});

test('another user cannot open a report; an expired free account cannot open a previous report',async()=>{
 const f=fixture();f.reports.push({id,user_id:42,kind:'daily',service_day:'2026-01-01',snapshot:snapshot()},{id:crypto.randomUUID(),user_id:42,kind:'daily',service_day:today,snapshot:snapshot()});
 assert.equal(await f.radar.insights.readable(99,id,paid),null);
 assert.equal(await f.radar.insights.readable(42,id,free),null);
 assert.ok(await f.radar.insights.readable(42,id,paid));
 assert.equal(await f.radar.insights.readable(42,'bad-uuid',paid),null);
});

test('changing the free portfolio does not reveal previous premium holdings through saved callbacks',()=>{
 const changed=[{...accounts[0],positions:[positions[19],positions[18],positions[17],...positions]}];
 const view=filterSnapshot(snapshot(),free,changed);
 assert.deepEqual(view.keys,['a19','a18','a17']);assert.deepEqual(Object.keys(view.news),['a17','a18','a19']);
 const earlierFree=filterSnapshot(snapshot(),free,accounts);
 assert.equal(filterSnapshot(earlierFree,free,changed).keys.length,0);
});

test('twenty-asset detail pages are balanced HTML, bounded in length and navigable with valid callback sizes',()=>{
 const s=snapshot();s.news.a0.items[0].fact='<script> & '.repeat(30);
 for(const section of ['summary','news','assets','calendar','structure']){
  const parts=reportPages({kind:'daily'},s,section,paid);assert.ok(parts.length);
  for(const [i,text] of parts.entries()){
   assert.ok(text.length<=3600);assert.equal((text.match(/<b>/g)||[]).length,(text.match(/<\/b>/g)||[]).length);
   assert.equal((text.match(/<a /g)||[]).length,(text.match(/<\/a>/g)||[]).length);assert.doesNotMatch(text,/<script>/);
   for(const row of reportKeyboard(id,section,paid,i,parts.length))for(const b of row)assert.ok(Buffer.byteLength(b.callback_data)<=64);
  }
 }
 assert.ok(reportPages({kind:'daily'},s,'news',paid).length>1);
});

test('daily summary suppresses repeated stories but full details and new developments remain',()=>{
 const s=snapshot(),first=s.news.a0.items[0];s.previous_story_ids=[storyId(first)];
 assert.equal(stories(s,{fresh:true}).some(n=>n.key==='a0'),false);
 assert.equal(stories(s).some(n=>n.key==='a0'),true);
 s.news.a0.items[0]={...first,fact:'A genuinely new announcement'};
 assert.equal(stories(s,{fresh:true}).some(n=>n.key==='a0'),true);
});

test('weekly price changes compare snapshots instead of adding daily percentages or claiming portfolio return',()=>{
 const a=snapshot(),b=snapshot();a.quotes.a0={status:'ok',price:100,currency:'RUB',as_of:'2026-09-10T10:00:00Z',change_pct:40};b.quotes.a0={status:'ok',price:110,currency:'RUB',as_of:'2026-09-14T10:00:00Z',change_pct:50};
 const weekly=weeklySnapshot([{service_day:'2026-09-10',snapshot:a},{service_day:'2026-09-14',snapshot:b}]);
 assert.ok(Math.abs(weekly.week_change.a0-10)<1e-10);assert.equal(weekly.days_count,2);assert.equal(weekly.news.a0.items.length,1);
 assert.match(summaryText(weekly,paid,{weekly:true}),/2 из 7/);
});

test('bond percentage quote is never treated as a ruble unit price; unknown holdings disclose denominator',()=>{
 const s=snapshot();s.accounts=[{...accounts[0],positions:[{...positions[0],kind:'bond'}, {...positions[1],quantity:null}]}];
 s.quotes.a0={status:'ok',price:70,currency:'% номинала',as_of:now.toISOString()};
 assert.equal(valuation(s).total,0);
 s.quotes.a0.unit_price=720;s.quotes.a0.unit_currency='RUB';
 assert.equal(valuation(s).total,7200);assert.equal(valuation(s).missing.length,1);
 assert.match(structureText(s,paid),/только к оценённой части/);
});

test('different currencies require explicit FX; a missing rate does not mix dollars with rubles',()=>{
 const s=snapshot();s.accounts=[{...accounts[0],positions:positions.slice(0,2)}];s.quotes.a0.currency='USD';
 let v=valuation(s);assert.equal(v.total,1010);assert.equal(v.missing.length,1);
 s.fx={status:'ok',as_of:today,rates:{RUB:1,USD:90},source:'https://www.cbr.ru'};
 v=valuation(s);assert.equal(v.total,91010);assert.equal(v.missing.length,0);
 s.fx.as_of='2020-01-01';assert.equal(valuation(s).missing.length,1);
});

test('CBR rates respect currency nominal and bond cashflows use absolute coupon amount',()=>{
 const fx=parseCbr('<ValCurs Date="14.09.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>90,00</Value></Valute><Valute><CharCode>JPY</CharCode><Nominal>100</Nominal><Value>60,00</Value></Valute></ValCurs>');
 assert.equal(fx.rates.JPY,0.6);
 const data={coupons:{columns:['secid','coupondate','recorddate','value','valueprc','faceunit'],data:[['BOND','2026-10-01','2026-09-30',35.4,7.1,'RUB']]},amortizations:{columns:[],data:[]},offers:{columns:[],data:[]}};
 const e=bondEvents(data,{provider_id:'BOND'},'2026-09-14','2026-10-14')[0];assert.equal(e.amount_per_unit,'35.4');assert.equal(e.record_date,'2026-09-30');
 assert.throws(()=>dividendEvents({description:{}},{provider_id:'SBER'},today,tomorrow),/unavailable/);
});

test('calendar keeps record dates separate and does not add principal to investment income',()=>{
 const s=snapshot();s.accounts=[{...accounts[0],positions:[{...positions[0],quantity:'15'}]}];s.news={};s.facts={a0:{status:'ok',events:[
  {type:'coupon',date:tomorrow,title:'Coupon',date_basis:'scheduled',confirmed:true,amount_per_unit:'35.4',currency:'RUB',url:'https://issuer.example/coupon'},
  {type:'principal',date:tomorrow,title:'Principal',date_basis:'scheduled',confirmed:true,amount_per_unit:'1000',currency:'RUB',url:'https://issuer.example/principal'},
  {type:'dividend',date:tomorrow,title:'Record',date_basis:'record',confirmed:true,amount_per_unit:'10',currency:'RUB',url:'https://issuer.example/dividend'}
 ]}};
 assert.equal(calendarItems(s,paid,now)[0].estimate,531);
 const text=calendarText(s,paid,now);assert.match(text,/Дата реестра; день зачисления денег не подтверждён/);assert.match(text,/Объявленные купоны и дивиденды<\/b>\n≈ 531 RUB/);
 assert.ok(calendarItems(s,free,now).every(e=>e.estimate===null));
});

test('screenshot save builds a useful passport from existing cache without starting market jobs',async()=>{
 const f=fixture(),cache={key:dailyResearchKey(positions[0],now),expires_at:new Date(+now+86400000).toISOString(),value:{news:snapshot().news.a0}};
 const get=f.db.get;f.db.get=async(table,q)=>table==='pr_cache'?[cache]:get(table,q);
 f.radar.queue=async()=>assert.fail('must not schedule manual market work');
 await f.radar.insights.afterSave({id:7},{chat_id:42,digest_time:'22:00:00',timezone:'Europe/Moscow'});
 assert.equal(f.reports.length,1);assert.match(f.replies[0].text,/Портфель сохранён/);assert.match(f.replies[0].text,/уже есть готовые данные/);
 assert.ok(f.reports[0].snapshot.news.a0);assert.equal(f.events[0].event,'saved');
});

test('re-saving screenshots updates the first-view snapshot without refreshing market data',async()=>{
 const f=fixture();await f.radar.insights.save(42,'first',today,{...snapshot(),marker:1});
 await f.radar.insights.save(42,'first',today,{...snapshot(),marker:2});
 assert.equal(f.reports.length,1);assert.equal(f.reports[0].snapshot.marker,2);
});

test('trial reminder is suppressed if the customer has paid before delivery',async()=>{
 const f=fixture();const row={user_id:42,body:{chat_id:42,text:'Trial reminder',_portfolius:{notice:'trial_ending'}}};
 assert.equal(await f.radar.insights.deliveryBody(row),null);
 f.setAccess({...paid,tier:'trial'});assert.equal((await f.radar.insights.deliveryBody(row)).text,'Trial reminder');
});

test('paid answer queued before expiry is hidden after downgrade',async()=>{
 const f=fixture();f.setAccess(free);
 const body=await f.radar.insights.deliveryBody({user_id:42,body:{chat_id:42,text:'PRIVATE ANSWER',_portfolius:{requires_full:true}}});
 assert.doesNotMatch(body.text,/PRIVATE ANSWER/);assert.match(body.text,/subscribe/);
});

test('Q&A sends no search tools, bounds output and rejects invented citation indices',async()=>{
 const original=globalThis.fetch;let request,usage;
 globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return Response.json({id:'resp_qa',status:'completed',model:'test',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Explanation <script>',source_ids:[0,999]})}]}]});};
 try{
  const answer=await answerPortfolioQuestion('Explain my portfolio',snapshot(),'test',r=>{usage=r;});
  assert.equal(request.tools,undefined);assert.equal(request.store,false);assert.ok(request.max_output_tokens<=1200);assert.equal(usage.scope,'portfolio_qa');
  assert.match(answer,/&lt;script&gt;/);assert.equal((answer.match(/<a /g)||[]).length,1);
 }finally{globalThis.fetch=original;}
});

test('weekly and archive navigation reads stored reports and never calls providers',async()=>{
 const f=fixture();f.reports.push({id,user_id:42,kind:'daily',service_day:today,snapshot:snapshot()});
 await f.radar.insights.week({id:1},42);await f.radar.insights.archive({id:2},42);
 assert.equal(f.reports.filter(r=>r.kind==='weekly').length,1);assert.equal(f.outbox.length,1);assert.match(f.replies.at(-1).text,/Архив/);
});

test('the owner metrics endpoint is not exposed to another Telegram user',async()=>{
 const f=fixture();f.db.rpc=async()=>assert.fail('private metrics queried');
 await f.radar.insights.admin({id:1},123);assert.match(f.replies[0].text,/владельцу/);
});

test('extended shared research requires sourced profile and primary announcement for cash amounts',async()=>{
 const p=new Providers({openai_key:'test'},{}),url='https://issuer.example/notice';
 const raw={items:[],asset_profile:{sector:'Finance',issuer_name:'Issuer',url:'https://invented.example'},events:[{title:'Dividend',date:tomorrow,url,type:'dividend',amount_per_unit:'40',currency:'RUB',date_basis:'record',record_date:tomorrow,source_primary:false}]};
 const response={id:'resp_test',status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[{url}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify(raw)}]}]};
 const n=await p.news(positions[0],now,{response});assert.equal(n.profile,null);assert.equal(n.events[0].amount_per_unit,null);
 assert.ok(newsSchema.properties.events.items.required.includes('source_primary'));
});

test('an existing portfolio opens from cache before the first new daily report without restarting trial',async()=>{
 const f=fixture();f.db.rpc=async()=>assert.fail('unexpected RPC / trial reset');
 await f.radar.insights.open({id:9},42);
 assert.equal(f.reports[0].kind,'first');assert.equal(f.outbox.length,1);
 assert.equal(f.events.some(e=>e.event==='saved'),false);
});

test('outbox retries a render failure before sending but never resends after a Telegram acknowledgement',async()=>{
 for(const stage of ['render','tracking']){
  const f=fixture(),patches=[];let sends=0;
  const row={id:8,attempts:0,user_id:42,method:'sendMessage',body:{chat_id:42,text:'report'}};
  f.db.get=async()=>[row];f.db.patch=async(_t,body)=>{patches.push(body);if(body.state==='sent')throw new Error('database_unavailable');return [row];};
  f.radar.insights.deliveryBody=async()=>{if(stage==='render')throw new Error('database_unavailable');return row.body;};
  f.radar.telegram=async()=>{sends++;return {message_id:99};};
  await f.radar.flush();
  assert.equal(sends,stage==='render'?0:1);assert.equal(patches.at(-1).state,stage==='render'?'pending':'uncertain');
 }
});
