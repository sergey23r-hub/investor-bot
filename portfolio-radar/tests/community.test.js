import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {membership,COMMUNITY_IDS} from '../src/community.js';
import {TBank} from '../src/tbank.js';
import {Billing} from '../src/billing.js';
import {bankRequest,handleGateway} from '../gateway/src/portfolio-gateway.mjs';
const keys=generateKeyPairSync('ed25519'),config={gateway_signing_key:JSON.stringify(keys.privateKey.export({format:'jwk'})),community_pricing_enabled:true};
function response(states){return {user_id:42,eligible:states.includes('member')?true:states.includes('unknown')?null:false,checked_at:new Date().toISOString(),checks:states.map((state,i)=>({chat_id:COMMUNITY_IDS[i],state}))};}
test('membership signs only fixed-purpose requests and discounts either or both communities',async()=>{
 for(const states of [['member','not_member'],['not_member','member'],['member','member'],['member','unknown'],['not_member','not_member']]){
  const q=await membership(config,42,async(url,opts)=>{assert.equal(url,'https://micbot.vercel.app/integrations/portfolius/membership');const e=JSON.parse(opts.body),raw=Buffer.from(e.payload,'base64url');assert.ok(verify(null,raw,keys.publicKey,Buffer.from(e.signature,'base64url')));assert.equal(JSON.parse(raw).method,'CommunityMembership');return Response.json(response(states));});
  assert.equal(q.amount_kopecks,states.includes('member')?14500:29000);
 }
});
test('unavailable, stale or mismatched membership never falls back to full price',async()=>{
 for(const value of [response(['unknown','not_member']),{...response(['member','member']),user_id:43},{...response(['member','member']),checked_at:'2020-01-01'}, {...response(['member','member']),checks:[{chat_id:1,state:'member'}]}])await assert.rejects(()=>membership(config,42,async()=>Response.json(value)),/membership_unavailable/);
 await assert.rejects(()=>membership(config,42,async()=>new Response('',{status:503})),/membership_unavailable/);
});
test('membership price change at checkout prevents creating a bank invoice',async()=>{
 const bank=new TBank({config,db:{rpc:async()=>assert.fail('must not create order')}});bank.quote=async()=>({amount_kopecks:29000});
 await assert.rejects(()=>bank.checkout(42,14500),/membership_price_changed/);
});
test('new pricing needs fresh explicit consent and displays the actual discounted amount',async()=>{
 let calls=0,out;const billing=new Billing({config,db:{rpc:async()=>({tier:'free',checkout_enabled:true}),get:async()=>[]},reply:async(...a)=>out=a});
 billing.bank.quote=async()=>({amount_kopecks:14500,eligible:true});billing.bank.checkout=async(user,amount)=>{calls++;assert.equal(amount,14500);return {amount_kopecks:14500,payment_url:'https://pay.tbank-online.com/pay'};};
 await billing.menu({},42,true);assert.equal(calls,0);assert.equal(out[3][0][0].callback_data,'billing:buy:14500');assert.match(out[2],/После выхода из обоих/);
 await billing.menu({},42,true,14500);assert.equal(calls,1);assert.match(out[3][0][0].text,/145 ₽/);
});
test('unknown participation during renewal cannot charge and remains retryable',async()=>{
 const order={id:'pr_'+'a'.repeat(32),user_id:42,cycle:1,amount_kopecks:14500,payment_id:'123',init_started_at:'2026-09-01',attempts:1,expires_at:'2100-01-01'},writes=[];
 const bank=new TBank({config,db:{rpc:async n=>{assert.equal(n,'pr_tbank_due');return [order];},patch:async(t,b)=>{writes.push(b);return [order];}},flush:async()=>{}});
 bank.quote=async()=>{throw Error('membership_unavailable');};bank.gateway=async()=>assert.fail('must not call bank');await bank.work();assert.equal(writes.at(-1).last_error,'membership_unavailable');assert.equal(writes.at(-1).attempts,1);
});
test('adapter accepts only the two signed allowed prices and correctly describes a discounted week',()=>{
 const p={order_id:'pr_'+'a'.repeat(32),subscription_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',kind:'initial',amount_kopecks:14500};
 const b=bankRequest('Init',p,'t','s');assert.equal(b.Amount,14500);assert.match(b.Description,/145 рублей/);
 for(const amount of [0,1,14499,29001,'14500'])assert.throws(()=>bankRequest('Init',{...p,amount_kopecks:amount},'t','s'),/invalid_amount/);
});
