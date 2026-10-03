// Isolated Portfolius adapter. Existing Yield Radar checkout remains unchanged.
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import {HARICA_TLS_RSA_ROOT_CA_2021} from './harica-root.mjs';
import {RUSSIAN_TRUSTED_ROOT_CA} from './russian-trusted-root.mjs';
import {PORTFOLIO_PUBLIC_KEY} from './portfolio-public-key.mjs';
const ORDER=/^pr_[a-f0-9]{32}$/;
const CALLBACK='https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/tbank-notification';
// T-Bank expects whole seconds and an explicit numeric UTC offset.
export function bankDeadline(date=new Date(Date.now()+3600000)){return date.toISOString().slice(0,19)+'+00:00';}
export function bankToken(body,password){
 const pairs=Object.entries({...body,Password:password}).filter(([k,v])=>k!=='Token'&&v!==null&&v!==undefined&&typeof v!=='object').sort(([a],[b])=>a<b?-1:a>b?1:0);
 return crypto.createHash('sha256').update(pairs.map(([,v])=>String(v)).join('')).digest('hex');
}
export function verifyEnvelope(envelope,key=PORTFOLIO_PUBLIC_KEY,now=Date.now()){
 if(typeof envelope?.payload!=='string'||envelope.payload.length>24000||typeof envelope.signature!=='string')throw new Error('unauthorized');
 const raw=Buffer.from(envelope.payload,'base64url');
 if(!crypto.verify(null,raw,key,Buffer.from(envelope.signature,'base64url')))throw new Error('unauthorized');
 const p=JSON.parse(raw.toString('utf8'));
 if(!Number.isSafeInteger(p.timestamp)||Math.abs(now-p.timestamp)>90000||!/^[-a-f0-9]{36}$/.test(p.request_id))throw new Error('unauthorized');
 return p;
}
export function bankRequest(method,body,terminal,password){
 if(!ORDER.test(body.order_id||''))throw new Error('invalid_order');
 let p={TerminalKey:terminal};
 if(method==='Init'){
  if(!/^[-a-f0-9]{36}$/.test(body.subscription_id)||!['initial','renewal'].includes(body.kind))throw new Error('invalid_subscription');
  p={...p,Amount:29000,OrderId:body.order_id,Description:'Portfolius — подписка на 7 дней, 290 рублей',PayType:'O',Language:'ru',CustomerKey:'portfolius:'+body.subscription_id,
   ...(body.kind==='initial'?{Recurrent:'Y'}:{}),DATA:{OperationInitiatorType:body.kind==='initial'?'1':'R'},NotificationURL:CALLBACK,
   SuccessURL:'https://t.me/portfolius_bot?start=payment',FailURL:'https://t.me/portfolius_bot?start=payment',RedirectDueDate:bankDeadline()};
 }else if(method==='GetState'||method==='Charge'){
  if(!/^\d{1,20}$/.test(String(body.payment_id)))throw new Error('invalid_payment');
  p.PaymentId=String(body.payment_id);
  if(method==='Charge'){if(!/^\d{1,30}$/.test(String(body.rebill_id)))throw new Error('invalid_rebill');p.RebillId=String(body.rebill_id);}
 }else throw new Error('invalid_method');
 return {...p,Token:bankToken(p,password)};
}
function post(method,payload){return new Promise((resolve,reject)=>{
 const body=JSON.stringify(payload),req=https.request({hostname:'securepay.tinkoff.ru',path:'/v2/'+method,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},ca:[...tls.rootCertificates,HARICA_TLS_RSA_ROOT_CA_2021,RUSSIAN_TRUSTED_ROOT_CA],rejectUnauthorized:true,minVersion:'TLSv1.2'},res=>{
  let raw='';res.setEncoding('utf8');res.on('data',c=>{raw+=c;if(raw.length>100000)req.destroy(new Error('bank_response_too_large'));});res.on('end',()=>{try{resolve(JSON.parse(raw));}catch{reject(new Error('bank_response_invalid'));}});
 });req.setTimeout(12000,()=>req.destroy(new Error('bank_timeout')));req.on('error',()=>reject(new Error('bank_network_error')));req.end(body);
});}
export async function handleGateway(envelope,{terminal=process.env.TBANK_TERMINAL_KEY,password=process.env.TBANK_PASSWORD,request=post,publicKey=PORTFOLIO_PUBLIC_KEY}={}){
 const {method,params={}}=verifyEnvelope(envelope,publicKey);
 if(method==='Status')return {configured:!!terminal&&!!password,production:!!terminal&&!terminal.toUpperCase().endsWith('DEMO'),currency:'RUB',amount:29000,period_days:7};
 if(!terminal||!password)throw new Error('bank_not_configured');
 // Operator diagnostic only: compare ordinary Init with CC Init, never Charge.
 if(method==='ProbeInit'){
  const p=bankRequest('Init',{...params,kind:'initial'},terminal,password);
  delete p.Recurrent;delete p.CustomerKey;p.DATA={OperationInitiatorType:'0'};
  p.Token=bankToken(p,password);
  return sanitize(await request('Init',p));
 }
 if(method==='Verify'){
  const b=params.notification;
  if(!b||b.TerminalKey!==terminal||!ORDER.test(b.OrderId||'')||typeof b.Token!=='string'||!/^[a-f0-9]{64}$/i.test(b.Token))return {valid:false};
  const expected=bankToken(b,password),valid=crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(b.Token.toLowerCase()));
  return {valid};
 }
 const payload=bankRequest(method,params,terminal,password);
 // Never charge a Yield Radar order, even if a caller supplies its payment ID.
 if(method==='Charge'){
  const state=await request('GetState',bankRequest('GetState',params,terminal,password));
  if(state.OrderId!==params.order_id||Number(state.Amount)!==29000)throw new Error('payment_scope_mismatch');
  if(state.Status!=='NEW')return sanitize(state);
 }
 const result=await request(method,payload);
 if(result.OrderId&&result.OrderId!==params.order_id)throw new Error('payment_scope_mismatch');
 return sanitize(result);
}
function sanitize(r){return Object.fromEntries(['Success','ErrorCode','Message','Details','Status','OrderId','PaymentId','PaymentURL','Amount','RebillId'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));}
