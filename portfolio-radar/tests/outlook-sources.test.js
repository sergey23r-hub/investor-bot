import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStockForecast,parseCryptoForecast,stockForecastUrl,cryptoForecastUrl,newestQuote} from '../src/outlook-sources.js';
import {OutlookProvider} from '../src/outlook-provider.js';
import {outlookBody,outlookCard} from '../src/outlook-format.js';
import {assetMention} from '../src/outlook-data.js';

const now=new Date('2026-09-29T18:00:00Z');
const stock={key:'isin:US19260Q1076',isin:'US19260Q1076',provider:'moex',provider_id:'COIN-RM',symbol:'COIN-RM',kind:'stock',name:'Coinbase Global, Inc.',verified:true};
const crypto={key:'cg:pudgy-penguins',provider:'coingecko',provider_id:'pudgy-penguins',symbol:'PENGU',name:'Pudgy Penguins',kind:'crypto',verified:true};
// Minimal structural fixtures; numeric values are synthetic. No hidden hydration
// payloads or paywalled fields are needed to parse the visible public data.
const stockHtml=`<div>Coinbase Global, Inc. (COIN)</div><div>NASDAQ: COIN · Real-Time Price · USD</div>
<h1>Coinbase Stock Forecast</h1><p>According to 12 analysts polled by S&amp;P Global, Coinbase stock has an average price target of $123.4. The average 1-year stock price forecast is higher.</p>
<table><tr><th>Target</th><th>Low</th><th>Average</th><th>Median</th><th>High</th></tr><tr><td>Price</td><td>$90</td><td>$123.4</td><td>$125</td><td>$170</td></tr></table>
<span>Last updated:</span><span>Sep 28, 2026</span>`;
const cryptoHtml=`<h1>Pudgy Penguins (PENGU) Price Prediction 2026, 2027-2030</h1>
<div>5-Day Prediction</div><div>$ 0.007645</div><div>1-Month Prediction</div><div>$ 0.007458</div>
<div>3-Month Prediction</div><div>$ 0.007630</div><div>6-Month Prediction</div><div>Unlock</div>
<span>Last update: Sep 29, 2026 - 01:54 PM (GMT+0)</span>`;

