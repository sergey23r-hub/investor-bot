import test from 'node:test';
import assert from 'node:assert/strict';
import {Billing,invoiceId,PERIOD} from '../src/billing.js';
import {usageRecord} from '../src/usage.js';
import {createHandler} from '../src/app.js';
import {digestText} from '../src/core.js';
const id='12345678-1234-1234-1234-123456789abc';
test('checkout invoices are recurring Stars subscriptions with one fixed amount',async()=>{
 let invoice,reply;
 const radar={db:{rpc:async name=>name==='pr_access'?{enabled:true,paid_until:null}:{id,price_stars:1234,asset_limit:20}},telegram:async(method,body)=>{assert.equal(method,'createInvoiceLink');invoice=body;return 'https://t.me/$test';},reply:async(...args)=>{reply=args;}};
 await new Billing(radar).menu({id:1},42,true);
 assert.equal(invoice.subscription_period,PERIOD);assert.equal(PERIOD,2592000);assert.equal(invoice.currency,'XTR');assert.deepEqual(invoice.prices,[{label:'Подписка на 30 дней',amount:1234}]);assert.equal(invoiceId(invoice.payload),id);assert.equal(reply[3][0][0].url,'https://t.me/$test');
});
test('disabled sales cannot create an invoice or charge a customer',async()=>{
 const billing=new Billing({db:{rpc:async()=>({enabled:false})},reply:async()=>{},telegram:async()=>{assert.fail('must not contact checkout');}});
 await billing.menu({},42,true);
});
test('payment confirmation passes authenticated amount, buyer, recurring flag and exact expiry to transaction',async()=>{
 let args;const billing=new Billing({db:{rpc:async(name,p)=>{assert.equal(name,'pr_payment');args=p;return {duplicate:true};}},reply:async()=>assert.fail('duplicate must not deliver twice')});
 await billing.payment({},42,{date:1000,successful_payment:{currency:'XTR',total_amount:100,invoice_payload:'pr:'+id,telegram_payment_charge_id:'charge',subscription_expiration_date:2593000,is_recurring:true,is_first_recurring:true}});
 assert.equal(args.p_user,42);assert.equal(args.p_expiry,2593000);assert.equal(args.p_recurring,true);
 assert.equal(invoiceId('pr:'+id+';drop'),null);
});
test('failed cancellation does not mark subscription as canceled locally',async()=>{
 let changes=0;const billing=new Billing({db:{get:async table=>table==='pr_invoices'?[{id,first_charge_id:'first'}]:[{charge_id:'latest'}],patch:async()=>{changes++;}},telegram:async()=>{throw new Error('http_500');}});
 await assert.rejects(()=>billing.cancel(42));assert.equal(changes,0);
});
test('pre-checkout is answered immediately without waiting for research worker or enqueue',async()=>{
 const old=globalThis.fetch;let answer,queued=false;
 globalThis.fetch=async(url,options)=>{assert.match(url,/answerPreCheckoutQuery$/);answer=JSON.parse(options.body);return Response.json({ok:true,result:true});};
 const db={rpc:async(name)=>{if(name==='pr_config')return {telegram_token:'test',webhook_secret:'wh'};if(name==='pr_checkout')return true;queued=true;}};
 try{const handler=createHandler({},()=>assert.fail('no worker'),db);const res=await handler(new Request('https://example/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'wh'},body:JSON.stringify({update_id:1,pre_checkout_query:{id:'q',from:{id:42},currency:'XTR',total_amount:100,invoice_payload:'pr:'+id}})}));assert.equal(res.status,200);assert.equal(answer.ok,true);assert.equal(queued,false);}finally{globalThis.fetch=old;}
});
test('usage counts billable tool calls, not source URLs; cached input is discounted',()=>{
 const r=usageRecord({id:'resp_test',model:'gpt-5.4-mini',usage:{input_tokens:10000,input_tokens_details:{cached_tokens:4000},output_tokens:1000},output:[{type:'web_search_call',action:{sources:Array(99).fill({url:'https://example.com'})}}]},'research');
 assert.equal(r.search_calls,1);assert.ok(Math.abs(r.estimated_usd-0.0193)<1e-9);
});
test('20-asset long digest fits Telegram messages, keeps HTML balanced, links all news and escapes content',()=>{
 const positions=Array.from({length:20},(_,i)=>({key:'key'+i,name:'Актив <'+i+'>',symbol:'EX'+i,verified:true,kind:'stock'}));
 const news=Object.fromEntries(positions.map((p,i)=>[p.key,{status:'ok',items:[{fact:'Факт '.repeat(55),relevance:'Значение '.repeat(25),url:'https://issuer.example/'+i,published_at:'2026-09-13T12:00:00Z'}],events:[]}]));
 const parts=digestText({accounts:[{name:'Счёт',updated_at:new Date(),positions}],quotes:{},news,now:new Date('2026-09-13T15:00:00Z')});
 assert.ok(parts.length>1);for(const p of parts){assert.ok(p.length<=3800);assert.equal((p.match(/<b>/g)||[]).length,(p.match(/<\/b>/g)||[]).length);assert.equal((p.match(/<a /g)||[]).length,(p.match(/<\/a>/g)||[]).length);}assert.equal((parts.join('').match(/https:\/\/issuer.example\//g)||[]).length,20);assert.doesNotMatch(parts.join(''),/Актив <\d/);
});
