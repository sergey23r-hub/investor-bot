import test from 'node:test';
import assert from 'node:assert/strict';
import {TBank,bankDiagnostic} from '../src/tbank.js';
import {Billing} from '../src/billing.js';

const oldId='pr_'+'a'.repeat(32),newId='pr_'+'b'.repeat(32),url='https://pay.tbank-online.com/new/test';
function fixture({state='NEW',mismatch=false,recent=false,diagnostic=true}={}){
 const old={id:oldId,subscription_id:'old-sub',user_id:42,cycle:0,amount_kopecks:29000,init_started_at:recent?new Date().toISOString():'2026-09-01',confirmed_at:null,charge_started_at:null,payment_url:null,payment_id:null,last_error:'init_status_unknown'};
 const next={...old,id:newId,subscription_id:'new-sub',init_started_at:null,last_error:null};
 const orders=new Map([[old.id,old],[next.id,next]]),sub={status:'pending',renew_enabled:true};
 const calls=[],events=[],cache=new Map();let retired=0,inits=0;
 if(diagnostic)cache.set('tbank:diagnostic:v1:'+old.id+':Init',bankDiagnostic('Init',{Success:true,OrderId:old.id,PaymentId:'123',Amount:29000,Status:'NEW'}));
 const db={
  get:async(table,q)=>table==='pr_tbank_orders'?[{...orders.get(q.id.slice(3))}]:cache.has(q.key.slice(3))?[{value:cache.get(q.key.slice(3))}]:[],
  post:async(_table,body)=>{cache.set(body.key,body.value);return [];},
  patch:async(table,body,q)=>{
   if(table==='pr_tbank_subscriptions'){
    assert.equal(q.id,'eq.old-sub');assert.equal(q.user_id,'eq.42');assert.equal(q.status,'eq.pending');
    assert.equal(q.renew_enabled,'eq.true');assert.equal(q.cancelled_at,'is.null');
    if(sub.status!=='pending'||!sub.renew_enabled)return [];
    Object.assign(sub,body);retired++;return [{...sub}];
   }
   const o=orders.get(q.id.slice(3));
   if(q.last_error==='is.null'&&o.last_error!==null||q.payment_url==='is.null'&&o.payment_url!==null||q.confirmed_at==='is.null'&&o.confirmed_at)return [];
   Object.assign(o,body);return [{...o}];
  },
  rpc:async(name,p)=>{
   if(name==='pr_tbank_begin')return {...(retired?next:old)};
   if(name==='pr_tbank_claim'){
    assert.equal(p.p_step,'init');const o=orders.get(p.p_order);
    if(o.init_started_at)return null;o.init_started_at=new Date().toISOString();return {...o};
   }
   if(name==='pr_tbank_event'){events.push(p.p_body.Status);if(p.p_body.Status==='CONFIRMED')sub.status='active';return {};}
   assert.fail('unexpected rpc '+name);
  }
 };
 const bank=new TBank({db});
 bank.gateway=async(method,p)=>{
  calls.push(method);assert.notEqual(method,'Charge');
  if(method==='GetState')return {Success:true,Status:state,OrderId:mismatch?newId:p.order_id,PaymentId:p.payment_id,Amount:29000};
  assert.equal(method,'Init');assert.equal(p.kind,'initial');assert.equal(p.order_id,newId);inits++;
  return {Success:true,Status:'NEW',OrderId:newId,PaymentId:'456',Amount:29000,PaymentURL:url};
 };
 return {bank,db,old,next,sub,cache,calls,events,counts:()=>({retired,inits})};
}

test('legacy lost checkout is reconciled then replaced once on an explicit click; subsequent clicks reuse the URL',async()=>{
 const f=fixture();const first=await f.bank.checkout(42),second=await f.bank.checkout(42);
 assert.equal(first.payment_url,url);assert.equal(second.payment_url,url);
 assert.equal(f.old.payment_id,'123');assert.deepEqual(f.calls,['GetState','Init']);
 assert.deepEqual(f.counts(),{retired:1,inits:1});assert.equal(f.sub.renew_enabled,false);
 assert.equal(f.cache.get('tbank:diagnostic:v1:'+newId+':Init').payment_url_state,'accepted');
});
test('a recently claimed Init is not replaced while its response may still be saving',async()=>{
 const f=fixture({recent:true});await f.bank.checkout(42);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.counts(),{retired:0,inits:0});
});
test('ambiguous Init without a verified bank ID is not resubmitted',async()=>{
 const f=fixture({diagnostic:false});await f.bank.checkout(42);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.counts(),{retired:0,inits:0});
});
test('a mismatched bank state cannot retire the old subscription or create a new invoice',async()=>{
 const f=fixture({mismatch:true});await assert.rejects(()=>f.bank.checkout(42),/bank_status_unknown/);
 assert.deepEqual(f.calls,['GetState']);assert.deepEqual(f.counts(),{retired:0,inits:0});assert.equal(f.old.payment_id,null);
});
test('a paid orphan is reconciled without creating a second checkout',async()=>{
 const f=fixture({state:'CONFIRMED'});await assert.rejects(()=>f.bank.checkout(42),/subscription_active/);
 assert.equal(f.old.payment_id,'123');assert.deepEqual(f.events,['CONFIRMED']);assert.deepEqual(f.calls,['GetState']);assert.deepEqual(f.counts(),{retired:0,inits:0});
});
test('an authorizing orphan and a cancelled subscription cannot be replaced',async()=>{
 for(const state of ['AUTHORIZED','AUTHORIZING','FORM_SHOWED']){
  const f=fixture({state});await f.bank.checkout(42);assert.deepEqual(f.calls,['GetState']);assert.equal(f.counts().retired,0);
 }
 const f=fixture();f.sub.renew_enabled=false;await f.bank.checkout(42);assert.deepEqual(f.calls,['GetState']);assert.equal(f.counts().retired,0);
});
test('unexpected checkout domains still preserve the bank ID and a specific error for reconciliation',async()=>{
 const f=fixture();f.next.init_started_at=null;
 f.bank.gateway=async()=>({Success:true,OrderId:newId,PaymentId:'456',Amount:29000,Status:'NEW',PaymentURL:'https://untrusted.example/pay'});
 await assert.rejects(()=>f.bank.initialize(f.next),/checkout_url_unavailable/);
 assert.equal(f.next.payment_id,'456');assert.equal(f.next.payment_url,null);assert.equal(f.next.last_error,'checkout_url_unavailable');
 assert.equal(f.cache.get('tbank:diagnostic:v1:'+newId+':Init').payment_url_state,'rejected');
});
test('read-only audit can query an orphan using the validated Init diagnostic without mutating anything',async()=>{
 const f=fixture();f.db.patch=async()=>assert.fail('audit writes');f.db.post=async()=>assert.fail('audit writes');f.db.rpc=async()=>assert.fail('audit writes');
 const result=await f.bank.audit(oldId);assert.equal(result.matches_order,true);assert.equal(result.bank.status,'NEW');assert.deepEqual(f.calls,['GetState']);assert.equal(f.old.payment_id,null);
});
test('pending checkout and checkout error offer a real continuation button',async()=>{
 let reply;const billing=new Billing({db:{rpc:async()=>({tier:'free',checkout_enabled:true}),get:async()=>[]},reply:async(...args)=>{reply=args;}});
 for(const fail of [false,true]){
  billing.bank.checkout=async()=>{if(fail)throw Error('checkout_url_unavailable');return {};};
  await billing.menu({id:1},42,true);assert.equal(reply[3][0][0].callback_data,'billing:buy');assert.match(reply[3][0][0].text,/Продолжить/);
 }
});
