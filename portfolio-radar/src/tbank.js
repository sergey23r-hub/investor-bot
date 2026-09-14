const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export const CONSENT='rub-weekly-v1';
export function paymentUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['tinkoff.ru','tbank.ru'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}}
export class TBank{
 constructor(radar){this.radar=radar;this.db=radar.db;}
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
   if(b.Success!==true||!/^\d{1,20}$/.test(String(b.PaymentId))||b.OrderId!==order.id||Number(b.Amount)!==29000){
    await this.fail(order,'init_rejected');throw new Error('bank_checkout_rejected');
   }
   const url=paymentUrl(b.PaymentURL);if(order.cycle===0&&!url)throw new Error('bank_status_unknown');
   const rows=await this.db.patch('pr_tbank_orders',{payment_id:String(b.PaymentId),payment_url:url,provider_status:b.Status||'NEW',check_at:new Date(Date.now()+60000).toISOString()},{id:'eq.'+order.id,confirmed_at:'is.null'});
   return rows[0];
  }catch(e){await this.db.patch('pr_tbank_orders',{last_error:e.message==='bank_checkout_rejected'?'init_rejected':'init_status_unknown'},{id:'eq.'+order.id});throw e;}
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
     if(claimed){await this.gateway('Charge',{order_id:order.id,payment_id:order.payment_id,rebill_id:claimed.rebill_id});}
    }
    // Charge itself is NEVER automatically retried, including a network timeout.
    const state=await this.gateway('GetState',{order_id:order.id,payment_id:order.payment_id});
    if(state.Success===true&&state.OrderId===order.id)await this.db.rpc('pr_tbank_event',{p_body:state});
    else await this.db.patch('pr_tbank_orders',{last_error:'reconciliation_pending'},{id:'eq.'+order.id});
    if(new Date(order.expires_at)<=new Date()&&state.Status==='NEW')await this.fail(order,'payment_not_completed');
   }catch{await this.db.patch('pr_tbank_orders',{last_error:'reconciliation_pending'},{id:'eq.'+order.id});}
  }
  await this.radar.flush();return {processed:rows?.length||0};
 }
}
