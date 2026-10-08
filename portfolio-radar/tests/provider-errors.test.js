import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchJson,Providers} from '../src/providers.js';
import {Radar} from '../src/app.js';

test('OpenAI credit and quota failures are terminal without retaining raw provider messages',async t=>{
 for(const [detail,expected] of [
  [{code:'credit_balance_exhausted',type:'insufficient_quota'},'openai_credit_balance_exhausted'],
  [{code:'insufficient_quota'},'openai_insufficient_quota'],
  [{code:null,type:'insufficient_quota'},'openai_insufficient_quota'],
  [{code:'billing_hard_limit_reached'},'openai_insufficient_quota']
 ]){
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{...detail,message:'private provider details'}},{status:429}));
  await assert.rejects(fetchJson('https://api.openai.com/v1/responses'),e=>{
   assert.equal(e.message,expected);assert.equal(e.status,429);assert.equal(e.retryable,false);
   assert.ok(!JSON.stringify(e).includes('private provider details'));return true;
  });
  t.mock.restoreAll();
 }
});

test('temporary rate limits remain retryable; other providers and malformed errors stay generic',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'rate_limit_exceeded'}},{status:429,headers:{'retry-after':'180'}}));
 await assert.rejects(fetchJson('https://api.openai.com/v1/responses'),e=>e.message==='http_429'&&e.retryAfter===180&&e.retryable!==false);
 t.mock.restoreAll();
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'credit_balance_exhausted'}},{status:429}));
 await assert.rejects(fetchJson('https://api.telegram.org/test'),e=>e.message==='http_429'&&e.retryable!==false);
 t.mock.restoreAll();
 t.mock.method(globalThis,'fetch',async()=>new Response('upstream unavailable',{status:503}));
 await assert.rejects(fetchJson('https://api.openai.com/v1/responses'),e=>e.message==='http_503');
});

async function failedExtraction(error,user=42,attempts=1){
 const imp={id:'upload',status:'processing',files:[{file_id:'kept'}]},replies=[],patches=[];
 const job={id:7,user_id:user,kind:'extract',attempts,payload:{import_id:imp.id}};
 let offered=false,calls=0;
 const radar=new Radar({
  rpc:async name=>name==='pr_lock'?true:name==='pr_next_job'&&!offered?(offered=true,[job]):[],
  patch:async(table,body)=>{
   patches.push({table,body});
   if(table==='pr_imports')Object.assign(imp,body);
   else assert.equal(table,'pr_jobs','saved portfolio must not change');
   return [];
  }
 });
 radar.config={telegram_token:'test'};
 radar.handleExtract=async()=>{calls++;throw error;};
 radar.flush=async()=>{};
 radar.reply=async(_job,_user,text,keyboard)=>replies.push({text,keyboard});
 const before=Date.now();await radar.workLane(1);
 return {imp,replies,patches,calls,before};
}

test('exhausted balance stops after one attempt, keeps images, and gives a usable retry button',async()=>{
 for(const user of [42,85572233]){
  const s=await failedExtraction(Object.assign(new Error('openai_credit_balance_exhausted'),{status:429,retryable:false}),user);
  assert.equal(s.calls,1);assert.equal(s.patches[0].body.state,'failed');
  assert.equal(s.patches[0].body.last_error,'openai_credit_balance_exhausted');
  assert.equal(s.imp.status,'uploading');assert.deepEqual(s.imp.files,[{file_id:'kept'}]);
  assert.equal(s.replies.length,1);assert.equal(s.replies[0].keyboard[0][0].callback_data,'ui:done:upload');
  assert.match(s.replies[0].text,/Скриншоты остаются/);
  if(user===85572233)assert.match(s.replies[0].text,/Пополните баланс API/);
  else assert.doesNotMatch(s.replies[0].text,/OpenAI|кредиты|баланс API/);
 }
});

test('temporary 429 respects Retry-After and only returns upload to user after retries run out',async()=>{
 const error=Object.assign(new Error('http_429'),{status:429,retryAfter:180});
 const first=await failedExtraction(error);
 assert.equal(first.patches[0].body.state,'pending');
 assert.ok(new Date(first.patches[0].body.available_at)-first.before>=180000);
 assert.equal(first.imp.status,'processing');assert.equal(first.replies.length,0);
 const last=await failedExtraction(error,42,3);
 assert.equal(last.patches[0].body.state,'failed');assert.equal(last.imp.status,'uploading');
 assert.equal(last.replies.length,1);assert.match(last.replies[0].text,/Попробуйте позже/);
});

test('failed background news preserves the credit failure instead of reporting no search results',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('failed response must not restart a paid request'));
 const providers=new Providers({openai_key:'test'},{});
 await assert.rejects(providers.news({key:'market',kind:'market',name:'Market'},new Date(),{
  background:true,response:{id:'resp_test',status:'failed',error:{code:'credit_balance_exhausted',type:'insufficient_quota'}}
 }),e=>e.message==='openai_credit_balance_exhausted'&&e.terminalResponse===true&&e.retryable===false);
});
