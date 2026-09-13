import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {bankToken,bankRequest,handleGateway,verifyEnvelope} from '../gateway/src/portfolio-gateway.mjs';
const keys=generateKeyPairSync('ed25519'),order='pr_'+'a'.repeat(32),sub='12345678-1234-1234-1234-123456789abc';
function envelope(method,params={},timestamp=Date.now()) {const raw=Buffer.from(JSON.stringify({method,params,timestamp,request_id:sub}));return {payload:raw.toString('base64url'),signature:sign(null,raw,keys.privateKey).toString('base64url')};}
test('gateway rejects modified and expired signed requests',()=>{
 const a=envelope('Status');assert.equal(verifyEnvelope(a,keys.publicKey).method,'Status');
 assert.throws(()=>verifyEnvelope({...a,payload:Buffer.from('{}').toString('base64url')},keys.publicKey));
 assert.throws(()=>verifyEnvelope(envelope('Status',{},0),keys.publicKey));
});
test('bank signature ignores nested objects, signs scalar boolean values',()=>{
 const p={TerminalKey:'t',Amount:29000,Success:true,DATA:{x:1}};
 assert.equal(bankToken(p,'s'),bankToken({...p,DATA:{x:2},Token:'ignored'},'s'));
 assert.notEqual(bankToken(p,'s'),bankToken({...p,Success:false},'s'));
});
test('adapter locks RUB amount, weekly order namespace and isolated callback',()=>{
 const p=bankRequest('Init',{order_id:order,subscription_id:sub,kind:'initial',amount:1},'t','s');
 assert.equal(p.Amount,29000);assert.equal(p.Recurrent,'Y');assert.equal(p.DATA.OperationInitiatorType,'1');assert.match(p.NotificationURL,/portfolio-radar\/tbank-notification$/);
 const child=bankRequest('Init',{order_id:order,subscription_id:sub,kind:'renewal'},'t','s');assert.equal(child.Recurrent,undefined);assert.equal(child.DATA.OperationInitiatorType,'R');
 assert.throws(()=>bankRequest('Init',{order_id:'yr_123'},'t','s'));
});
test('no charge for another product or an already processed operation',async()=>{
 let calls=[];const params={order_id:order,payment_id:'123',rebill_id:'456'};
 const opts={publicKey:keys.publicKey,terminal:'t',password:'s',request:async m=>{calls.push(m);return {OrderId:'yr_old',Amount:29000,Status:'NEW'};}};
 await assert.rejects(()=>handleGateway(envelope('Charge',params),opts),/scope/);assert.deepEqual(calls,['GetState']);
 calls=[];opts.request=async m=>{calls.push(m);return {OrderId:order,Amount:29000,Status:'CONFIRMED'};};
 assert.equal((await handleGateway(envelope('Charge',params),opts)).Status,'CONFIRMED');assert.deepEqual(calls,['GetState']);
});
test('bank callback verification checks both terminal and password',async()=>{
 let b={TerminalKey:'t',OrderId:order,PaymentId:'123',Amount:29000,Status:'CONFIRMED',Success:true};b.Token=bankToken(b,'s');
 const opts={publicKey:keys.publicKey,terminal:'t',password:'s'};
 assert.equal((await handleGateway(envelope('Verify',{notification:b}),opts)).valid,true);
 assert.equal((await handleGateway(envelope('Verify',{notification:{...b,Amount:1}}),opts)).valid,false);
});
