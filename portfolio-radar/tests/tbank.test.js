import test from 'node:test';
import assert from 'node:assert/strict';
import {TBank,paymentUrl,bankDiagnostic} from '../src/tbank.js';
import {createHandler} from '../src/app.js';
test('checkout links accept only HTTPS bank hosts',()=>{
 assert.equal(paymentUrl('https://securepay.tinkoff.ru/test'),'https://securepay.tinkoff.ru/test');
 assert.equal(paymentUrl('https://pay.tbank-online.com/test'),'https://pay.tbank-online.com/test');
 for(const s of ['http://securepay.tinkoff.ru','https://tinkoff.ru.evil.test','https://user@securepay.tinkoff.ru','javascript:alert(1)','https://pay.tbank-online.com.evil.test','https://other.tbank-online.com','https://tbank-online.com','https://evil.pay.tbank-online.com','https://pay.tbank-online.com:8443','https://user:pass@pay.tbank-online.com'])assert.equal(paymentUrl(s),null);
});
test('unknown or unauthenticated bank callbacks never grant access',async()=>{
 let writes=0,verifications=0;const radar={db:{get:async()=>[{id:'pr_'+'a'.repeat(32),payment_id:'123'}],rpc:async()=>{writes++;}}};
 const b=new TBank(radar);b.gateway=async()=>{verifications++;return {valid:false};};
 assert.equal(await b.notification({OrderId:'yr_existing',PaymentId:'123'}),false);
 assert.equal(await b.notification({OrderId:'pr_'+'a'.repeat(32),PaymentId:'999'}),false);
 assert.equal(await b.notification({OrderId:'pr_'+'a'.repeat(32),PaymentId:'123'}),false);
 assert.equal(writes,0);assert.equal(verifications,1);
});
test('ambiguous Charge is reconciled through GetState and is never sent again',async()=>{
 const order={id:'pr_'+'a'.repeat(32),subscription_id:'s',user_id:42,payment_id:'123',cycle:1,init_started_at:'2026-09-01',expires_at:'2100-01-01',attempts:0};let charged=false,granted=0;const calls=[];
 const radar={db:{post:async()=>[],rpc:async(name)=>{if(name==='pr_tbank_due')return [{...order,charge_started_at:charged?'2026-09-01':null}];if(name==='pr_tbank_claim'){if(charged)return null;charged=true;return {rebill_id:'456'};}if(name==='pr_tbank_event'){granted++;return {};}},patch:async()=>[order]},flush:async()=>{}};
 const bank=new TBank(radar);bank.gateway=async method=>{calls.push(method);if(method==='Charge')throw new Error('bank_status_unknown');return {OrderId:order.id,PaymentId:'123',Amount:29000,Success:true,Status:'CONFIRMED'};};
 await bank.work();assert.equal(granted,0);await bank.work();assert.deepEqual(calls,['Charge','GetState']);assert.equal(granted,1);
});
test('bank diagnostic retains useful status and error code but excludes tokens, card details and arbitrary messages',()=>{
 const result=bankDiagnostic('Charge',{Success:false,ErrorCode:'10',Status:'NEW',OrderId:'pr_'+'a'.repeat(32),PaymentId:'123',Amount:29000,RebillId:'secret-rebill',Token:'secret-token',PaymentURL:'https://secret',Pan:'secret-card',Message:'private diagnostic',Details:'private details'});
 assert.equal(result.error_code,'10');assert.equal(result.success,false);assert.equal(result.amount,29000);
 assert.doesNotMatch(JSON.stringify(result),/secret|private|Token|Rebill|PaymentURL|Details|Message|Pan/);
 assert.equal(bankDiagnostic('Charge',{ErrorCode:'malicious text',Status:'arbitrary text'}).error_code,null);
});
test('a rejected Charge is recorded once and its reason survives later successful NEW-status polling',async()=>{
 const order={id:'pr_'+'a'.repeat(32),payment_id:'123',subscription_id:'s',user_id:42,cycle:1,init_started_at:'2026-09-01',charge_started_at:null,expires_at:'2100-01-01',attempts:0,last_error:null},records=new Map();let charges=0;const failures=[];
 const radar={db:{post:async(_t,b)=>records.set(b.key,b.value),patch:async(_t,b,q)=>{if(q.last_error==='is.null'&&order.last_error!==null)return [];Object.assign(order,b);return [order];},rpc:async(name,p)=>{
  if(name==='pr_tbank_due')return [{...order}];if(name==='pr_tbank_claim'){if(order.charge_started_at)return null;order.charge_started_at=new Date().toISOString();return {rebill_id:'456'};}
  if(name==='pr_tbank_fail'){failures.push(p.p_reason);return false;}
  if(name==='pr_tbank_event'){assert.equal(p.p_body.Status,'NEW');return {};}
 }},flush:async()=>{}};
 const bank=new TBank(radar);bank.gateway=async method=>method==='Charge'?(charges++,{Success:false,ErrorCode:'10',Status:'NEW',RebillId:'must-not-store'}):{Success:true,ErrorCode:'0',Status:'NEW',PaymentId:'123',OrderId:order.id,Amount:29000};
 await bank.work();await bank.work();assert.equal(charges,1);assert.equal(order.last_error,'charge_rejected:10');
 assert.equal(records.get('tbank:diagnostic:v1:'+order.id+':Charge').error_code,'10');
 assert.equal(records.get('tbank:diagnostic:v1:'+order.id+':GetState').error_code,'0');
 order.expires_at='2020-01-01';await bank.work();assert.deepEqual(failures,['charge_rejected:10']);assert.equal(charges,1);
});
test('diagnostic storage failure cannot prevent processing a confirmed payment',async()=>{
 const order={id:'pr_'+'a'.repeat(32),payment_id:'123',cycle:1,init_started_at:'2026-09-01',charge_started_at:'2026-09-01',expires_at:'2100-01-01',attempts:1};let confirmed=0;
 const bank=new TBank({db:{post:async()=>{throw Error('cache unavailable');},patch:async()=>[order],rpc:async(name)=>name==='pr_tbank_due'?[order]:name==='pr_tbank_event'?(confirmed++,{}):null},flush:async()=>{}});
 bank.gateway=async()=>({Success:true,ErrorCode:'0',Status:'CONFIRMED',OrderId:order.id,PaymentId:'123',Amount:29000});
 await bank.work();assert.equal(confirmed,1);
});
test('billing audit performs GetState only, never creates, charges, reactivates or sends a payment',async()=>{
 const order={id:'pr_'+'a'.repeat(32),payment_id:'123',cycle:1,amount_kopecks:29000,provider_status:'DEADLINE_EXPIRED',confirmed_at:null};const calls=[];
 const bank=new TBank({db:{get:async table=>table==='pr_tbank_orders'?[order]:[],post:async()=>assert.fail('audit writes'),patch:async()=>assert.fail('audit writes'),rpc:async()=>assert.fail('audit invokes payment logic')},reply:async()=>assert.fail('audit sends a message'),flush:async()=>assert.fail('audit sends a message')});
 bank.gateway=async method=>{calls.push(method);return {Success:true,ErrorCode:'0',OrderId:order.id,PaymentId:'123',Amount:29000,Status:'DEADLINE_EXPIRED',RebillId:'secret'};};
 const result=await bank.audit(order.id);assert.deepEqual(calls,['GetState']);assert.equal(result.matches_order,true);assert.equal(result.bank.status,'DEADLINE_EXPIRED');assert.doesNotMatch(JSON.stringify(result),/secret/);
 assert.deepEqual(await bank.audit('foreign-order'),{error:'invalid_order'});assert.equal(calls.length,1);
});
test('billing audit rejects public requests before examining an order',async()=>{
 const handler=createHandler({},()=>assert.fail('no background work'),{rpc:async()=>({worker_secret:'worker'})});
 const response=await handler(new Request('https://example/billing-audit',{method:'POST',body:JSON.stringify({order_id:'pr_'+'a'.repeat(32)})}));assert.equal(response.status,401);
});