test('US consensus checks issuer and ticker, preserves average vs median and source analyst count',()=>{
 const c=parseStockForecast(stockHtml,stock,now);
 assert.equal(c.median,125);assert.equal(c.mean,123.4);assert.equal(c.count,12);assert.equal(c.count_kind,'analysts');
 assert.equal(c.as_of,'2026-09-28T00:00:00.000Z');assert.equal(c.sources.length,1);assert.equal(c.kind,'source_consensus');
 assert.equal(stockForecastUrl({...stock,isin:'RU000A0JQUZ6'}),null);
 assert.equal(stockForecastUrl({...stock,kind:'fund'}),null);
 assert.throws(()=>parseStockForecast(stockHtml,{...stock,name:'Unrelated Coinbase Company'},now),/identity/);
 assert.throws(()=>parseStockForecast(stockHtml.replaceAll('COIN','COINX'),stock,now),/identity/);
 assert.throws(()=>parseStockForecast(stockHtml.replace('· USD','· CAD'),stock,now),/identity/);
});
test('a changed page, stale/future source date or inconsistent targets fail closed',()=>{
 for(const h of [stockHtml.replace('Median','Middle'),stockHtml.replace('$123.4.</p>','$120.</p>').replace('$123.4. The','$120. The'),stockHtml.replace('$90','$900'),stockHtml.replace('12 analysts','2 analysts')]){
  assert.throws(()=>parseStockForecast(h,stock,now),/format/);
 }
 assert.throws(()=>parseStockForecast(stockHtml.replace('Sep 28','Aug 28'),stock,now),/stale/);
 assert.throws(()=>parseStockForecast(stockHtml.replace('Sep 28','Oct 28'),stock,now),/stale/);
});
test('crypto model reads only visible short horizons and retains sub-cent precision',()=>{
 const m=parseCryptoForecast(cryptoHtml,crypto,now);
 assert.equal(m.kind,'algorithmic');assert.equal(m.as_of,'2026-09-29T13:54:00.000Z');
 assert.deepEqual(m.targets.map(t=>t.horizon),['5-Day','1-Month','3-Month']);assert.equal(m.targets[0].target,0.007645);
 const locked=cryptoHtml.replace('$ 0.007645','Unlock').replace('$ 0.007458','Unlock').replace('$ 0.007630','Unlock')+'<script>{"5-Day Prediction":"$999"}</script>';
 assert.throws(()=>parseCryptoForecast(locked,crypto,now),/format/);
 assert.equal(cryptoForecastUrl({...crypto,provider_id:'wrapped-penguins'}),null);
 assert.equal(cryptoForecastUrl({...crypto,verified:false}),null);
 assert.throws(()=>parseCryptoForecast(cryptoHtml.replace('(PENGU)','(OTHER)'),crypto,now),/identity/);
 assert.throws(()=>parseCryptoForecast(cryptoHtml.replace('Sep 29','Sep 26'),crypto,now),/stale/);
});
test('cards distinguish analyst consensus, algorithmic forecasts and source dates; expire old underlying data',()=>{
 const record={checked_at:now.toISOString(),consensus:parseStockForecast(stockHtml,stock,now)};
 const s=outlookCard(stock,record,now);assert.match(s,/Медианная цель: 125/);assert.match(s,/Средняя цель: 123,4/);assert.match(s,/Аналитиков по данным источника: 12/);assert.doesNotMatch(s,/Финам|Независимых аналитических домов/);
 const model={checked_at:now.toISOString(),model_forecast:parseCryptoForecast(cryptoHtml,crypto,now)};
 const c=outlookCard(crypto,model,now);assert.match(c,/Алгоритмический прогноз/);assert.match(c,/не консенсус аналитиков/);assert.match(c,/0,007645/);assert.ok(c.length<2500);
 assert.doesNotMatch(outlookCard(stock,{...record,consensus:{...record.consensus,as_of:'2026-08-01'}},now),/Медианная цель/);
 assert.doesNotMatch(outlookCard(crypto,{...model,model_forecast:{...model.model_forecast,as_of:'2026-09-20'}},now),/Алгоритмический прогноз/);
});
test('free gating hides new model targets and links from every non-largest asset',()=>{
 const record={checked_at:now.toISOString(),model_forecast:parseCryptoForecast(cryptoHtml,crypto,now)};
 const assets=[stock,crypto],records={[crypto.key]:record};
 const hidden=outlookBody(1,assets,records,{key:stock.key},{tier:'free'},0,now);
 assert.doesNotMatch(JSON.stringify(hidden),/coincodex.com|0,007645/);assert.match(hidden.text,/🔒/);
 const shown=outlookBody(1,assets,records,{key:crypto.key},{tier:'free'},0,now);
 assert.match(shown.text,/0,007645/);assert.ok(shown.text.length<4096);
});
test('newest quote replaces an older cache quote only when usable, never with a stale/future/empty price',()=>{
 const old={status:'ok',price:100,currency:'USD',as_of:'2026-09-25T12:00:00Z'},fresh={...old,price:110,as_of:'2026-09-29T12:00:00Z'};
 assert.equal(newestQuote(old,fresh,now),fresh);assert.equal(newestQuote(fresh,old,now),fresh);
 for(const q of [{...fresh,price:0},{...fresh,price:Infinity},{...fresh,as_of:'2026-08-01'},{...fresh,as_of:'2026-10-01'}])assert.equal(newestQuote(old,q,now),old);
});
function sourceDb(){
 const records=new Map();return {records,get:async(t,q)=>t==='pr_outlook_sources'?[records.get(q.source_key.slice(3))].filter(Boolean):[],
 post:async(t,b)=>{if(t!=='pr_outlook_sources')return [];if(records.has(b.source_key))return [];records.set(b.source_key,b);return [b];},
 patch:async(t,b,q)=>Object.assign(records.get(q.source_key.slice(3)),b)};
}
test('new providers collect once per asset/day, keep source types separate and do not call AI',async()=>{
 const db=sourceDb(),calls=[];
 const fetcher=async url=>{calls.push(url);if(url.includes('stockanalysis.com'))return stockHtml;if(url.includes('coincodex.com'))return cryptoHtml;throw new Error('source_http_503');};
 const p=new OutlookProvider(db,{now,fetcher});
 const c=await p.collect(crypto),s=await p.collect(stock);
 assert.equal(c.status,'model');assert.equal(c.consensus,null);assert.equal(c.source_statuses.coincodex,'ok');
 assert.equal(s.status,'consensus');assert.equal(s.consensus.count,12);
 await new OutlookProvider(db,{now,fetcher}).collect(stock);await p.collect(crypto);
 assert.equal(calls.filter(u=>u.includes('stockanalysis.com')).length,1);assert.equal(calls.filter(u=>u.includes('coincodex.com')).length,1);
 assert.ok(calls.every(u=>!u.includes('openai')));
});
test('source failure is visible and retains a recent model only until its own expiry',async()=>{
 const previous={model_forecast:parseCryptoForecast(cryptoHtml,crypto,now)};
 const collect=async (n,html)=>{const db=sourceDb(),p=new OutlookProvider(db,{now:n,fetcher:async url=>{if(url.includes('coincodex.com'))return html;throw new Error('source_http_503');}});return {result:await p.collect(crypto,previous),db};};
 const fresh=await collect(now,cryptoHtml.replace('(PENGU)','(OTHER)'));
 assert.equal(fresh.result.status,'model');assert.equal(fresh.result.source_statuses.coincodex,'unavailable');assert.equal(fresh.db.records.get('coincodex:'+crypto.key).error,'source_identity');
 const expired=await collect(new Date(+now+3*86400000),'broken page');assert.equal(expired.result.model_forecast,null);assert.equal(expired.result.status,'unavailable');
});
test('Russian issuer aliases find Rusagro without changing its ISIN identity',()=>{
 assert.equal(assetMention({name:'Группа Русагро',symbol:'RAGR'},'Русагро: прогноз аналитиков'),true);
});
