import test from 'node:test';
import assert from 'node:assert/strict';
import {TBank,paymentUrl} from '../src/tbank.js';
test('checkout links accept only HTTPS bank hosts',()=>{
 assert.equal(paymentUrl('https://securepay.tinkoff.ru/test'),'https://securepay.tinkoff.ru/test');
 for(const s of ['http://securepay.tinkoff.ru','https://tinkoff.ru.evil.test','https://user@securepay.tinkoff.ru','javascript:alert(1)'])assert.equal(paymentUrl(s),null);
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
 const radar={db:{rpc:async(name)=>{if(name==='pr_tbank_due')return [{...order,charge_started_at:charged?'2026-09-01':null}];if(name==='pr_tbank_claim'){if(charged)return null;charged=true;return {rebill_id:'456'};}if(name==='pr_tbank_event'){granted++;return {};}},patch:async()=>[order]},flush:async()=>{}};
 const bank=new TBank(radar);bank.gateway=async method=>{calls.push(method);if(method==='Charge')throw new Error('bank_status_unknown');return {OrderId:order.id,PaymentId:'123',Amount:29000,Success:true,Status:'CONFIRMED'};};
 await bank.work();assert.equal(granted,0);await bank.work();assert.deepEqual(calls,['Charge','GetState']);assert.equal(granted,1);
});
