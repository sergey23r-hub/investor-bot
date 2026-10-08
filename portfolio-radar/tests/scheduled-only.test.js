import test from 'node:test';
import assert from 'node:assert/strict';
import {Radar} from '../src/app.js';
import {isMarketRefreshRequest} from '../src/corrections.js';
function isolatedRadar(){
 const radar=new Radar({patch:async()=>[]});let replies=[];
 radar.reply=async(_j,_u,text)=>replies.push(text);
 radar.user=async()=>({chat_id:42});radar.billing.touch=async()=>{};
 radar.queue=async()=>assert.fail('manual input must not enqueue market work');
 radar.providers={quote:async()=>assert.fail('quote requested'),news:async()=>assert.fail('news requested')};
 return {radar,replies};
}
test('old /brief commands including bot suffix return schedule info without spending API tokens',async()=>{
 const {radar,replies}=isolatedRadar();
 radar.billing.require=async()=>assert.fail('no AI entitlement needed for a static answer');
 for(const text of ['/brief','/brief@portfolius_bot'])await radar.handleUpdate({id:1,payload:{message:{from:{id:42},chat:{id:42,type:'private'},text}}});
 assert.equal(replies.length,2);assert.ok(replies.every(x=>x.includes('Ручное обновление отключено')));
});
test('ordinary requests for quotes or news are rejected before AI intent detection; position edits stay available',async()=>{
 const {radar,replies}=isolatedRadar();
 radar.billing.require=async()=>assert.fail('must not call correction model');
 for(const text of ['Обнови котировки','Покажи новости по BTC','Какая цена Bitcoin?','дай сводку','refresh quotes'])await radar.handleCorrection({},{chat_id:42},text);
 assert.equal(replies.length,5);
 assert.equal(isMarketRefreshRequest('/fix 2 SBER 10'),false);
 assert.equal(isMarketRefreshRequest('5 — TE.PA, 2 штуки'),false);
 assert.equal(isMarketRefreshRequest('2 — Новости, 4 штуки'),false);
});
test('legacy queued manual and recovery digests cannot reach providers or look up portfolios',async()=>{
 const radar=new Radar({get:async()=>assert.fail('no database reads before rejection')});
 for(const job of [{job_key:'manual:1',payload:{}},{job_key:'preview:x',payload:{recovery:true}},{job_key:'manual:1',payload:{daily:true}},{job_key:'daily:99:2026-09-13',payload:{daily:true}}])await radar.handleDigest({...job,user_id:42});
});
test('model-classified refresh intent cannot bypass scheduler-only rule',async()=>{
 const {radar,replies}=isolatedRadar();radar.billing.require=async()=>({allowed:true});
 radar.currentImport=async()=>null;radar.account=async()=>({positions:[{name:'Example'}]});radar.flush=async()=>{};
 await radar.handleCorrection({id:1,payload:{correction:{intent:'brief',changes:[]}}},{chat_id:42},'расскажи что случилось сегодня');
 assert.match(replies.at(-1),/Ручное обновление отключено/);
});
test('Telegram menu no longer advertises /brief',async()=>{
 const {radar}=isolatedRadar();radar.config={telegram_token:'test',openai_key:'test',webhook_secret:'secret'};let commands;
 radar.telegram=async(method,body)=>{if(method==='getMe')return {username:'portfolius_bot'};if(method==='getWebhookInfo')return {url:''};if(method==='setMyCommands')commands=body.commands;return true;};
 await radar.register('https://bot.example');assert.ok(commands);assert.equal(commands.some(x=>x.command==='brief'),false);assert.ok(commands.some(x=>x.command==='portfolio'));assert.ok(commands.some(x=>x.command==='edit'));
});
