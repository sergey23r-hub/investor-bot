import test from 'node:test';
import assert from 'node:assert/strict';
import {Radar} from '../src/app.js';
import {BOT_NAME,BOT_DESCRIPTION,BOT_SHORT_DESCRIPTION} from '../src/onboarding.js';

function setup(){
 const replies=[],queued=[],touches=[];
 const user={chat_id:42,current_account:'account',digest_time:'22:00:00',timezone:'Europe/Moscow'};
 const radar=new Radar({patch:async()=>[],post:async()=>[],get:async()=>[]});
 radar.user=async()=>user;
 radar.billing.touch=async(...args)=>touches.push(args);
 radar.billing.access=async(_user,start)=>{assert.notEqual(start,true,'opening onboarding must not start the trial');return {tier:'pending',freemium:true};};
 radar.reply=async(_job,_id,text,keyboard)=>replies.push({text,keyboard});
 radar.queue=async(...args)=>queued.push(args);
 radar.telegram=async method=>{assert.equal(method,'answerCallbackQuery');return true;};
 radar.handleCorrection=async()=>assert.fail('onboarding must not invoke the correction model');
 const send=async(text)=>radar.handleUpdate({id:1,payload:{message:{text,from:{id:42},chat:{id:42,type:'private'}}}});
 const click=async data=>radar.handleUpdate({id:2,payload:{callback_query:{id:'callback',data,from:{id:42},message:{chat:{id:42,type:'private'}}}}});
 return {radar,replies,queued,touches,send,click};
}

test('native Start, bot commands and plain start labels open onboarding without AI or activating a trial',async()=>{
 const s=setup();
 for(const text of ['/start','/start@portfolius_bot','Начать','Start','🚀 Начать'])await s.send(text);
 assert.equal(s.replies.length,5);
 for(const r of s.replies){assert.match(r.text,/<b>Portfolius<\/b>/);assert.equal(r.keyboard[0][0].callback_data,'ui:upload');}
 assert.equal(s.queued.length,0);
 const ref='1234567890abcdef1234567890abcdef';
 await s.send('/start ref_'+ref);assert.deepEqual(s.touches.at(-1),[42,ref]);
});

test('every welcome-screen button has a working private-chat route',async()=>{
 const s=setup();await s.send('/start');
 const buttons=s.replies[0].keyboard.flat();
 let upgrades=0;s.radar.billing.menu=async()=>{upgrades++;};
 for(const b of buttons)await s.click(b.callback_data);
 assert.equal(upgrades,1);
 assert.ok(s.replies.some(r=>r.text.includes('Нажмите 📎')));
 assert.ok(s.replies.some(r=>r.text.includes('Все цифры и события ниже условные')));
 assert.ok(s.replies.some(r=>r.text.includes('/unsubscribe')));
 await s.click('ui:home');assert.match(s.replies.at(-1).text,/<b>Portfolius<\/b>/);
 assert.equal(s.queued.length,0,'example is static; no news or quotes requested');
});

test('leaving question mode via navigation or plain start routes later text to portfolio correction',async()=>{
 for(const navigation of ['ui:upload','insight:report','billing:upgrade','Start']){
  const s=setup();let pending=true,corrected=0;
  s.radar.insights.clearQuestion=async()=>{pending=false;};s.radar.insights.pendingQuestion=async()=>pending;
  s.radar.insights.open=async()=>{};s.radar.billing.menu=async()=>{};
  s.radar.insights.ask=async()=>assert.fail('correction must not consume an AI question');
  s.radar.handleCorrection=async()=>{corrected++;};
  if(navigation==='Start')await s.send(navigation);else await s.click(navigation);
  await s.send('1 — EX, 5 штук');assert.equal(corrected,1);
 }
 const s=setup();let cleared=0,opened=0;
 s.radar.insights.clearQuestion=async()=>{cleared++;};s.radar.insights.ask=async()=>{opened++;};
 await s.click('insight:ask');assert.equal(opened,1);assert.equal(cleared,0);
});

test('recognition button processes the matching upload and rejects stale buttons',async()=>{
 const s=setup();let imp={id:'current',files:[{file_id:'file'}],status:'uploading'};
 s.radar.currentImport=async()=>imp;
 await s.click('ui:done:old');assert.equal(s.queued.length,0);
 await s.click('ui:done:current');assert.equal(s.queued.length,1);assert.equal(s.queued[0][1],'extract');
 imp={...imp,status:'processing'};await s.click('ui:done:current');assert.equal(s.queued.length,1);
 imp={...imp,status:'uploading'};await s.send('/done');assert.equal(s.queued.length,2);
});

test('start update is processed and delivered by the worker even without an OpenAI key',async()=>{
 const replies=[];let queuedJob={id:10,kind:'update',attempts:1,payload:{message:{text:'/start',from:{id:42},chat:{id:42,type:'private'}}}};
 const radar=new Radar({rpc:async(name)=>name==='pr_lock'?true:name==='pr_next_job'?(queuedJob?[queuedJob]:[]):null,patch:async(table,body)=>{if(table==='pr_jobs'&&body.state==='done')queuedJob=null;return [];}});
 radar.config={telegram_token:'test'};
 radar.user=async()=>({chat_id:42});radar.billing.touch=async()=>{};radar.billing.access=async()=>({tier:'pending',freemium:true});
 radar.reply=async(_j,_u,text)=>replies.push(text);let flushes=0;radar.flush=async()=>{flushes++;};
 const result=await radar.workLane(1);assert.equal(result.processed,1);assert.equal(replies.length,1);assert.ok(flushes>=2);
});

test('registration sets the branded empty-chat screen and Russian metadata within Telegram limits',async()=>{
 const radar=new Radar({}),calls=[];radar.config={telegram_token:'test',openai_key:'test',webhook_secret:'secret'};
 radar.telegram=async(method,body)=>{calls.push({method,body});return method==='getMe'?{username:'portfolius_bot'}:method==='getWebhookInfo'?{url:''}:true;};
 await radar.register('https://bot.example');
 assert.ok(BOT_DESCRIPTION.length<=512);assert.ok(BOT_SHORT_DESCRIPTION.length<=120);
 for(const language_code of ['', 'ru']){
  assert.ok(calls.some(c=>c.method==='setMyName'&&c.body.name===BOT_NAME&&c.body.language_code===language_code));
  assert.ok(calls.some(c=>c.method==='setMyDescription'&&c.body.description===BOT_DESCRIPTION&&c.body.language_code===language_code));
 }
 assert.equal(calls.find(c=>c.method==='setChatMenuButton').body.menu_button.type,'commands');
});
