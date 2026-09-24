const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const CONSENT='rub-weekly-v1';
const ORDER=/^pr_[a-f0-9]{32}$/;
const STATUS=new Set(['NEW','FORM_SHOWED','AUTHORIZING','AUTHORIZED','CONFIRMING','CONFIRMED','3DS_CHECKING','3DS_CHECKED','REJECTED','CANCELED','DEADLINE_EXPIRED','REFUNDED','PARTIAL_REFUNDED','REVERSING','REVERSED','REFUNDING']);
export function bankDiagnostic(method,result={},now=new Date()){
 return {method,checked_at:now.toISOString(),success:typeof result.Success==='boolean'?result.Success:null,
  error_code:/^\d{1,6}$/.test(String(result.ErrorCode))?String(result.ErrorCode):null,
  status:STATUS.has(result.Status)?result.Status:null,
  order_id:ORDER.test(result.OrderId||'')?result.OrderId:null,
  payment_id:/^\d{1,20}$/.test(String(result.PaymentId))?String(result.PaymentId):null,
  amount:result.Amount!==null&&result.Amount!==undefined&&Number.isSafeInteger(Number(result.Amount))?Number(result.Amount):null};
}
const failureCode=(step,result)=>step+'_rejected:'+(/^\d{1,6}$/.test(String(result?.ErrorCode))?String(result.ErrorCode):'unknown');
export function paymentUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['tinkoff.ru','tbank.ru'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}}
export class TBank{
 constructor(radar){this.radar=radar;this.db=radar.db;}
 async record(order,method,result,transportError=false){
  const value={...bankDiagnostic(method,result),...(transportError?{transport_error:'bank_status_unknown'}:{})};
  // Store an allowlist only: no RebillId, card details, signatures, URLs, or raw
  // bank Message/Details. A failed log write must not discard a successful payment.
  try{await this.db.post('pr_cache',{key:'tbank:diagnostic:v1:'+order.id+':'+method,value,expires_at:new Date(Date.now()+90*86400000).toISOString()},{on_conflict:'key'},'resolution=merge-duplicates,return=minimal');}catch{console.error('bank_diagnostic_pending');}
  return value;
 }
 async audit(orderId){
  if(!ORDER.test(orderId||''))return {error:'invalid_order'};
  const order=(await this.db.get('pr_tbank_orders',{id:'eq.'+orderId,limit:1}))[0];
  if(!order)return {error:'order_not_found'};
  const saved=await Promise.all(['Init','Charge','GetState'].map(method=>this.db.get('pr_cache',{key:'eq.tbank:diagnostic:v1:'+order.id+':'+method,limit:1})));
  const result={order_id:order.id,cycle:order.cycle,stored_status:order.provider_status,charge_started_at:order.charge_started_at,confirmed_at:order.confirmed_at,last_error:order.last_error,diagnostics:saved.flatMap(rows=>rows.map(r=>r.value))};
  if(!order.payment_id)return {...result,bank:null};
  try{
   const b=await this.gateway('GetState',{order_id:order.id,payment_id:order.payment_id});
   return {...result,bank:bankDiagnostic('GetState',b),matches_order:b.OrderId===order.id&&String(b.PaymentId)===order.payment_id&&Number(b.Amount)===order.amount_kopecks};
  }catch{return {...result,bank:null,error:'bank_status_unknown'};}
 }
 async gateway(method,params={}){
  const cfg=this.radar.config;if(!cfg.gateway_signing_key||!cfg.gateway_url)throw new Error('billing_unavailable');
  const key=await crypto.subtle.importKey('jwk',JSON.parse(cfg.gateway_signing_key),{name:'Ed25519'},false,['sign']);
  const raw=new TextEncoder().encode(JSON.stringify({method,params,timestamp:Date.now(),request_id:crypto.randomUUID()}));
  const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,raw));
  let r;try{r=await fetch(cfg.gateway_url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:b64(raw),signature:b64(signature)}),signal:AbortSignal.timeout(method==='Charge'?30000:18000)});}catch{throw new Error('bank_status_unknown');}
  if(!r.ok)throw new Error('bank_status_unknown');return r.json();
 }
 async initialize(order){
  if(order.payment_url)return order;
  const claimed=await this.db.rpc('pr_tbank_claim',{p_order:order.id,p_step:'init'});
  if(!claimed)return (await this.db.get('pr_tbank_orders',{id:'eq.'+order.id,limit:1}))[0];
  try{
   const b=await this.gateway('Init',{order_id:order.id,subscription_id:order.subscription_id,kind:order.cycle===0?'initial':'renewal'});
   await this.record(order,'Init',b);
   if(b.Success!==true||!/^\d{1,20}$/.test(String(b.PaymentId))||b.OrderId!==order.id||Number(b.Amount)!==29000){
    await this.fail(order,failureCode('init',b));throw new Error('bank_checkout_rejected');
   }
   const url=paymentUrl(b.PaymentURL);if(order.cycle===0&&!url)throw new Error('bank_status_unknown');
   const rows=await this.db.patch('pr_tbank_orders',{payment_id:String(b.PaymentId),payment_url:url,provider_status:b.Status||'NEW',check_at:new Date(Date.now()+60000).toISOString()},{id:'eq.'+order.id,confirmed_at:'is.null'});
   return rows[0];
  }catch(e){await this.db.patch('pr_tbank_orders',{last_error:e.message==='bank_checkout_rejected'?'init_rejected':'init_status_unknown'},{id:'eq.'+order.id,last_error:'is.null',confirmed_at:'is.null'});throw e;}
 }
 async checkout(user){return this.initialize(await this.db.rpc('pr_tbank_begin',{p_user:user,p_consent:CONSENT}));}
 async notification(body){
  if(!/^pr_[a-f0-9]{32}$/.test(body?.OrderId||''))return false;
  const order=(await this.db.get('pr_tbank_orders',{id:'eq.'+body.OrderId,select:'id,payment_id',limit:1}))[0];
  if(!order||String(body.PaymentId)!==order.payment_id)return false;
  const verified=await this.gateway('Verify',{notification:body});if(!verified.valid)return false;
  // For refunds, resolve the current remaining amount before adjusting referrals.
  if(['REFUNDED','PARTIAL_REFUNDED'].includes(body.Status))body=await this.gateway('GetState',{order_id:order.id,payment_id:order.payment_id});
  await this.db.rpc('pr_tbank_event',{p_body:body});return true;
 }
 async fail(order,reason){
  if(!await this.db.rpc('pr_tbank_fail',{p_order:order.id,p_reason:reason}))return;
  await this.radar.reply({id:'tbank-failed:'+order.id},order.user_id,'Не удалось оформить или продлить подписку. Повторных автосписаний не будет.\n\n/subscribe — подключить снова. После окончания полного доступа сводка продолжится по трём активам.',null,'billing_failure');
 }
 async work(){
  const rows=await this.db.rpc('pr_tbank_due');
  for(let order of rows||[]){
   const won=await this.db.patch('pr_tbank_orders',{check_at:new Date(Date.now()+120000).toISOString(),attempts:order.attempts+1},{id:'eq.'+order.id,attempts:'eq.'+order.attempts});if(!won?.length)continue;
   try{
    if(!order.init_started_at)order=await this.initialize(order);
    if(!order?.payment_id){if(order&&new Date(order.expires_at)<=new Date())await this.fail(order,'init_status_unknown');continue;}
    if(order.cycle>0&&!order.charge_started_at){
     const claimed=await this.db.rpc('pr_tbank_claim',{p_order:order.id,p_step:'charge'});
     if(claimed){
      let charged;
      try{charged=await this.gateway('Charge',{order_id:order.id,payment_id:order.payment_id,rebill_id:claimed.rebill_id});}
      catch(e){await this.record(order,'Charge',{},true);throw e;}
      await this.record(order,'Charge',charged);
      if(charged.Success===false){
       order.last_error=failureCode('charge',charged);
       await this.db.patch('pr_tbank_orders',{last_error:order.last_error},{id:'eq.'+order.id,confirmed_at:'is.null'});
      }
     }
    }
    // Charge itself is NEVER automatically retried, including a network timeout.
    const state=await this.gateway('GetState',{order_id:order.id,payment_id:order.payment_id});
    await this.record(order,'GetState',state);
    if(state.Success===true&&state.OrderId===order.id)await this.db.rpc('pr_tbank_event',{p_body:state});
    else await this.db.patch('pr_tbank_orders',{last_error:'reconciliation_pending'},{id:'eq.'+order.id,last_error:'is.null',confirmed_at:'is.null'});
    if(new Date(order.expires_at)<=new Date()&&state.Status==='NEW')await this.fail(order,order.last_error||'payment_not_completed');
   }catch{await this.db.patch('pr_tbank_orders',{last_error:'reconciliation_pending'},{id:'eq.'+order.id,last_error:'is.null',confirmed_at:'is.null'});}
  }
  await this.radar.flush();return {processed:rows?.length||0};
 }
}
