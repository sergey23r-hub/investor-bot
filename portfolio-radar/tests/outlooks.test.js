import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseFeed,parseOpinion,consensus,parseSurvey,parseBond,parseFunding} from '../src/outlook-data.js';
import {OutlookProvider,publicText} from '../src/outlook-provider.js';
import {largestHolding,outlookAssets,outlookBody,outlookCard} from '../src/outlook-format.js';
import {Radar,createHandler} from '../src/app.js';

const now=new Date('2026-09-20T18:00:00Z'),stamp=now.toISOString();
const position=(key,quantity='1',currency='RUB')=>({key,name:key,symbol:key,provider:'moex',provider_id:key,verified:true,kind:'stock',quantity,currency});
const q=(price,currency='RUB')=>({status:'ok',price,currency,as_of:stamp});
const account=positions=>({positions,updated_at:stamp});
const free={tier:'free'},paid={tier:'paid'};

test('largest holding uses aggregate position value, FX and canonical identity across accounts, not order or unit price',()=>{
 const first=position('first','1'),many=position('many','1000','USD'),a={...position('boardA','60'),isin:'RU0000000001'},b={...position('boardB','60'),isin:'RU0000000001'};
 const accounts=[account([first,many,a]),account([b])];
 const market={quotes:{first:q(1000),many:q(1,'USD'),'isin:RU0000000001':q(1000)},fx:{status:'ok',as_of:'2026-09-20',rates:{USD:90,RUB:1}}};
 assert.equal(largestHolding(accounts,market,now).key,'isin:RU0000000001');
 assert.equal(outlookAssets(accounts).length,3);
 delete market.quotes['isin:RU0000000001'];assert.equal(largestHolding(accounts,market,now).key,null);
});
test('missing currency conversion or unknown quantities cannot silently pick a smaller free asset',()=>{
 const accounts=[account([position('A'),position('B','2','USD')])],market={quotes:{A:q(100),B:q(2,'USD')}};
 assert.equal(largestHolding(accounts,market,now).key,null);
 assert.equal(largestHolding([account([position('A'),position('B',null)])],market,now).key,null);
 market.fx={status:'ok',as_of:'2020-01-01',rates:{USD:90}};assert.equal(largestHolding(accounts,market,now).key,null);
});
test('fresh observed totals are an explicit approximate fallback and bond percentages never become rubles',()=>{
 const bond={...position('B','100'),kind:'bond'},cash={...position('C','500'),provider:'cash',kind:'cash',provider_id:'RUB'};
 const market={quotes:{B:q(99,'% номинала')}};
 assert.equal(largestHolding([account([bond,cash])],market,now).key,null);
 bond.observed_value='100000';let s=largestHolding([account([bond,cash])],market,now);assert.equal(s.key,'B');assert.equal(s.approximate,true);
 assert.equal(largestHolding([{...account([bond,cash]),updated_at:'2026-01-01'}],market,now).key,null);
});
const opinion=(house,target=120,extra={})=>({house,target,currency:'RUB',horizon:'12m',published_at:stamp,url:'https://www.finam.ru/publications/item/'+house+'/',asset_key:'A',...extra});
test('consensus requires three independent houses and a matching currency and horizon; rejects stale and malformed targets',()=>{
 assert.equal(consensus([opinion('a'),opinion('b')],now),null);
 const c=consensus([opinion('a',120),opinion('a',999,{published_at:'2026-09-01'}),opinion('b',100),opinion('c',140),opinion('d',Infinity),opinion('e',160,{published_at:'invalid'}),opinion('f',500,{currency:'USD'}),opinion('g',150,{horizon:'2027'})],now);
 assert.equal(c.count,3);assert.equal(c.median,120);assert.equal(c.low,100);assert.equal(c.high,140);
 assert.equal(consensus([opinion('a'),opinion('b'),opinion('c',150,{published_at:'2025-01-01'})],now),null);
});
test('extractor accepts explicit sourced price targets only, and rejects another issuer, technical levels and ambiguous amounts',()=>{
 const a={...position('SBER'),name:'Сбербанк'},item={title:'Сбербанк: взгляд аналитиков',author:'БКС',published_at:stamp,url:'https://www.finam.ru/publications/item/test/'};
 const extract=text=>parseOpinion(a,item,{text},now);
 const o=extract('БКС: целевая цена Сбербанка на 12 месяцев составляет 400 рублей.');
 // Ticker matching avoids guessing inflected company names.
 assert.equal(extract('БКС: целевая цена SBER на 12 месяцев составляет 400 рублей.').target,400);
 assert.equal(extract('БКС: уровень поддержки SBER на 12 месяцев составляет 400 рублей.'),null);
 assert.equal(extract('БКС: целевая цена GAZP на 12 месяцев составляет 400 рублей.'),null);
 assert.equal(extract('БКС: целевая цена SBER на 12 месяцев — 400 рублей, сценарий — 500 рублей.'),null);
 assert.equal(extract('Неизвестный блогер: целевая цена SBER на 12 месяцев составляет 400 рублей.'),null);
 assert.equal(parseOpinion(a,{...item,author:''},{text:'Целевая цена SBER на 12 месяцев составляет 400 рублей.'},now),null);
 assert.equal(o,null);
});
test('RSS rejects non-allowlisted URLs and old dates, and strips tracking without executing content',()=>{
 const xml='<rss><channel><item><title><![CDATA[SBER &amp; обзор]]></title><link>https://www.finam.ru/publications/item/a/?utm_source=rss</link><pubDate>Sun, 20 Sep 2026 12:00:00 GMT</pubDate><description>Краткое описание</description><a10:name>БКС</a10:name></item></channel></rss>';
 const item=parseFeed(xml,now)[0];assert.equal(item.url,'https://www.finam.ru/publications/item/a/');assert.equal(item.author,'БКС');
 assert.equal(parseFeed(xml.replace('www.finam.ru','evil.example'),now).length,0);
 assert.equal(parseFeed(xml.replace('2026','2020'),now).length,0);
});
test('survey preserves forecast years and annual-average meaning, ignores previous-survey values',()=>{
 const xml='Результаты опроса: сентябрь 2026 года медианой прогнозов 33 экономистов <table><tr><td></td><th>2025 (факт)</th><th>2026</th><th>2027</th></tr><tr><td>Ключевая ставка, в среднем за год</td><td>19</td><td>14,5 (15,0)</td><td>12,4 (12,5)</td></tr><tr><td>ИПЦ (дек. к дек.)</td><td>7</td><td>6,6</td><td>4,6</td></tr></table>';
 const s=parseSurvey(xml,now);assert.deepEqual(s.rates,[{year:2026,value:14.5},{year:2027,value:12.4}]);assert.equal(s.count,33);assert.equal(s.inflation[0].value,6.6);
 assert.throws(()=>parseSurvey(xml.replace('2026 года','2020 года'),now),/stale/);
});
test('bond yield dates and explicit crypto identifiers prevent misleading maturity/funding claims',()=>{
 const a={...position('B'),isin:'RU0000000001',kind:'bond'};
 const d={securities:{columns:['SECID','ISIN','BOARDID','MATDATE','COUPONPERCENT'],data:[['B',a.isin,'TQCB','2030-01-01',18]]},marketdata_yields:{columns:['SECID','BOARDID','EFFECTIVEYIELD','YIELDDATETYPE','YIELDDATE','TRADEMOMENT'],data:[['B','TQCB',17.5,'OFFER','2028-01-01','2026-09-20 18:00:00']]}};
 const b=parseBond(d,a,now);assert.equal(b.yield_type,'OFFER');assert.equal(b.yield_date,'2028-01-01');
 const funding={symbol:'BTCUSDT',time:+now,markPrice:'100',indexPrice:'99',lastFundingRate:'0.0001'};
 assert.equal(parseFunding(funding,{provider_id:'bitcoin'},now).rate_pct,0.01);
 assert.equal(parseFunding(funding,{provider_id:'another-bitcoin'},now),null);
 assert.equal(parseFunding({...funding,time:+now-2*86400000},{provider_id:'bitcoin'},now),null);
});
test('free pages never contain hidden targets, links or source metadata; trial and paid pages do',()=>{
 const assets=Array.from({length:20},(_,i)=>position('Holding'+i)),records=Object.fromEntries(assets.map((a,i)=>[a.key,{checked_at:stamp,opinions:[opinion('house'+i,9000+i)]}]));
 for(let page=0;page<4;page++){
  const body=outlookBody(1,assets,records,{key:'Holding19'},free,page,now),json=JSON.stringify(body);
  for(let i=0;i<19;i++)assert.doesNotMatch(json,new RegExp('house'+i+'(?:["/ ]|\\\\)'));
  assert.ok(body.text.length<4096);assert.match(json,/billing:upgrade/);
 }
 assert.match(outlookBody(1,assets,records,null,paid,0,now).text,/house0/);
 assert.match(outlookBody(1,assets,records,null,{tier:'trial'},0,now).text,/house0/);
 assert.doesNotMatch(outlookBody(1,assets,records,{key:null},free,0,now).text,/house0/);
});
test('queued paid pages are rebuilt against current membership and entitlement without starting providers',async()=>{
 const oldFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('outlook button must be cache-only');
 try{
  const positions=[{...position('A'),observed_value:'100'},{...position('B'),observed_value:'200'}],accounts=[{positions,updated_at:new Date().toISOString()}];
  const db={get:async t=>t==='pr_accounts'?accounts:[],rpc:async name=>{assert.equal(name,'pr_outlook_latest');return positions.map(a=>({asset_key:a.key,data:{checked_at:new Date().toISOString(),opinions:[opinion('Secret'+a.key)]}}));}};
  const r=new Radar(db);r.billing.access=async()=>free;
  const body=await r.insights.deliveryBody({user_id:42,body:{chat_id:42,text:'previous paid data',_portfolius:{outlook:true,page:0}}});
  assert.doesNotMatch(body.text,/SecretA|previous paid data/);assert.match(body.text,/SecretB/);
  assert.equal(await r.insights.deliveryBody({user_id:43,body:{chat_id:42,_portfolius:{outlook:true}}}),null);
 }finally{globalThis.fetch=oldFetch;}
});
test('a daily source reservation deduplicates concurrent loads, failures and new worker instances',async()=>{
 const records=new Map();let calls=0;
 const db={get:async(_t,q)=>{const v=records.get(q.source_key.slice(3)+'|'+q.service_day.slice(3));return v?[v]:[];},post:async(_t,b)=>{const k=b.source_key+'|'+b.service_day;if(records.has(k))return [];records.set(k,b);return [b];},patch:async(_t,b,q)=>Object.assign(records.get(q.source_key.slice(3)+'|'+q.service_day.slice(3)),b)};
 const a=new OutlookProvider(db,{now}),b=new OutlookProvider(db,{now}),loader=async()=>{calls++;throw new Error('private raw body');};
 await Promise.all([a.once('shared',loader),b.once('shared',loader)]);await b.once('shared',loader);assert.equal(calls,1);assert.equal([...records.values()][0].error,'source_unavailable');
 await new OutlookProvider(db,{now:new Date(+now+86400000)}).once('shared',async()=>{calls++;return {};});assert.equal(calls,2);
});
test('outlook worker endpoint requires worker authentication and HTTP collector rejects arbitrary hosts',async()=>{
 const handler=createHandler({},()=>{}, {rpc:async()=>({worker_secret:'worker',webhook_secret:'telegram'})});
 for(const secret of [undefined,'telegram']){const response=await handler(new Request('https://example/outlook-work',{method:'POST',headers:secret?{'x-portfolio-worker-secret':secret}:{}}));assert.equal(response.status,401);}
 await assert.rejects(publicText('https://evil.example/data'),/not_allowed/);
});
