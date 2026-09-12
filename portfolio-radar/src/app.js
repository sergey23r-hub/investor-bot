import {LIMITS,html,normalizeRows,formatPositions,splitText,extractFile,digestText,mergePositions,changes,decimal,validateNews} from './core.js';
import {Providers,extractPortfolio,fetchJson} from './providers.js';
export class Database{
 constructor(url,key){this.url=url.replace(/\/$/,'');this.key=key;}
 async request(path,{method='GET',body,query={},prefer}={}){
  const u=new URL(this.url+'/rest/v1/'+path);for(const[k,v]of Object.entries(query))u.searchParams.set(k,String(v));
  const headers={apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'};if(prefer)headers.Prefer=prefer;
  const r=await fetch(u,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!r.ok){const d=await r.json().catch(()=>({}));const e=new Error(d.message||`database_${r.status}`);e.status=r.status;throw e;}
  return r.status===204?null:r.json();
 }
 get(table,query={}){return this.request(table,{query});}
 post(table,body,query={},prefer='return=representation'){return this.request(table,{method:'POST',body,query,prefer});}
 patch(table,body,query){return this.request(table,{method:'PATCH',body,query,prefer:'return=representation'});}
 rpc(name,body={}){return this.request('rpc/'+name,{method:'POST',body});}
}
export class Radar{
 constructor(db,env={}){this.db=db;this.env=env;}
 async init(){
  this.config=await this.db.rpc('pr_config');
  // Dedicated names avoid accidentally repurposing an existing Telegram bot.
  this.config.telegram_token ||= this.env.PORTFOLIO_TELEGRAM_TOKEN;
  this.config.openai_key ||= this.env.PORTFOLIO_OPENAI_KEY||this.env.OPENAI_API_KEY;
  this.providers=new Providers(this.config,{get:async key=>(await this.db.get('pr_cache',{key:'eq.'+key,limit:1}))[0],set:async(key,value,ttl)=>this.db.post('pr_cache',{key,value,expires_at:new Date(Date.now()+ttl*1000).toISOString()},{on_conflict:'key'},'resolution=merge-duplicates,return=minimal')});
 }
 async telegram(method,body){
  const d=await fetchJson(`https://api.telegram.org/bot${this.config.telegram_token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},15000);
  if(!d.ok){const e=new Error('telegram_'+d.error_code);e.status=d.error_code;e.retryAfter=d.parameters?.retry_after;throw e;}return d.result;
 }
 async queue(key,kind,payload,user=null){return this.db.rpc('pr_enqueue',{p_key:key,p_kind:kind,p_payload:payload,p_user:user});}
 async reply(job,user,text,keyboard=null,suffix='reply'){
  for(const [i,part]of splitText(text).entries())await this.db.post('pr_outbox',{dedup_key:`${job.id}:${suffix}:${i}`,user_id:user,body:{chat_id:user,text:part,parse_mode:'HTML',link_preview_options:{is_disabled:true},...(keyboard&&i===splitText(text).length-1?{reply_markup:{inline_keyboard:keyboard}}:{})}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
 }
 async user(id){
  let u=(await this.db.get('pr_users',{chat_id:'eq.'+id}))[0];
  if(!u){u=(await this.db.post('pr_users',{chat_id:id}))[0];const a=(await this.db.post('pr_accounts',{user_id:id,name:'Основной'}))[0];u=(await this.db.patch('pr_users',{current_account:a.id},{chat_id:'eq.'+id}))[0];}
  return u;
 }
 async currentImport(user){return (await this.db.get('pr_imports',{user_id:'eq.'+user,status:'in.(uploading,processing,preview)',order:'created_at.desc',limit:1}))[0];}
 async account(user){return (await this.db.get('pr_accounts',{id:'eq.'+user.current_account,user_id:'eq.'+user.chat_id,limit:1}))[0];}
 async preview(job,user,imp){
  const a=(await this.db.get('pr_accounts',{id:'eq.'+imp.account_id,user_id:'eq.'+user,limit:1}))[0];
  const unresolved=imp.rows.filter(r=>!r.verified);let text=`<b>Проверьте портфель · ${html(a.name)}</b>\nРежим: ${imp.mode==='replace'?'заменить весь выбранный счёт':'обновить только показанные позиции'}\n\n`+formatPositions(imp.rows);
  if(imp.warnings?.length)text+='\n\n'+imp.warnings.map(x=>'⚠️ '+html(String(x).slice(0,250))).join('\n');
  if(!unresolved.length){const diff=changes(a.positions,mergePositions(a.positions,imp.rows,imp.mode));text+=`\n\nДобавлено: ${diff.added.length}. Изменено: ${diff.changed.length}. Удалено: ${diff.removed.length}.`;if(diff.removed.length)text+='\nБудут удалены: '+diff.removed.map(x=>html(x.name)).join(', ');}
  else text+='\n\nНужно уточнить '+unresolved.length+' позиций. Пример: /fix 2 SBER 10 или /fix 2 crypto:bitcoin 0.15. Знак ? — количество неизвестно.';
  const keys=[];if(!unresolved.length)keys.push([{text:'Всё верно — сохранить',callback_data:'save:'+imp.id}]);keys.push([{text:imp.mode==='partial'?'Заменить весь счёт':'Обновить только показанные',callback_data:'mode:'+imp.id}],[{text:'Отменить загрузку',callback_data:'cancel:'+imp.id}]);
  await this.reply(job,user,text,keys,'preview');
 }
 async handleUpdate(job){
  const update=job.payload,cb=update.callback_query,msg=cb?.message||update.message;
  const id=cb?.from?.id||msg?.from?.id;
  if(!Number.isSafeInteger(id)||id<=0||msg?.chat?.type!=='private'||msg.chat.id!==id)return;
  const user=await this.user(id);await this.db.patch('pr_jobs',{user_id:id},{id:'eq.'+job.id});
  if(cb){
   // Callback answer is a UI acknowledgement, never a financial action.
   await this.telegram('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
   const [action,ref]=String(cb.data||'').split(':');
   if(action==='forget'&&ref==='yes'){await this.db.rpc('pr_forget',{p_user:id});return;}
   if(!['save','mode','cancel'].includes(action))return;
   const imp=(await this.db.get('pr_imports',{id:'eq.'+ref,user_id:'eq.'+id,limit:1}))[0];
   if(!imp)return this.reply(job,id,'Эта загрузка больше недоступна.');
   if(action==='save'){
    const r=await this.db.rpc('pr_commit',{p_import:imp.id,p_user:id});
    return this.reply(job,id,r.already_committed?'Этот портфель уже сохранён.':`Портфель сохранён: ${r.count} позиций. Ежедневный обзор — в ${user.digest_time.slice(0,5)} (${html(user.timezone)}).\n\n/brief — получить обзор сейчас. /time — изменить время. /pause — остановить рассылку.`);
   }
   if(!['uploading','preview'].includes(imp.status))return this.reply(job,id,'Загрузка уже обработана или обрабатывается.');
   if(action==='cancel'){await this.db.patch('pr_imports',{status:'cancelled',files:[]},{id:'eq.'+imp.id});return this.reply(job,id,'Загрузка отменена. Портфель сохранён в прежнем виде.');}
   imp.mode=imp.mode==='partial'?'replace':'partial';await this.db.patch('pr_imports',{mode:imp.mode},{id:'eq.'+imp.id});return this.preview(job,id,imp);
  }
  const file=extractFile(msg);
  if(file){
   let imp=await this.currentImport(id);
   if(imp&&imp.status!=='uploading')return this.reply(job,id,'Предыдущая загрузка ещё открыта. Сохраните или отмените её кнопкой; /cancel — отменить.');
   if(!imp){
    const count=await this.db.get('pr_imports',{user_id:'eq.'+id,created_at:'gte.'+new Date(Date.now()-86400000).toISOString(),select:'id'});
    if(count.length>=6)return this.reply(job,id,'Сегодня уже было 6 загрузок. Следующую можно сделать завтра.');
    const a=await this.account(user);imp=(await this.db.post('pr_imports',{user_id:id,account_id:a.id,base_version:a.version}))[0];
   }
   if(imp.files.some(f=>f.unique_id===file.unique_id))return this.reply(job,id,'Этот скриншот уже добавлен. Пришлите остальные или нажмите /done.');
   if(imp.files.length>=LIMITS.images)return this.reply(job,id,'В одной загрузке до 8 скриншотов. Нажмите /done.');
   await this.db.patch('pr_imports',{files:[...imp.files,file],updated_at:new Date().toISOString()},{id:'eq.'+imp.id});
   return this.reply(job,id,`Скриншот ${imp.files.length+1} добавлен. Пришлите остальные скриншоты <b>этого же счёта</b>, затем /done.\n\nДругой счёт: /account Название. ФИО и номер счёта можно закрыть; оставьте названия активов и числа.`);
  }
  const text=String(msg.text||'').trim(),[command,...args]=text.split(/\s+/);const cmd=command?.split('@')[0].toLowerCase();
  if(cmd==='/start'||cmd==='/help')return this.reply(job,id,'<b>Портфель Романова</b>\n\nПришлите скриншоты криптопортфеля, акций или облигаций. Затем /done — я распознаю позиции и покажу их для проверки.\n\n/account Название — выбрать или создать счёт\n/portfolio — сохранённые позиции\n/brief — новости и котировки сейчас\n/time 22:00 Europe/Moscow — время обзора\n/pause · /resume — рассылка\n/cancel — отменить загрузку\n/history — история обновлений\n/delete — удалить свои данные\n\nДля распознавания изображения передаются в OpenAI. После подтверждения мы храним позиции и историю изменений; копии скриншотов отдельно не сохраняем. ФИО и номер счёта можно закрыть.');
  if(cmd==='/cancel'){const imp=await this.currentImport(id);if(imp)await this.db.patch('pr_imports',{status:'cancelled',files:[]},{id:'eq.'+imp.id});return this.reply(job,id,'Загрузка отменена.');}
  if(cmd==='/done'){
   const imp=await this.currentImport(id);if(!imp?.files.length)return this.reply(job,id,'Сначала пришлите скриншот.');
   if(imp.status==='preview')return this.preview(job,id,imp);
   if(imp.status==='processing')return this.reply(job,id,'Распознавание уже идёт. Результат придёт отдельным сообщением.');
   await this.db.patch('pr_imports',{status:'processing'},{id:'eq.'+imp.id});await this.queue(`extract:${imp.id}:${job.id}`,'extract',{import_id:imp.id,chat_id:id},id);
   return this.reply(job,id,'Распознаю позиции. Затем покажу список для проверки.');
  }
  if(cmd==='/account'){
   const name=args.join(' ').slice(0,60);const all=await this.db.get('pr_accounts',{user_id:'eq.'+id,order:'created_at.asc'.replace('created_at','updated_at')});
   if(!name)return this.reply(job,id,'Ваши счета: '+all.map(a=>html(a.name)).join(', ')+'.\n\nВыбрать или создать: /account Название');
   if(await this.currentImport(id))return this.reply(job,id,'Сначала завершите текущую загрузку или нажмите /cancel.');
   let a=all.find(x=>x.name===name);
   if(!a){if(all.length>=LIMITS.accounts)return this.reply(job,id,'В первой версии доступно до 5 счетов.');a=(await this.db.post('pr_accounts',{user_id:id,name}))[0];}
   await this.db.patch('pr_users',{current_account:a.id},{chat_id:'eq.'+id});return this.reply(job,id,'Выбран счёт «'+html(name)+'». Пришлите его скриншоты.');
  }
  if(cmd==='/portfolio'){
   const all=await this.db.get('pr_accounts',{user_id:'eq.'+id});return this.reply(job,id,all.map(a=>`<b>${html(a.name)}</b> · ${a.positions.length} позиций\n\n${a.positions.length?formatPositions(a.positions):'Пока пусто.'}`).join('\n\n'));
  }
  if(cmd==='/fix'){
   const imp=await this.currentImport(id);if(imp?.status!=='preview')return this.reply(job,id,'Исправление доступно после распознавания, до сохранения.');
   const i=Number(args[0])-1,code=args[1],quantity=args[2];
   if(!Number.isInteger(i)||i<0||i>=imp.rows.length||!code||quantity===undefined)return this.reply(job,id,'Формат: /fix 2 SBER 10. Для крипты: /fix 2 crypto:bitcoin 0.15. Неизвестное количество: ?');
   const raw={...imp.rows[i],name:code,symbol:code,isin:/^[A-Z]{2}[A-Z0-9]{10}$/.test(code)?code:null,quantity:decimal(quantity),issue:null};
   if(code.startsWith('crypto:')){raw.kind='crypto';raw.provider_id=code.slice(7);raw.name=code.slice(7);raw.symbol=null;}
   const resolved=await this.providers.resolve(raw);imp.rows[i]=resolved;imp.rows=normalizeRows(imp.rows);
   await this.db.patch('pr_imports',{rows:imp.rows},{id:'eq.'+imp.id});return this.preview(job,id,imp);
  }
  if(cmd==='/brief'){
   const all=await this.db.get('pr_accounts',{user_id:'eq.'+id});if(!all.some(a=>a.positions.length))return this.reply(job,id,'Сначала загрузите и подтвердите портфель.');
   const today=await this.db.get('pr_jobs',{user_id:'eq.'+id,kind:'eq.digest',created_at:'gte.'+new Date(Date.now()-86400000).toISOString(),select:'id,payload'});
   if(today.filter(x=>!x.payload.daily).length>=3)return this.reply(job,id,'Доступно 3 ручных обзора в сутки. Ежедневная сводка придёт по расписанию.');
   await this.queue('manual:'+job.id,'digest',{chat_id:id},id);return this.reply(job,id,'Готовлю обзор по вашему портфелю. Проверка источников может занять несколько минут.');
  }
  if(cmd==='/pause'||cmd==='/resume'){await this.db.patch('pr_users',{subscribed:cmd==='/resume'},{chat_id:'eq.'+id});return this.reply(job,id,cmd==='/pause'?'Ежедневная рассылка остановлена.':'Ежедневная рассылка включена.');}
  if(cmd==='/time'){
   if(!args.length)return this.reply(job,id,`Время обзора: ${user.digest_time.slice(0,5)}, ${html(user.timezone)}.\n\nИзменить: /time 22:00 Europe/Moscow`);
   if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(args[0]))return this.reply(job,id,'Укажите время в формате 22:00.');
   const tz=args[1]||user.timezone;try{new Intl.DateTimeFormat('ru',{timeZone:tz}).format();}catch{return this.reply(job,id,'Неизвестный часовой пояс. Пример: Europe/Moscow.');}
   await this.db.patch('pr_users',{digest_time:args[0],timezone:tz},{chat_id:'eq.'+id});return this.reply(job,id,`Обзор будет приходить в ${args[0]} (${html(tz)}).`);
  }
  if(cmd==='/history'){
   const a=await this.account(user),h=await this.db.get('pr_history',{account_id:'eq.'+a.id,order:'created_at.desc',limit:10});return this.reply(job,id,'<b>Обновления · '+html(a.name)+'</b>\n\n'+(h.map(x=>`${new Date(x.created_at).toLocaleString('ru-RU',{timeZone:user.timezone})}: ${x.before_positions.length} → ${x.after_positions.length} позиций`).join('\n')||'Обновлений пока нет.'));
  }
  if(cmd==='/delete')return this.reply(job,id,'Удалить ваши счета, позиции, историю, загрузки и остановить рассылку? Это действие нельзя отменить.',[[{text:'Удалить мои данные',callback_data:'forget:yes'}]]);
  return this.reply(job,id,'Пришлите скриншот портфеля или нажмите /help.');
 }
 async handleExtract(job){
  const imp=(await this.db.get('pr_imports',{id:'eq.'+job.payload.import_id,user_id:'eq.'+job.user_id}))[0];
  if(!imp||imp.status==='cancelled'||imp.status==='committed')return;
  if(imp.status==='preview')return this.preview(job,job.user_id,imp);
  if(!job.payload.parsed){
   const buffers=[];let total=0;
   for(let i=0;i<imp.files.length;i+=4){
    const chunk=await Promise.all(imp.files.slice(i,i+4).map(async file=>{
     const f=await this.telegram('getFile',{file_id:file.file_id});if(f.file_size>LIMITS.bytes)throw new Error('image_too_large');
     if(!/^[a-zA-Z0-9_./-]+$/.test(f.file_path)||f.file_path.includes('..'))throw new Error('invalid_file_path');
     const r=await fetch(`https://api.telegram.org/file/bot${this.config.telegram_token}/${f.file_path}`,{signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('image_download_failed');
     const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>LIMITS.bytes)throw new Error('image_too_large');
     return {bytes,mime:file.mime};
    }));
    for(const f of chunk){total+=f.bytes.length;if(total>16*1024*1024)throw new Error('images_total_too_large');buffers.push(f);}
   }
   const images=buffers.map(({bytes,mime})=>{let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return `data:${mime};base64,`+btoa(binary);});
   const parsed=await extractPortfolio(images,this.config.openai_key);
   if(parsed.positions.length>LIMITS.rows)throw new Error('too_many_positions');
   job.payload.parsed=parsed;job.payload.resolved=[];
   await this.db.patch('pr_jobs',{payload:job.payload,state:'pending',attempts:0,available_at:new Date().toISOString(),lease_until:null},{id:'eq.'+job.id});
   return 'deferred';
  }
  const parsed=job.payload.parsed,rows=job.payload.resolved||[];
  rows.push(...await Promise.all(parsed.positions.slice(rows.length,rows.length+4).map(raw=>this.providers.resolve(raw))));
  job.payload.resolved=rows;
  if(rows.length<parsed.positions.length){
   await this.db.patch('pr_jobs',{payload:job.payload,state:'pending',attempts:0,available_at:new Date().toISOString(),lease_until:null},{id:'eq.'+job.id});return 'deferred';
  }
  imp.rows=normalizeRows(rows);imp.warnings=parsed.warnings||[];
  if(parsed.observed_date&&parsed.observed_date!==new Date().toISOString().slice(0,10))imp.warnings.push('На изображении указана дата '+parsed.observed_date+'. Проверьте актуальность остатков.');
  imp.status='preview';await this.db.patch('pr_imports',{rows:imp.rows,warnings:imp.warnings,status:'preview',updated_at:new Date().toISOString()},{id:'eq.'+imp.id});await this.preview(job,job.user_id,imp);
 }
 async researchKey(asset){return 'research:'+asset.key+':'+Math.floor(Date.now()/(6*3600000));}
 async handleResearch(job){
  const asset=job.payload.asset;let quote=null,news;
  if(asset.key!=='market')try{quote=await this.providers.quote(asset);}catch{quote={status:'unavailable',price:null};}
  try{news=await this.providers.news(asset);}catch(e){if(job.attempts<3)throw e;news={status:'unavailable',items:[],events:[]};}
  await this.db.post('pr_cache',{key:job.job_key,value:{quote,news},expires_at:new Date(Date.now()+6*3600000).toISOString()},{on_conflict:'key'},'resolution=merge-duplicates,return=minimal');
 }
 async handleDigest(job){
  const u=(await this.db.get('pr_users',{chat_id:'eq.'+job.user_id}))[0];if(!u||(job.payload.daily&&!u.subscribed))return;
  const accounts=await this.db.get('pr_accounts',{user_id:'eq.'+job.user_id});if(!accounts.some(a=>a.positions.length))return;
  const assets=[...new Map(accounts.flatMap(a=>a.positions).filter(a=>a.verified&&a.provider!=='cash').map(a=>[a.key,a])).values()];
  const kinds=[...new Set(assets.map(a=>a.kind))].sort();
  const market={key:'market',name:'Рынки по направлениям: '+kinds.join(', ')+'; глобальная экономика, Россия'+(kinds.includes('crypto')?', крипторынок':''),kind:'market'};
  // Global market review is deliberately shared; no positions or account values leave through search.
  market.name='Главные события мировой экономики, российского фондового рынка и крипторынка';
  const quotes={},news={};let marketResult,waiting=false;
  for(const a of [market,...assets]){
   const key=job.payload.cache_keys?.[a.key]||await this.researchKey(a);
   job.payload.cache_keys??={};job.payload.cache_keys[a.key]=key;
   const c=(await this.db.get('pr_cache',{key:'eq.'+key,limit:1}))[0];
   if(c){const n=c.value.news;const filtered={...n,items:validateNews(n.items,(n.items||[]).map(x=>x.url)),events:(n.events||[]).filter(e=>e.date>=new Date().toISOString().slice(0,10))};if(a.key==='market')marketResult=filtered;else{quotes[a.key]=c.value.quote;news[a.key]=filtered;}continue;}
   const existing=(await this.db.get('pr_jobs',{job_key:'eq.'+key,select:'state',limit:1}))[0];
   if(existing?.state==='failed'){news[a.key]={status:'unavailable',items:[]};continue;}
   await this.queue(key,'research',{asset:{name:a.name,symbol:a.symbol,isin:a.isin,kind:a.kind,key:a.key,provider:a.provider,provider_id:a.provider_id,verified:a.verified,currency:a.currency}});waiting=true;
  }
  if(waiting){await this.db.patch('pr_jobs',{payload:job.payload,state:'pending',attempts:0,available_at:new Date(Date.now()+15000).toISOString(),lease_until:null},{id:'eq.'+job.id});return 'deferred';}
  const messages=digestText({accounts,quotes,news,market:marketResult});for(const[i,text]of messages.entries())await this.reply(job,job.user_id,text,null,'digest:'+i);
 }
 async flush(){
  const rows=await this.db.get('pr_outbox',{state:'eq.pending',available_at:'lte.'+new Date().toISOString(),order:'id.asc',limit:2});
  for(const r of rows){
   await this.db.patch('pr_outbox',{state:'sending',attempts:r.attempts+1,available_at:new Date().toISOString()},{id:'eq.'+r.id,state:'eq.pending'});
   try{const res=await this.telegram(r.method,r.body);await this.db.patch('pr_outbox',{state:'sent',telegram_message_id:res?.message_id??null,body:{}},{id:'eq.'+r.id});}
   catch(e){
    // Telegram has no idempotency key for sendMessage. Ambiguous network delivery
    // is retained for inspection rather than automatically duplicating a digest.
    const retry=e.status===429||(e.status>=500&&e.status<=599);
    await this.db.patch('pr_outbox',{state:retry&&r.attempts<5?'pending':e.status?'failed':'uncertain',available_at:new Date(Date.now()+(e.retryAfter||60)*1000).toISOString(),last_error:e.status?'telegram_'+e.status:'delivery_status_unknown'},{id:'eq.'+r.id});
    if(e.status===403)await this.db.patch('pr_users',{subscribed:false},{chat_id:'eq.'+r.user_id});
   }
  }
 }
 async work(){
  if(!this.config.telegram_token||!this.config.openai_key)return {ready:false};
  const token=crypto.randomUUID(),locked=await this.db.rpc('pr_lock',{p_token:token});if(!locked)return {busy:true};const started=Date.now();let count=0;
  try{
   await this.db.rpc('pr_daily_jobs');await this.db.rpc('pr_cleanup');await this.flush();
   while(Date.now()-started<20000&&count<4){
    const job=(await this.db.rpc('pr_next_job'))[0];if(!job)break;
    try{
     const result=await ({update:()=>this.handleUpdate(job),extract:()=>this.handleExtract(job),research:()=>this.handleResearch(job),digest:()=>this.handleDigest(job)}[job.kind])();
     if(result!=='deferred')await this.db.patch('pr_jobs',{state:'done',payload:['update','extract'].includes(job.kind)?{}:job.payload,lease_until:null,last_error:null},{id:'eq.'+job.id});
    }catch(e){
     const retry=/^(network_timeout|http_|telegram_|database_)/.test(e.message)&&job.attempts<3;
     await this.db.patch('pr_jobs',{state:retry?'pending':'failed',available_at:new Date(Date.now()+job.attempts*60000).toISOString(),lease_until:null,last_error:String(e.message).slice(0,150)},{id:'eq.'+job.id});
     if(!retry&&job.user_id){
      if(job.kind==='extract')await this.db.patch('pr_imports',{status:'uploading'},{id:'eq.'+job.payload.import_id,status:'eq.processing'});
      const friendly={stale_import:'Портфель уже изменился. Отмените эту загрузку и пришлите новые скриншоты.',unresolved_rows:'Сначала уточните отмеченные позиции через /fix.',import_not_ready:'Эта загрузка ещё не готова к сохранению.',positions_not_found:'На скриншоте не удалось найти позиции. Пришлите более чёткое изображение.',openai_key_missing:'Распознавание пока не подключено.'};
      await this.reply(job,job.user_id,friendly[e.message]||'Не удалось завершить обработку. Сохранённый портфель не изменился. Повторите команду; для новой загрузки — /cancel.',null,'error');
     }
    }
    count++;await this.flush();if(job.kind==='extract'||job.kind==='research')break;
   }return {processed:count};
  }finally{await this.db.rpc('pr_unlock',{p_token:token});}
 }
 async register(base){
  if(!this.config.telegram_token||!this.config.openai_key)throw new Error('credentials_missing');
  const me=await this.telegram('getMe',{});
  const current=await this.telegram('getWebhookInfo',{});const target=base.replace(/\/$/,'')+'/webhook';
  if(current.url&&current.url!==target)throw new Error('bot_already_connected_elsewhere');
  await this.telegram('setWebhook',{url:target,secret_token:this.config.webhook_secret,allowed_updates:['message','callback_query'],max_connections:10,drop_pending_updates:false});
  await this.telegram('setMyCommands',{commands:[{command:'start',description:'Начать и узнать возможности'},{command:'done',description:'Распознать загруженные скриншоты'},{command:'portfolio',description:'Мои позиции'},{command:'brief',description:'Обзор по портфелю'},{command:'account',description:'Выбрать счёт'},{command:'time',description:'Время ежедневной сводки'},{command:'pause',description:'Остановить рассылку'},{command:'resume',description:'Включить рассылку'},{command:'cancel',description:'Отменить загрузку'},{command:'delete',description:'Удалить мои данные'}]});
  return {username:me.username,url:'https://t.me/'+me.username};
 }
}
export function timingSafe(a,b){if(typeof a!=='string'||typeof b!=='string'||!a||a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0;}
export function createHandler(env,waitUntil=()=>{},dbOverride){
 const db=dbOverride||new Database(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
 return async req=>{
  const path=new URL(req.url).pathname.split('/').filter(Boolean).at(-1),json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(req.method==='GET'&&path==='health')return json({service:'portfolio-radar',version:'0.1.0',status:'running'});
  if(req.method!=='POST')return json({error:'not_found'},404);
  try{
   const radar=new Radar(db,env);await radar.init();
   if(path==='webhook'){
    if(!timingSafe(req.headers.get('x-telegram-bot-api-secret-token'),radar.config.webhook_secret))return json({error:'unauthorized'},401);
    if(Number(req.headers.get('content-length'))>100000)return json({error:'too_large'},413);
    const raw=await req.text();if(raw.length>100000)return json({error:'too_large'},413);const update=JSON.parse(raw);
    if(!Number.isSafeInteger(update.update_id))return json({error:'invalid_update'},400);
    await radar.queue('update:'+update.update_id,'update',update);
    waitUntil(radar.work().catch(()=>console.error('portfolio_worker_failed')));return json({ok:true});
   }
   if(!timingSafe(req.headers.get('x-portfolio-worker-secret'),radar.config.worker_secret))return json({error:'unauthorized'},401);
   if(path==='work'){waitUntil(radar.work().catch(()=>console.error('portfolio_worker_failed')));return json({accepted:true});}
   if(path==='register'){const base=req.url.slice(0,req.url.lastIndexOf('/'));return json(await radar.register(base));}
   if(path==='status')return json({telegram_configured:!!radar.config.telegram_token,ai_configured:!!radar.config.openai_key});
   return json({error:'not_found'},404);
  }catch{console.error('portfolio_request_failed');return json({error:'processing_failed'},500);}
 };
}
