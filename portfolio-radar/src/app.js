import {LIMITS,html,normalizeRows,prepareRows,formatPositions,splitText,extractFile,digestText,mergePositions,changes,decimal,validateNews} from './core.js';
import {Providers,extractPortfolio,fetchJson} from './providers.js';
import {parseCorrection,correctionCode,isMarketRefreshRequest} from './corrections.js';
import {Billing} from './billing.js';
import {entitledPortfolio,upgradeOffer} from './freemium.js';
import {dailyResearchKey,quoteCacheKey} from './daily.js';
import {Insights} from './insights.js';
import {Outlooks} from './outlooks.js';
import {cachedMarket,rememberQuote,fxCacheKey} from './first-look.js';
import {BOT_NAME,BOT_DESCRIPTION,BOT_SHORT_DESCRIPTION,welcomeScreen,uploadScreen,exampleScreen,helpScreen} from './onboarding.js';
export class Database{
 constructor(url,key){this.url=url.replace(/\/$/,'');this.key=key;}
 async request(path,{method='GET',body,query={},prefer}={}){
  const u=new URL(this.url+'/rest/v1/'+path);for(const[k,v]of Object.entries(query))u.searchParams.set(k,String(v));
  const headers={apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'};if(prefer)headers.Prefer=prefer;
  const r=await fetch(u,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!r.ok){const d=await r.json().catch(()=>({}));const e=new Error(d.message||`database_${r.status}`);e.status=r.status;throw e;}
  // PostgREST return=minimal and ignored duplicates can return an empty 201/200.
  const text=await r.text();return text.trim()?JSON.parse(text):null;
 }
 get(table,query={}){return this.request(table,{query});}
 post(table,body,query={},prefer='return=representation'){return this.request(table,{method:'POST',body,query,prefer});}
 patch(table,body,query){return this.request(table,{method:'PATCH',body,query,prefer:'return=representation'});}
 rpc(name,body={}){return this.request('rpc/'+name,{method:'POST',body});}
}
export class Radar{
 constructor(db,env={}){this.db=db;this.env=env;this.billing=new Billing(this);this.insights=new Insights(this);this.outlooks=new Outlooks(this);}
 async init(){
  this.config=await this.db.rpc('pr_config');
  // Dedicated names avoid accidentally repurposing an existing Telegram bot.
  this.config.telegram_token ||= this.env.PORTFOLIO_TELEGRAM_TOKEN;
  this.config.openai_key ||= this.env.PORTFOLIO_OPENAI_KEY||this.env.OPENAI_API_KEY;
  this.providers=new Providers(this.config,{get:async key=>(await this.db.get('pr_cache',{key:'eq.'+key,limit:1}))[0],set:async(key,value,ttl)=>this.db.post('pr_cache',{key,value,expires_at:new Date(Date.now()+ttl*1000).toISOString()},{on_conflict:'key'},'resolution=merge-duplicates,return=minimal')},record=>this.recordUsage(record));
 }
 async recordUsage(record,user=null){
  if(!record)return;
  await this.db.post('pr_usage',{...record,user_id:user},{on_conflict:'response_id'},'resolution=ignore-duplicates,return=minimal');
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
  if(!u)u=(await this.db.post('pr_users',{chat_id:id}))[0];
  if(!u.current_account){
   let a=(await this.db.get('pr_accounts',{user_id:'eq.'+id,name:'eq.Основной',limit:1}))[0];
   if(!a)a=(await this.db.post('pr_accounts',{user_id:id,name:'Основной'}))[0];
   u=(await this.db.patch('pr_users',{current_account:a.id},{chat_id:'eq.'+id}))[0];
  }
  return u;
 }
 async currentImport(user){return (await this.db.get('pr_imports',{user_id:'eq.'+user,status:'in.(uploading,processing,preview)',order:'created_at.desc',limit:1}))[0];}
 async account(user){return (await this.db.get('pr_accounts',{id:'eq.'+user.current_account,user_id:'eq.'+user.chat_id,limit:1}))[0];}
 async editMenu(job,user){
  let imp=await this.currentImport(user.chat_id);
  if(imp&&imp.status!=='preview')return this.reply(job,user.chat_id,'Сначала завершите распознавание через /done или отмените загрузку через /cancel.');
  if(!imp){
   const a=await this.account(user);
   if(!a.positions.length)return this.reply(job,user.chat_id,'Сначала пришлите скриншот портфеля.');
   imp=(await this.db.post('pr_imports',{user_id:user.chat_id,account_id:a.id,base_version:a.version,status:'preview',mode:'replace',correction:true,rows:a.positions}))[0];
  }
  const keys=imp.rows.map((r,i)=>[{text:(i+1)+'. '+r.name.slice(0,35),callback_data:'edit:'+imp.id+':'+i}]);
  keys.push([{text:'Отменить исправления',callback_data:'cancel:'+imp.id}]);
  return this.reply(job,user.chat_id,'Выберите строку и напишите её тикер или полное название. Можно сразу сообщением: «5 — TE.PA, 2 штуки». Если количество не указано, оно сохранится. Изменения покажу для подтверждения.',keys);
 }
 async handleCorrection(job,user,text){
  if(isMarketRefreshRequest(text))return this.scheduleOnly(job,user);
  if(!await this.billing.require(job,user.chat_id))return;
  let imp=await this.currentImport(user.chat_id);
  if(imp&&imp.status!=='preview')return this.reply(job,user.chat_id,'Скриншоты ещё обрабатываются. Дождитесь списка; затем напишите уточнение.');
  if(imp?.last_edit_key===String(job.id))return this.preview(job,user.chat_id,imp);
  const a=imp?null:await this.account(user),rows=imp?.rows||a.positions;
  if(!rows.length)return this.reply(job,user.chat_id,'Сначала пришлите скриншот портфеля.');
  if(text.length>3000)return this.reply(job,user.chat_id,'Разделите уточнение на сообщения до 3000 символов.');
  await this.reply(job,user.chat_id,'Проверяю уточнение…',null,'correction_start');await this.flush();
  const parsed=job.payload.correction||await parseCorrection(text,rows,this.config.openai_key,imp?.edit_row??null,record=>this.recordUsage(record,user.chat_id));
  job.payload.correction=parsed;await this.db.patch('pr_jobs',{payload:job.payload},{id:'eq.'+job.id});
  if(parsed.intent==='brief')return this.scheduleOnly(job,user);
  if(!parsed.changes.length)return this.reply(job,user.chat_id,parsed.question||'Укажите номер строки и название: «5 — TE.PA». /edit — выбрать позицию кнопкой.');
  const next=rows.map(r=>({...r}));
  if(new Set(parsed.changes.map(e=>e.row)).size!==parsed.changes.length)throw new Error('invalid_correction');
  await Promise.all(parsed.changes.map(async edit=>{
   if(!Number.isInteger(edit.row)||edit.row<1||edit.row>rows.length)throw new Error('invalid_correction');
   const old=next[edit.row-1],raw=correctionCode(old,edit);
   next[edit.row-1]=edit.code||edit.kind?await this.providers.resolve(raw):{...old,quantity:raw.quantity,observed_value:raw.observed_value,average_price:raw.average_price};
  }));
  const prepared=prepareRows(next);
  if(!imp)imp=(await this.db.post('pr_imports',{user_id:user.chat_id,account_id:a.id,base_version:a.version,status:'preview',mode:'replace',correction:true,rows:prepared,last_edit_key:String(job.id)}))[0];
  else{imp.rows=prepared;await this.db.patch('pr_imports',{rows:prepared,last_edit_key:String(job.id),edit_row:null,updated_at:new Date().toISOString()},{id:'eq.'+imp.id,status:'eq.preview'});}
  return this.preview(job,user.chat_id,imp);
 }
 async scheduleOnly(job,user){
  return this.reply(job,user.chat_id,'🗓 <b>Новости и котировки — по расписанию</b>\n\nЕжедневная сводка приходит автоматически. Ручное обновление отключено.\n/time — время сводки\n/portfolio — сохранённые позиции\n/edit — исправить состав портфеля');
 }
 async preview(job,user,imp){
  const a=(await this.db.get('pr_accounts',{id:'eq.'+imp.account_id,user_id:'eq.'+user,limit:1}))[0];
  const unresolved=imp.rows.filter(r=>!r.verified);let text=`<b>Проверьте портфель · ${html(a.name)}</b>\nРежим: ${imp.mode==='replace'?'заменить весь выбранный счёт':'обновить только показанные позиции'}\n\n`+formatPositions(imp.rows);
  if(imp.warnings?.length)text+='\n\n'+imp.warnings.slice(0,10).map(x=>'⚠️ '+html(String(x).slice(0,250))).join('\n');
  if(unresolved.length)text+='\n\n'+unresolved.filter(r=>r.candidates?.length).slice(0,10).map(r=>html(r.name)+': '+r.candidates.map(c=>html(String(c).slice(0,100))).join('; ')).join('\n\n');
  const diff=changes(a.positions,mergePositions(a.positions,imp.rows,imp.mode));text+=`\n\nДобавлено: ${diff.added.length}. Изменено: ${diff.changed.length}. Удалено: ${diff.removed.length}.`;if(diff.removed.length)text+='\nБудут удалены: '+diff.removed.slice(0,10).map(x=>html(x.name)).join(', ')+(diff.removed.length>10?' и ещё '+(diff.removed.length-10):'');
  if(unresolved.length)text+='\n\nМожно сохранить все строки. У '+unresolved.length+' позиций пока нет точного соответствия в справочнике: их количество и название сохранятся, но персональные новости и котировки появятся после уточнения.\n\nИсправить: напишите номер строки и название, например «5 — TE.PA», или /edit. Команда /fix 2 SBER 10 тоже работает; количество можно не указывать.';
  const keys=[[{text:unresolved.length?'Сохранить все позиции с пометками':'Всё верно — сохранить',callback_data:(unresolved.length?'save_notes:':'save:')+imp.id}]];
  if(!imp.correction)keys.push([{text:imp.mode==='partial'?'Заменить весь счёт':'Обновить только показанные',callback_data:(imp.mode==='partial'?'replace:':'partial:')+imp.id}]);
  keys.push([{text:'Отменить изменения',callback_data:'cancel:'+imp.id}]);
  await this.reply(job,user,text,keys,'preview');
  await this.insights.event(user,'import_preview',imp.id);
 }
 async showScreen(job,user,screen){
  const view=screen==='upload'?uploadScreen():screen==='example'?exampleScreen():screen==='help'?helpScreen():welcomeScreen(await this.billing.access(user.chat_id));
  return this.reply(job,user.chat_id,view.text,view.keyboard);
 }
 async beginExtraction(job,user,expectedImport=null){
  const id=user.chat_id,imp=await this.currentImport(id);
  if(!imp)return this.reply(job,id,'Сначала пришлите скриншот портфеля.',[[{text:'📸 Как загрузить портфель',callback_data:'ui:upload'}]]);
  if(expectedImport&&imp.id!==expectedImport)return this.reply(job,id,'Это кнопка предыдущей загрузки. Используйте кнопку под новыми скриншотами или /done.');
  if(imp.status==='preview')return this.preview(job,id,imp);
  if(imp.status==='processing')return this.reply(job,id,'Распознавание уже идёт. Результат придёт отдельным сообщением.');
  if(!imp.files?.length)return this.reply(job,id,'Сначала пришлите скриншот портфеля.');
  await this.queue(`extract:${imp.id}:${job.id}`,'extract',{import_id:imp.id,chat_id:id},id);await this.db.patch('pr_imports',{status:'processing'},{id:'eq.'+imp.id});
  return this.reply(job,id,'🔎 <b>Распознаю позиции</b>\n\nЗатем покажу список для проверки. Сохраню портфель после вашего подтверждения.');
 }
 async handleUpdate(job){
  const update=job.payload,cb=update.callback_query,msg=cb?.message||update.message;
  const id=cb?.from?.id||msg?.from?.id;
  if(!Number.isSafeInteger(id)||id<=0||msg?.chat?.type!=='private'||msg.chat.id!==id)return;
  const user=await this.user(id);job.user_id=id;await this.db.patch('pr_jobs',{user_id:id},{id:'eq.'+job.id});
  const ref=String(msg?.text||'').trim().match(/^\/start(?:@\w+)?\s+ref_([0-9a-f]{32})$/i)?.[1]||null;
  await this.billing.touch(id,ref);
  if(msg.successful_payment||msg.refunded_payment)return this.billing.payment(job,id,msg);
  if(cb){
   // Callback answer is a UI acknowledgement, never a financial action.
   await this.telegram('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
   const [action,ref,rowIndex,pageText]=String(cb.data||'').split(':');
   if(action!=='insight'||ref!=='ask')await this.insights.clearQuestion(id);
   if(action==='report')return this.insights.open(job,id,ref,rowIndex,Number(pageText||0));
   if(action==='insight'){
    if(ref==='outlook')return this.outlooks.open(job,id,Number(rowIndex||0));
    if(ref==='report')return this.insights.open(job,id);
    if(ref==='week')return this.insights.week(job,id);
    if(ref==='archive')return this.insights.archive(job,id,Number(rowIndex||0));
    if(ref==='ask')return this.insights.ask(job,id);
    if(ref==='learn')return this.insights.learn(job,id);
    return;
   }
   if(action==='ui'){
    if(ref==='done'&&rowIndex)return this.beginExtraction(job,user,rowIndex);
    if(['home','start','upload','example','help'].includes(ref))return this.showScreen(job,user,ref);
    return;
   }
   if(action==='billing'){if(ref==='buy')return this.billing.menu(job,id,true);if(ref==='cancel')return this.billing.cancelMenu(job,id,true);if(ref==='upgrade')return this.billing.menu(job,id);return;}
   if(action==='forget'&&ref==='yes'){await this.billing.cancel(id);await this.db.rpc('pr_forget',{p_user:id});await this.telegram('sendMessage',{chat_id:id,text:'Ваши портфели и история удалены. Рассылка и продление подписки остановлены. Записи расчётов сохранены.'}).catch(()=>{});return;}
   if(!['save','save_notes','partial','replace','cancel','edit'].includes(action))return;
   const imp=(await this.db.get('pr_imports',{id:'eq.'+ref,user_id:'eq.'+id,limit:1}))[0];
   if(!imp)return this.reply(job,id,'Эта загрузка больше недоступна.');
   if(action==='edit'){
    await this.insights.clearQuestion(id);
    const i=Number(rowIndex);
    if(imp.status!=='preview'||!Number.isInteger(i)||i<0||i>=imp.rows.length)return this.reply(job,id,'Этот список уже изменился. Нажмите /edit.');
    await this.db.patch('pr_imports',{edit_row:i},{id:'eq.'+imp.id});
    return this.reply(job,id,'Уточняем строку '+(i+1)+': '+html(imp.rows[i].name)+'. Напишите тикер или полное название. Количество менять необязательно.');
   }
   if(action==='save'||action==='save_notes'){
    const r=await this.db.rpc('pr_commit',{p_import:imp.id,p_user:id,p_allow_unresolved:action==='save_notes'});
    await this.billing.access(id,true);
    if(r.already_committed)return this.reply(job,id,'Этот портфель уже сохранён. /report — готовый обзор.');
    return this.insights.afterSave(job,user);
   }
   if(!['uploading','preview'].includes(imp.status))return this.reply(job,id,'Загрузка уже обработана или обрабатывается.');
   if(action==='cancel'){await this.db.patch('pr_imports',{status:'cancelled',files:[]},{id:'eq.'+imp.id});return this.reply(job,id,'Загрузка отменена. Портфель сохранён в прежнем виде.');}
   if(imp.correction)return this.preview(job,id,imp);
   imp.mode=action;await this.db.patch('pr_imports',{mode:imp.mode},{id:'eq.'+imp.id});return this.preview(job,id,imp);
  }
  const file=extractFile(msg);
  if(file){
   await this.insights.clearQuestion(id);
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
   await this.insights.event(id,'upload_started',imp.id);
   return this.reply(job,id,`📸 <b>Скриншот ${imp.files.length+1} добавлен</b>\n\nЕсли портфель не помещается на одном экране, пришлите остальные скриншоты <b>этого же счёта</b>.\n\nВсё загрузили? Нажмите «Распознать позиции».`,[[{text:'🔎 Распознать позиции',callback_data:'ui:done:'+imp.id}],[{text:'Отменить загрузку',callback_data:'cancel:'+imp.id}]]);
  }
  const text=String(msg.text||'').trim(),[command,...args]=text.split(/\s+/);const cmd=command?.split('@')[0].toLowerCase();
  if(cmd?.startsWith('/')&&cmd!=='/ask')await this.insights.clearQuestion(id);
  if(cmd==='/report')return this.insights.open(job,id);
  if(cmd==='/outlook'||cmd==='/forecasts')return this.outlooks.open(job,id);
  if(cmd==='/week')return this.insights.week(job,id);
  if(cmd==='/archive')return this.insights.archive(job,id);
  if(cmd==='/calendar')return this.insights.open(job,id,'calendar');
  if(cmd==='/structure')return this.insights.open(job,id,'structure');
  if(cmd==='/learn')return this.insights.learn(job,id);
  if(cmd==='/ask')return this.insights.ask(job,id,args.join(' '));
  if(cmd==='/admin')return this.insights.admin(job,id);
  if(cmd==='/subscribe')return this.billing.menu(job,id);
  if(cmd==='/unsubscribe')return this.billing.cancelMenu(job,id);
  if(cmd==='/referral')return this.billing.referral(job,id);
  if(cmd==='/terms')return this.billing.terms(job,id);
  if(cmd==='/paysupport')return this.billing.support(job,id);
  if(cmd==='/start'||/^(?:начать|старт|start|🚀 начать)$/iu.test(text)){await this.insights.clearQuestion(id);await this.insights.event(id,'start',job.id);return this.showScreen(job,user,'home');}
  if(cmd==='/help')return this.showScreen(job,user,'help');
  if(cmd==='/cancel'){await this.insights.clearQuestion(id);const imp=await this.currentImport(id);if(imp)await this.db.patch('pr_imports',{status:'cancelled',files:[]},{id:'eq.'+imp.id});return this.reply(job,id,'Загрузка отменена.');}
  if(cmd==='/done')return this.beginExtraction(job,user);
  if(cmd==='/account'){
   const name=args.join(' ').slice(0,60);const all=await this.db.get('pr_accounts',{user_id:'eq.'+id,order:'created_at.asc'.replace('created_at','updated_at')});
   if(!name)return this.reply(job,id,'Ваши счета: '+all.map(a=>html(a.name)).join(', ')+'.\n\nВыбрать или создать: /account Название');
   if(await this.currentImport(id))return this.reply(job,id,'Сначала завершите текущую загрузку или нажмите /cancel.');
   let a=all.find(x=>x.name===name);
   if(!a){if(all.length>=LIMITS.accounts)return this.reply(job,id,'В первой версии доступно до 5 счетов.');a=(await this.db.post('pr_accounts',{user_id:id,name}))[0];}
   await this.db.patch('pr_users',{current_account:a.id},{chat_id:'eq.'+id});return this.reply(job,id,'Выбран счёт «'+html(name)+'». Пришлите его скриншоты.');
  }
  if(cmd==='/portfolio'){
   const all=await this.db.get('pr_accounts',{user_id:'eq.'+id,order:'id.asc'}),access=await this.billing.access(id),view=entitledPortfolio(all,access),offer=upgradeOffer(access,{hidden:view.hidden});return this.reply(job,id,all.map(a=>`<b>${html(a.name)}</b> · ${a.positions.length} позиций\n\n${a.positions.length?formatPositions(a.positions):'Пока пусто.'}`).join('\n\n')+(offer.text?'\n\n'+offer.text:''),offer.keyboard);
  }
  if(cmd==='/edit')return this.editMenu(job,user);
  if(cmd==='/fix')return this.handleCorrection(job,user,text);
  if(cmd==='/brief')return this.scheduleOnly(job,user);
  if(cmd==='/pause'||cmd==='/resume'){await this.db.patch('pr_users',{subscribed:cmd==='/resume'},{chat_id:'eq.'+id});return this.reply(job,id,cmd==='/pause'?'Ежедневная рассылка остановлена. /unsubscribe — отдельно отключить продление подписки.':'Ежедневная рассылка включена при наличии доступа к сводкам.');}
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
  if(text&&!text.startsWith('/')){
   if(await this.insights.pendingQuestion(id)){await this.insights.clearQuestion(id);return this.insights.ask(job,id,text);}
   return this.handleCorrection(job,user,text);
  }
  return this.reply(job,id,'Неизвестная команда. /edit — исправить позиции, /time — время сводки, /help — помощь.');
 }
 async handleExtract(job){
  if(!await this.billing.require(job,job.user_id)){await this.db.patch('pr_imports',{status:'uploading'},{id:'eq.'+job.payload.import_id,status:'eq.processing'});return;}
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
   const parsed=await extractPortfolio(images,this.config.openai_key,record=>this.recordUsage(record,job.user_id));
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
  imp.rows=prepareRows(rows);imp.warnings=parsed.warnings||[];
  if(parsed.observed_date&&parsed.observed_date!==new Date().toISOString().slice(0,10))imp.warnings.push('На изображении указана дата '+parsed.observed_date+'. Проверьте актуальность остатков.');
  imp.status='preview';await this.db.patch('pr_imports',{rows:imp.rows,warnings:imp.warnings,status:'preview',updated_at:new Date().toISOString()},{id:'eq.'+imp.id});await this.preview(job,job.user_id,imp);
 }
 async researchKey(asset,now=new Date()){return dailyResearchKey(asset,now);}
 async handleResearch(job){
  const asset=job.payload.asset;let news;
  job.payload.search_started_at??=new Date().toISOString();
  try{
   if(Date.now()-new Date(job.payload.search_started_at)>8*60000){
    if(job.payload.response_id)await this.providers.newsResponse(job.payload.response_id,'CANCEL').catch(()=>{});
    news={status:'unavailable',items:[],events:[],checked_at:job.payload.search_started_at};
   }else{
    let response=null;
    if(job.payload.response_id)response=await this.providers.newsResponse(job.payload.response_id);
    else{
     // Persist the intent BEFORE calling OpenAI. A lost POST response is ambiguous:
     // do not risk paying twice for the same daily asset after a crash/timeout.
     if(job.payload.search_request_state==='started')throw new Error('search_start_uncertain');
     job.payload.search_request_state='started';
     await this.db.patch('pr_jobs',{payload:job.payload},{id:'eq.'+job.id});
    }
    news=await this.providers.news(asset,new Date(job.payload.search_started_at),{response,background:true});
    if(news.pending){
     job.payload.response_id=news.response_id;
     await this.db.patch('pr_jobs',{payload:job.payload,state:'pending',attempts:0,available_at:new Date(Date.now()+10000).toISOString(),lease_until:null},{id:'eq.'+job.id});return 'deferred';
    }
   }
  }catch(e){
   // Poll failures can retry the SAME background response. Never start a second
   // paid analysis on a terminal/ambiguous result; tomorrow gets a new daily key.
   if(job.payload.response_id&&!e.terminalResponse&&/^(network_timeout|http_)/.test(e.message)&&job.attempts<3)throw e;
   news={status:'unavailable',items:[],events:[],checked_at:job.payload.search_started_at};
   job.payload.search_error=String(e.message).slice(0,100);
  }
  const facts=this.providers.facts?await this.providers.facts(asset,new Date(job.payload.search_started_at)).catch(()=>({status:'unavailable',events:[]})):null;
  await this.db.post('pr_cache',{key:job.job_key,value:{news,facts},expires_at:new Date(Date.now()+7*86400000).toISOString()},{on_conflict:'key'},'resolution=merge-duplicates,return=minimal');
  if(job.payload.response_id)await this.providers.newsResponse(job.payload.response_id,'DELETE').catch(()=>{});
 }
 async handleDigest(job){
  // Daily jobs come from the scheduler. The one-time first report additionally
  // needs its customer/job reservation. Legacy/manual/recovery jobs remain blocked.
  const initial=job.payload.initial===true&&await this.insights.initialAllowed(job);
  if(job.payload.initial===true&&!initial)return;
  if(!initial&&(job.payload.daily!==true||!String(job.job_key||'').startsWith('daily:'+job.user_id+':')))return;
  const u=(await this.db.get('pr_users',{chat_id:'eq.'+job.user_id}))[0];if(!u||(job.payload.daily&&!u.subscribed))return;
  const access=await this.billing.access(job.user_id);if(!access.allowed)return;
  const all=await this.db.get('pr_accounts',{user_id:'eq.'+job.user_id,order:'id.asc'});if(!all.some(a=>a.positions.length))return;
  const view=entitledPortfolio(all,access,job.payload.entitled_keys),{accounts,assets}=view;
  job.payload.entitled_keys=view.keys;
  job.payload.news_as_of??=new Date().toISOString();
  if(initial&&!job.payload.initial_seeded){
   const seed=await cachedMarket(this.db,assets,new Date(job.payload.news_as_of));
   job.payload.digest_quotes=seed.quotes;job.payload.cache_keys=seed.cache_keys;job.payload.reused_market_as_of=seed.reused_market_as_of;
   job.payload.initial_fx=seed.fx;
   job.payload.initial_cached_assets=assets.filter(a=>seed.quotes[a.key]?.status==='ok'&&seed.news[a.key]?.status==='ok').length;
   job.payload.initial_seeded=true;
  }
  await this.db.patch('pr_jobs',{payload:job.payload},{id:'eq.'+job.id});
  const kinds=[...new Set(assets.map(a=>a.kind))].sort();
  const market={key:'market',name:'Рынки по направлениям: '+kinds.join(', ')+'; глобальная экономика, Россия'+(kinds.includes('crypto')?', крипторынок':''),kind:'market'};
  // Global market review is deliberately shared; no positions or account values leave through search.
  market.name='Главные события мировой экономики, российского фондового рынка и крипторынка';
  job.payload.news_as_of??=new Date().toISOString();
  const quotes=job.payload.digest_quotes||{},news={},facts={};let marketResult,fx=null,waiting=false;
  for(const a of [market,...assets]){
   const key=job.payload.cache_keys?.[a.key]||await this.researchKey(a,new Date(job.payload.news_as_of));
   job.payload.cache_keys??={};job.payload.cache_keys[a.key]=key;
   const c=(await this.db.get('pr_cache',{key:'eq.'+key,limit:1}))[0];
   if(c&&new Date(c.expires_at)>new Date()){const n=c.value.news;const filtered={...n,items:validateNews(n.items,(n.items||[]).map(x=>x.url),new Date(),n.window_since?(Date.now()-new Date(n.window_since))/3600000:24),events:(n.events||[]).filter(e=>e.date>=new Date().toISOString().slice(0,10))};if(a.key==='market'){marketResult=filtered;fx=c.value.facts?.fx||null;}else{news[a.key]=filtered;facts[a.key]={...(c.value.facts||{}),sector:c.value.facts?.sector||n.profile?.sector||null,issuer_name:c.value.facts?.issuer_name||n.profile?.issuer_name||null,metadata_source:c.value.facts?.metadata_source||null,profile_source:n.profile?.url||null};}continue;}
   const existing=(await this.db.get('pr_jobs',{job_key:'eq.'+key,select:'state',limit:1}))[0];
   if(existing&&['failed','done'].includes(existing.state)){news[a.key]={status:'unavailable',items:[]};continue;}
   await this.queue(key,'research',{asset:{name:a.name,symbol:a.symbol,isin:a.isin,kind:a.kind,key:a.key,provider:a.provider,provider_id:a.provider_id,verified:a.verified,currency:a.currency,cik:a.cik}});waiting=true;
  }
  if(waiting){await this.db.patch('pr_jobs',{payload:job.payload,state:'pending',attempts:0,available_at:new Date(Date.now()+15000).toISOString(),lease_until:null},{id:'eq.'+job.id});return 'deferred';}
  const missing=assets.filter(a=>!Object.hasOwn(quotes,a.key));
  if(missing.length){
   await Promise.all(missing.slice(0,4).map(async a=>{
    try{quotes[a.key]=await this.providers.memo(quoteCacheKey(a),900,()=>this.providers.quote(a));}catch{quotes[a.key]={status:'unavailable',price:null};}
    await rememberQuote(this.db,a,quotes[a.key]);
   }));
   job.payload.digest_quotes=quotes;
   await this.db.patch('pr_jobs',{payload:job.payload},{id:'eq.'+job.id});
   if(missing.length>4){await this.db.patch('pr_jobs',{state:'pending',attempts:0,available_at:new Date(Date.now()+1000).toISOString(),lease_until:null},{id:'eq.'+job.id});return 'deferred';}
  }
  if(initial&&!fx){
   fx=job.payload.initial_fx||null;
   const needsFx=assets.some(a=>{const currency=quotes[a.key]?.unit_currency||quotes[a.key]?.currency||a.currency;return /^[A-Z]{3}$/.test(currency||'')&&currency!=='RUB';});
   if(!fx&&needsFx&&this.providers.facts)fx=await this.providers.memo(fxCacheKey(),86400,async()=>{const value=await this.providers.facts({key:'market'},new Date());return value?.fx||null;}).catch(()=>null);
  }
  // Re-check access at delivery: a trial can expire while shared news is being prepared.
  const finalAccess=await this.billing.access(job.user_id),finalView=entitledPortfolio(all,finalAccess,view.keys);
  if(initial)await this.insights.finishInitial(job,{...u,chat_id:job.user_id},quotes,news,marketResult,facts,fx);
  else await this.insights.daily(job,{...u,chat_id:job.user_id},all,finalView,quotes,news,marketResult,facts,fx);
 }
 async flush(){
  const rows=await this.db.get('pr_outbox',{state:'eq.pending',available_at:'lte.'+new Date().toISOString(),order:'id.asc',limit:2});
  for(const r of rows){
   const claimed=await this.db.patch('pr_outbox',{state:'sending',attempts:r.attempts+1,available_at:new Date().toISOString()},{id:'eq.'+r.id,state:'eq.pending'});
   if(!claimed?.length)continue;
   let attempted=false,delivered=false;
   try{
    const body=await this.insights.deliveryBody(r);
    if(!body){await this.db.patch('pr_outbox',{state:'failed',last_error:'report_or_access_changed',body:{}},{id:'eq.'+r.id});continue;}
    attempted=true;const res=await this.telegram(r.method,body);delivered=true;await this.db.patch('pr_outbox',{state:'sent',telegram_message_id:res?.message_id??null,body:{}},{id:'eq.'+r.id});
    await this.insights.delivered(r);
   }
   catch(e){
    // Telegram has no idempotency key for sendMessage. Ambiguous network delivery
    // is retained for inspection rather than automatically duplicating a digest.
    const retry=!delivered&&(!attempted||e.status===429||(e.status>=500&&e.status<=599));
    await this.db.patch('pr_outbox',{state:retry&&r.attempts<5?'pending':delivered||attempted&&!e.status?'uncertain':'failed',available_at:new Date(Date.now()+(e.retryAfter||60)*1000).toISOString(),last_error:delivered?'sent_tracking_failed':!attempted?'report_render_pending':e.status?'telegram_'+e.status:'delivery_status_unknown'},{id:'eq.'+r.id});
    if(e.status===403)await this.db.patch('pr_users',{subscribed:false},{chat_id:'eq.'+r.user_id});
   }
  }
 }
 async work(){return {lanes:await Promise.allSettled([this.workLane(1),this.workLane(2)])};}
 async workLane(lane){
  // Commands and onboarding must still respond when image recognition is unavailable.
  if(!this.config.telegram_token)return {ready:false};
  const token=crypto.randomUUID(),locked=await this.db.rpc('pr_lock',{p_token:token,p_lane:lane});if(!locked)return {busy:true};const started=Date.now();let count=0;
  try{
   if(lane===2){await this.db.rpc('pr_daily_jobs');await this.db.rpc('pr_cleanup');}await this.flush();
   while(Date.now()-started<20000&&count<4){
    const job=(await this.db.rpc('pr_next_job',{p_lane:lane}))[0];if(!job)break;
    try{
     const result=await ({update:()=>this.handleUpdate(job),extract:()=>this.handleExtract(job),research:()=>this.handleResearch(job),digest:()=>this.handleDigest(job)}[job.kind])();
     if(result!=='deferred')await this.db.patch('pr_jobs',{state:'done',payload:['update','extract'].includes(job.kind)?{}:job.payload,lease_until:null,last_error:null},{id:'eq.'+job.id});
    }catch(e){
     const retry=e.retryable!==false&&/^(network_timeout|http_|telegram_|database_|search_incomplete)/.test(e.message)&&job.attempts<3;
     const retryDelay=Math.max(job.attempts*60,Number.isFinite(e.retryAfter)?e.retryAfter:0);
     await this.db.patch('pr_jobs',{state:retry?'pending':'failed',available_at:new Date(Date.now()+retryDelay*1000).toISOString(),lease_until:null,last_error:String(e.message).slice(0,150)},{id:'eq.'+job.id});
     if(!retry&&job.payload.initial===true)await this.db.patch('pr_initial_reports',{state:'failed',finished_at:new Date().toISOString()},{user_id:'eq.'+job.user_id,job_id:'eq.'+job.id});
     if(!retry&&job.user_id){
      if(job.payload.message?.successful_payment||job.payload.message?.refunded_payment){await this.reply(job,job.user_id,'Telegram прислал информацию об оплате, но обработка задержалась. Повторно оплачивать не нужно. /paysupport — помощь.',null,'payment_error');count++;await this.flush();continue;}
      if(job.kind==='extract')await this.db.patch('pr_imports',{status:'uploading'},{id:'eq.'+job.payload.import_id,status:'eq.processing'});
      const quota=['openai_credit_balance_exhausted','openai_insufficient_quota'].includes(e.message);
      if(quota||job.kind==='extract'&&e.message==='http_429'){
       const owner=job.user_id===Number(this.env.PORTFOLIO_OWNER_CHAT||85572233);
       const reason=quota&&owner?(e.message==='openai_credit_balance_exhausted'?'На OpenAI API закончились кредиты. Пополните баланс API.':'OpenAI API отклонил запрос из-за квоты. Проверьте баланс и лимит расходов API.'):'Сервис распознавания временно недоступен. Попробуйте позже.';
       const text=job.kind==='extract'?'⚠️ <b>Распознавание приостановлено</b>\n\n'+reason+'\n\nСкриншоты остаются в текущей загрузке. После восстановления сервиса нажмите «Распознать позиции» — повторно отправлять изображения сейчас не нужно.':(owner?reason:'ИИ-сервис временно недоступен. Попробуйте позже.');
       const keyboard=job.kind==='extract'?[[{text:'🔎 Распознать позиции',callback_data:'ui:done:'+job.payload.import_id}]]:null;
       await this.reply(job,job.user_id,text,keyboard,'error');count++;await this.flush();continue;
      }
      const friendly={stale_import:'Портфель уже изменился. Отмените эту загрузку и пришлите новые скриншоты.',unresolved_rows:'Сначала уточните отмеченные позиции через /fix.',import_not_ready:'Эта загрузка ещё не готова к сохранению.',positions_not_found:'На скриншоте не удалось найти позиции. Пришлите более чёткое изображение.',openai_key_missing:'Распознавание пока не подключено.'};
      await this.reply(job,job.user_id,friendly[e.message]||'Не удалось завершить обработку. Сохранённый портфель не изменился. Повторите команду; для новой загрузки — /cancel.',null,'error');
     }
    }
    count++;await this.flush();if(job.kind==='extract'||job.kind==='research')break;
   }return {processed:count};
  }finally{await this.db.rpc('pr_unlock',{p_token:token,p_lane:lane});}
 }
 async register(base){
  if(!this.config.telegram_token||!this.config.openai_key)throw new Error('credentials_missing');
  const me=await this.telegram('getMe',{});
  const current=await this.telegram('getWebhookInfo',{});const target=base.replace(/\/$/,'')+'/webhook';
  if(current.url&&current.url!==target)throw new Error('bot_already_connected_elsewhere');
  await this.telegram('setWebhook',{url:target,secret_token:this.config.webhook_secret,allowed_updates:['message','callback_query','pre_checkout_query'],max_connections:10,drop_pending_updates:false});
  await this.telegram('setMyCommands',{commands:[{command:'start',description:'Главный экран Portfolius'},{command:'help',description:'Как пользоваться Portfolius'},{command:'done',description:'Распознать загруженные скриншоты'},{command:'report',description:'Открыть готовый обзор'},{command:'outlook',description:'Прогнозы и ориентиры по активам'},{command:'week',description:'Итоги недели'},{command:'calendar',description:'Календарь событий и выплат'},{command:'structure',description:'Структура портфеля'},{command:'archive',description:'Архив обзоров'},{command:'ask',description:'Задать вопрос по портфелю'},{command:'learn',description:'Объяснение терминов'},{command:'portfolio',description:'Мои позиции'},{command:'edit',description:'Исправить позицию'},{command:'subscribe',description:'Моя подписка'},{command:'referral',description:'Пригласить друзей'},{command:'unsubscribe',description:'Отключить продление'},{command:'paysupport',description:'Помощь с оплатой'},{command:'terms',description:'Условия подписки'},{command:'account',description:'Выбрать счёт'},{command:'time',description:'Время ежедневной сводки'},{command:'pause',description:'Остановить рассылку'},{command:'resume',description:'Включить рассылку'},{command:'cancel',description:'Отменить загрузку'},{command:'delete',description:'Удалить мои данные'}]});
  for(const language_code of ['', 'ru']){
   await this.telegram('setMyName',{name:BOT_NAME,language_code});
   await this.telegram('setMyDescription',{description:BOT_DESCRIPTION,language_code});
   await this.telegram('setMyShortDescription',{short_description:BOT_SHORT_DESCRIPTION,language_code});
  }
  await this.telegram('setChatMenuButton',{menu_button:{type:'commands'}});
  return {username:me.username,url:'https://t.me/'+me.username};
 }
}
export function timingSafe(a,b){if(typeof a!=='string'||typeof b!=='string'||!a||a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0;}
export function createHandler(env,waitUntil=()=>{},dbOverride){
 const db=dbOverride||new Database(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY);
 return async req=>{
  const path=new URL(req.url).pathname.split('/').filter(Boolean).at(-1),json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(req.method==='GET'&&path==='health')return json({service:'portfolio-radar',version:'0.6.2',status:'running'});
  if(req.method!=='POST')return json({error:'not_found'},404);
  try{
   const radar=new Radar(db,env);await radar.init();
   if(path==='tbank-notification'){
    const raw=await req.text();if(raw.length>16000)return json({error:'too_large'},413);
    const valid=await radar.billing.bank.notification(JSON.parse(raw));
    if(!valid)return json({error:'invalid_notification'},401);
    waitUntil(radar.flush().catch(()=>console.error('billing_delivery_pending')));
    return new Response('OK',{headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
   }
   if(path==='webhook'){
    if(!timingSafe(req.headers.get('x-telegram-bot-api-secret-token'),radar.config.webhook_secret))return json({error:'unauthorized'},401);
    if(Number(req.headers.get('content-length'))>100000)return json({error:'too_large'},413);
    const raw=await req.text();if(raw.length>100000)return json({error:'too_large'},413);const update=JSON.parse(raw);
    if(!Number.isSafeInteger(update.update_id))return json({error:'invalid_update'},400);
    if(update.pre_checkout_query){await radar.billing.checkout(update.pre_checkout_query);return json({ok:true});}
    await radar.queue('update:'+update.update_id,'update',update);
    waitUntil(radar.work().catch(()=>console.error('portfolio_worker_failed')));return json({ok:true});
   }
   if(!timingSafe(req.headers.get('x-portfolio-worker-secret'),radar.config.worker_secret))return json({error:'unauthorized'},401);
   if(path==='billing-audit'){
    const raw=await req.text();if(raw.length>200)return json({error:'too_large'},413);
    let data;try{data=JSON.parse(raw);}catch{return json({error:'invalid_request'},400);}
    return json(await radar.billing.bank.audit(data?.order_id));
   }
   if(path==='outlook-work'){waitUntil(radar.outlooks.work().catch(()=>console.error('outlook_worker_failed')));return json({accepted:true});}
   if(path==='billing-work'){waitUntil(Promise.allSettled([radar.billing.bank.work(),radar.insights.maintenance()]).then(async results=>{if(results.some(r=>r.status==='rejected'))console.error('billing_or_lifecycle_pending');await radar.flush();}));return json({accepted:true});}
   if(path==='metrics')return json(await radar.db.rpc('pr_product_metrics'));
   if(path==='billing-probe')return json(await radar.billing.bank.gateway('Status'));
   if(path==='work'){waitUntil(radar.work().catch(()=>console.error('portfolio_worker_failed')));return json({accepted:true});}
   if(path==='probe'){const started=Date.now();try{const me=await radar.telegram('getMe',{});return json({ok:true,username:me.username,elapsed_ms:Date.now()-started});}catch(e){return json({ok:false,code:e.message,elapsed_ms:Date.now()-started});}}
   if(path==='register'){try{const base=env.SUPABASE_URL.replace(/\/$/,'')+'/functions/v1/portfolio-radar';return json(await radar.register(base));}catch(e){return json({error:'registration_failed',code:e.message},502);}}
   if(path==='status')return json({telegram_configured:!!radar.config.telegram_token,ai_configured:!!radar.config.openai_key});
   return json({error:'not_found'},404);
  }catch{console.error('portfolio_request_failed');return json({error:'processing_failed'},500);}
 };
}
