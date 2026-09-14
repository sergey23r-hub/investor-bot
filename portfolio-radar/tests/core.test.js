import test from 'node:test';
import assert from 'node:assert/strict';
import {decimal,normalizeRows,prepareRows,mergePositions,validateNews,digestText,extractFile,sourceUrls,splitText,html,jsonOutput} from '../src/core.js';
import {createHandler,timingSafe,Radar,Database} from '../src/app.js';
import {Providers,extractPortfolio,extractionSchema} from '../src/providers.js';
const asset=(key,quantity,extra={})=>({key,name:key,quantity,average_price:null,observed_value:null,verified:true,...extra});
test('decimal keeps exact fractional crypto balances without floating-point conversion',()=>{
 assert.equal(decimal(' 0,000000000000000123 '),'0.000000000000000123');
 assert.equal(decimal('1 234,5000'),'1234.5');assert.equal(decimal('?'),null);
 for(const s of ['1,234.50','-2','1e8','Infinity','123 USD'])assert.throws(()=>decimal(s));
});
test('overlapping screenshots describe a balance, not transactions',()=>{
 const a=asset('BTC','0.12');assert.equal(normalizeRows([a,{...a}]).length,1);
 assert.throws(()=>normalizeRows([a,{...a,quantity:'0.2'}]),/Разное количество/);
});
test('broker rows with identical names and different balances survive preview separately',()=>{
 const rows=prepareRows([asset('moex:TEST','31',{observed_value:'2176.2'}),asset('moex:TEST','11',{observed_value:'0'}),asset('coin','2')]);
 assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.key)).size,3);
 assert.deepEqual(rows.slice(0,2).map(r=>r.quantity),['31','11']);
 assert.ok(rows.slice(0,2).every(r=>!r.verified&&r.provider===null));
 assert.equal(rows[1].observed_value,'0');assert.equal(prepareRows([asset('coin','2'),asset('coin','2')]).length,1);
 assert.equal(mergePositions([],rows).length,3);
});
test('empty successful PostgREST inserts and ignored duplicates are not JSON failures',async()=>{
 const original=globalThis.fetch;const db=new Database('https://db.example','test');
 try{
  for(const status of [200,201,204]){globalThis.fetch=async()=>new Response(null,{status});assert.equal(await db.post('pr_outbox',{}, {},'return=minimal'),null);}
  globalThis.fetch=async()=>Response.json([{id:1}],{status:201});assert.deepEqual(await db.post('pr_outbox',{}),[{id:1}]);
  globalThis.fetch=async()=>new Response('{broken',{status:200});await assert.rejects(()=>db.get('pr_cache'),SyntaxError);
 }finally{globalThis.fetch=original;}
});
test('cache write outages do not invalidate a successfully retrieved instrument',async()=>{
 const p=new Providers({}, {get:async()=>null,set:async()=>{throw new Error('cache_down');}});
 assert.deepEqual(await p.memo('test',60,async()=>({id:'known'})),{id:'known'});
});
test('suspended shares still resolve, while indices and derivatives are excluded',async()=>{
 const p=new Providers({},{});
 p.memo=async()=>({securities:{columns:['secid','shortname','name','isin','is_traded','group'],data:[['TEST','Example','Example Corp','US0000000001',0,'stock_shares'],['INDEX','Example','Example',null,1,'stock_index']]}});
 const r=await p.resolve({name:'Example',kind:'stock'});assert.equal(r.verified,true);assert.equal(r.provider_id,'TEST');
});
test('one ISIN on multiple boards does not create ambiguous securities',async()=>{
 const p=new Providers({},{});
 p.memo=async()=>({securities:{columns:['secid','name','isin','is_traded','group'],data:[['EX','Example','US0000000001',0,'stock_shares'],['EX-RM','Example','US0000000001',1,'stock_shares']]}});
 assert.equal((await p.resolve({name:'Example',kind:'stock'})).provider_id,'EX-RM');
});
test('full company names can resolve without a visible ticker',async()=>{
 const p=new Providers({},{});p.memo=async key=>key==='catalog:sec'?{0:{ticker:'EX',title:'EXAMPLE CORP',cik_str:123}}:{securities:{columns:[],data:[]}};
 assert.equal((await p.resolve({name:'Example Corporation',kind:'stock'})).provider_id,'EX');
});
test('preview with uncertain positions offers explicit preservation with notes',async()=>{
 const radar=new Radar({get:async()=>[{name:'Account',positions:[]}]});let preview;
 radar.reply=async(_job,_user,text,keys)=>{preview={text,keys};};
 await radar.preview({id:1},1,{id:'import',rows:[asset('unknown','3',{verified:false})],mode:'partial'});
 assert.equal(preview.keys[0][0].callback_data,'save_notes:import');assert.match(preview.text,/количество и название сохранятся/);
});
test('partial update retains unseen positions and replaces observed quantities',()=>{
 const result=mergePositions([asset('BTC','1'),asset('SBER','20')],[asset('BTC','2')]);
 assert.deepEqual(result.map(x=>[x.key,x.quantity]),[['BTC','2'],['SBER','20']]);
});
test('replacement removes unseen positions only in explicit replacement mode',()=>{
 assert.deepEqual(mergePositions([asset('BTC','1'),asset('SBER','20')],[asset('BTC','2')],'replace').map(x=>x.key),['BTC']);
});
test('zero closes a position, unknown quantity remains unknown',()=>{
 assert.equal(mergePositions([asset('BTC','1')],[asset('BTC','0')]).length,0);
 assert.equal(mergePositions([asset('BTC','1')],[asset('BTC',null)])[0].quantity,null);
});
test('unknown quantity does not retain a stale average purchase price',()=>{
 assert.equal(mergePositions([asset('BTC','1',{average_price:'100'})],[asset('BTC',null)])[0].average_price,null);
});
const now=new Date('2026-09-12T20:00:00Z'),url='https://issuer.example/report';
const story={fact:'Отчёт опубликован',relevance:'Изменились показатели бизнеса',url,published_at:'2026-09-12T10:00:00Z',event_date:'2026-09-12T08:00:00Z'};
test('news must have real retrieved source, fresh publication and event date',()=>{
 assert.equal(validateNews([story],[url],now).length,1);
 assert.equal(validateNews([story],[],now).length,0);
 assert.equal(validateNews([{...story,published_at:'2026-08-12T10:00:00Z'}],[url],now).length,0);
 assert.equal(validateNews([{...story,event_date:'2026-08-12T10:00:00Z'}],[url],now).length,0);
 assert.equal(validateNews([{...story,published_at:'2026-09-13T10:00:00Z'}],[url],now).length,0);
});
test('tracking parameters cannot duplicate the same article',()=>{
 assert.equal(validateNews([story,{...story,url:url+'?utm_source=x'}],[url],now).length,1);
});
test('digest distinguishes outage from no news and escapes account data',()=>{
 const p=asset('SBER','10',{name:'<script>'});const parts=digestText({accounts:[{name:'<bank>',updated_at:now.toISOString(),positions:[p]}],quotes:{},news:{},now});
 assert.match(parts.join(''),/Не удалось проверить новости/);assert.match(parts.join(''),/&lt;script&gt;/);assert.doesNotMatch(parts.join(''),/<script>/);
 const noNews=digestText({accounts:[{name:'x',updated_at:now.toISOString(),positions:[p]}],quotes:{},news:{SBER:{status:'ok',items:[]}},now});assert.match(noNews.join(''),/Значимых новостей/);
});
test('photo receipt uses highest resolution and rejects non-image files',()=>{
 assert.equal(extractFile({photo:[{file_id:'low'},{file_id:'high'}]}).file_id,'high');
 assert.throws(()=>extractFile({document:{mime_type:'application/pdf'}}));
 assert.throws(()=>extractFile({photo:[{file_size:10*1024*1024}]}));
});
test('Telegram message chunks preserve HTML blocks',()=>{
 const chunks=splitText(Array.from({length:100},()=>'<b>Сбер</b>\nКоличество: 20').join('\n\n'));
 assert.ok(chunks.every(x=>x.length<=3800&&x.match(/<b>/g).length===x.match(/<\/b>/g).length));
});
test('incomplete model responses cannot become a confirmed portfolio',()=>{
 assert.throws(()=>jsonOutput({status:'incomplete',output:[]}));
 assert.throws(()=>jsonOutput({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]}));
});
test('source collection uses retrieval results and inline citations',()=>{
 assert.deepEqual(sourceUrls({output:[{action:{sources:[{url:'https://a.example'}]}},{content:[{annotations:[{type:'url_citation',url:'https://b.example'}]}]}]}),['https://a.example','https://b.example']);
});
test('missing secrets do not authenticate',()=>{
 assert.equal(timingSafe(null,undefined),false);assert.equal(timingSafe('',''),false);assert.equal(timingSafe('abc','xyz'),false);assert.equal(timingSafe('abc','abc'),true);
});
test('webhook rejects unauthenticated requests before storing any update',async()=>{
 let queue=0;const db={rpc:async(name)=>{if(name==='pr_config')return {webhook_secret:'secret',worker_secret:'worker'};queue++;}};
 const handler=createHandler({},()=>{},db);
 for(const header of [undefined,'wrong']){
 const r=await handler(new Request('https://example.com/webhook',{method:'POST',headers:header?{'x-telegram-bot-api-secret-token':header}:{},body:'{"update_id":1}'}));assert.equal(r.status,401);
 }assert.equal(queue,0);
});
test('valid webhook durably queues before acknowledgement and never requires AI readiness',async()=>{
 const calls=[];const db={rpc:async(name,body)=>{calls.push([name,body]);return name==='pr_config'?{webhook_secret:'secret'}:null;}};
 const handler=createHandler({},()=>{},db);const response=await handler(new Request('https://example.com/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body:JSON.stringify({update_id:12,message:{text:'/start'}})}));
 assert.equal(response.status,200);assert.equal(calls.at(-1)[1].p_key,'update:12');
});
test('failed durable enqueue returns non-2xx so Telegram can retry',async()=>{
 const db={rpc:async name=>{if(name==='pr_config')return {webhook_secret:'secret'};throw new Error('db_down');}};
 const r=await createHandler({},()=>{},db)(new Request('https://example.com/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body:'{"update_id":1}'}));assert.equal(r.status,500);
});
test('worker endpoints reject Telegram secret and require a separate secret',async()=>{
 const db={rpc:async()=>({webhook_secret:'secret',worker_secret:'worker'})};const r=await createHandler({},()=>{},db)(new Request('https://example.com/work',{method:'POST',headers:{'x-portfolio-worker-secret':'secret'}}));assert.equal(r.status,401);
});
test('ambiguous crypto symbols require correction; explicit full ID resolves',async()=>{
 const p=new Providers({},{});p.coins=async()=>[{id:'alpha',name:'Alpha',symbol:'abc'},{id:'beta',name:'Beta',symbol:'abc'}];
 assert.equal((await p.resolve({kind:'crypto',name:'ABC',symbol:'ABC'})).verified,false);
 assert.equal((await p.resolve({kind:'crypto',name:'alpha',provider_id:'alpha'})).key,'cg:alpha');
});
test('screenshots with uncertain unit quantities do not silently become verified holdings',async()=>{
 const p=new Providers({},{});const r=await p.resolve({kind:'stock',name:'SBER',issue:'Количество указано в лотах'});assert.equal(r.verified,false);
});
test('private chat ownership is checked before looking up a portfolio',async()=>{
 const radar=new Radar({});let used=false;radar.user=async()=>{used=true};
 await radar.handleUpdate({payload:{message:{from:{id:1},chat:{id:2,type:'private'},text:'/portfolio'}}});assert.equal(used,false);
 await radar.handleUpdate({payload:{message:{from:{id:1},chat:{id:1,type:'group'},text:'/portfolio'}}});assert.equal(used,false);
});
test('OpenAI extraction sends a strict schema and disables response storage',async()=>{
 const old=globalThis.fetch;let body;
 globalThis.fetch=async(_url,opts)=>{body=JSON.parse(opts.body);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({positions:[{name:'BTC'}]})}]}]});};
 try{await extractPortfolio(['data:image/png;base64,AA=='],'test-key');assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.deepEqual(body.text.format.schema,extractionSchema);assert.equal(body.input[0].content[1].type,'input_image');}finally{globalThis.fetch=old;}
});
test('news response with invented source is not reported as no news',async()=>{
 const old=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[{url:'https://real.example'}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify({items:[story],events:[]})}]}]});
 try{const n=await new Providers({openai_key:'test-key'},{}).news({key:'stock',name:'x'},now);assert.equal(n.status,'unverified');assert.equal(n.items.length,0);}finally{globalThis.fetch=old;}
});
test('registration uses configured public origin rather than internal request URL',async()=>{
 const original=Radar.prototype.register;let target;
 Radar.prototype.register=async function(base){target=base;return {username:'test_bot'};};
 try{
  const db={rpc:async()=>({worker_secret:'worker'})};
  const handler=createHandler({SUPABASE_URL:'https://public-project.supabase.co/'},()=>{},db);
  const response=await handler(new Request('http://internal-runtime:9000/portfolio-radar/register',{method:'POST',headers:{'x-portfolio-worker-secret':'worker'}}));
  assert.equal(response.status,200);assert.equal(target,'https://public-project.supabase.co/functions/v1/portfolio-radar');
 }finally{Radar.prototype.register=original;}
});
