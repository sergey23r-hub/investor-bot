import {html,LIMITS} from './core.js';
import {PoolProvider,canonicalXStock} from './lp-provider.js';
import {HOUR,comparison,correctPosition,normalizePosition} from './lp-data.js';
import {lpPaid,poolsView,previewText,teaser} from './lp-format.js';
import {extractPools} from './lp-extraction.js';
const uuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s||'');
const defaults=['MSFTx','TSLAx','NVDAx','SPYx','QQQx','COINx','AAPLx'];
export class Pools{
 constructor(radar){this.radar=radar;this.db=radar.db;this.provider=new PoolProvider(this.db);}
 async event(user,event,key){try{await this.db.post('pr_lp_events',{user_id:user,event,dedup_key:event+':'+key},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');}catch{console.error('lp_metric_pending');}}
 async markets(){return this.db.get('pr_lp_market',{order:'symbol.asc',limit:1000});}
 async profile(user){return (await this.db.get('pr_lp_profiles',{user_id:'eq.'+user,limit:1}))[0];}
 async current(user){return (await this.db.get('pr_lp_imports',{user_id:'eq.'+user,status:'in.(uploading,processing,preview)',limit:1}))[0];}
 async require(job,user){if(lpPaid(await this.radar.billing.access(user)))return true;await this.open(job,user);return false;}
 async teaser(){const markets=await this.markets().catch(()=>[]);return teaser(markets.flatMap(m=>m.data?.pools||[]));}
 async body(user,section='home',page=0,access=null){
  access ||=await this.radar.billing.access(user);const [profile,markets]=await Promise.all([lpPaid(access)?this.profile(user):null,this.markets()]);
  const view=poolsView({access,profile,markets,section,page});
  return {chat_id:user,text:view.text,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:view.keyboard}};
 }
 async open(job,user,section='home',page=0){
  const body=await this.body(user,section,page);
  await this.db.post('pr_outbox',{dedup_key:`${job.id}:lp:${section}:${page}`,user_id:user,body:{...body,_portfolius:{pools:true,section,page}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
  await this.event(user,'open',job.id+':'+section);
 }
 async callback(job,user,action,ref,page){
  if(action==='upgrade'){await this.event(user,'upgrade',job.id);return this.radar.billing.menu(job,user);}
  if(['home','market','coverage','unrated'].includes(action))return this.open(job,user,action,Number(ref)||0);
  if(action==='upload')return this.upload(job,user);
  if(!uuid(ref))return;
  const imp=(await this.db.get('pr_lp_imports',{id:'eq.'+ref,user_id:'eq.'+user,limit:1}))[0];if(!imp)return this.radar.reply(job,user,'Эта загрузка пулов недоступна. /pools — открыть раздел.');
  if(action==='cancel'){await this.cancel(user);return this.radar.reply(job,user,'Загрузка LP-позиций отменена.');}
  if(!await this.require(job,user))return;
  if(action==='done')return this.begin(job,user,imp);
  if(action==='preview'&&imp.status==='preview')return this.preview(job,user,imp,Number(page)||0);
  if(action==='save'){
   await this.db.rpc('pr_lp_commit',{p_user:user,p_import:ref});await this.event(user,'saved',ref);
   await this.radar.reply(job,user,'✅ <b>LP-позиции сохранены</b>\n\nНовый список заменил предыдущий. Мониторинг работает автоматически: ежедневный отчёт — в выбранное вами время /time. При устойчивой разнице от 5 п.п. пришлём дополнительный сигнал, не чаще раза в сутки. Первый отчёт придёт после проверки всех указанных активов.\n\nНовые скриншоты: /pools → «Добавить / заменить пулы». /pause — остановить рассылку.',null,'lp_saved');
   return this.open(job,user);
  }
 }
 async cancel(user){await this.db.patch('pr_lp_imports',{status:'cancelled',files:[],rows:[],updated_at:new Date().toISOString()},{user_id:'eq.'+user,status:'in.(uploading,processing,preview)'});}
 async upload(job,user){
  if(!await this.require(job,user))return;
  if(await this.radar.currentImport(user))return this.radar.reply(job,user,'Сначала сохраните или отмените обычную загрузку портфеля через /cancel. Затем откройте /pools.');
  await this.radar.insights.clearQuestion(user);
  let imp=await this.current(user);if(imp?.status==='preview')return this.preview(job,user,imp);
  if(imp?.status==='processing')return this.radar.reply(job,user,'LP-скриншоты уже распознаются.');
  if(!imp){
   const recent=await this.db.get('pr_lp_imports',{user_id:'eq.'+user,created_at:'gte.'+new Date(Date.now()-86400000).toISOString(),select:'id',limit:6});
   if(recent.length>=6)return this.radar.reply(job,user,'Лимит — 6 загрузок LP-позиций в сутки. Следующая доступна завтра.');
   const profile=await this.profile(user);imp=(await this.db.post('pr_lp_imports',{user_id:user,base_version:profile?.version||0}))[0];
  }
  return this.radar.reply(job,user,'📸 <b>Добавьте все текущие пулы xStocks / USDC</b>\n\nПришлите до 8 скриншотов: тикер, сеть, площадка, сумма позиции в USD и, по возможности, адрес пула. APR/APY и диапазон цены тоже полезны.\n\nПосле распознавания можно исправить строки. Сохранение заменит весь список LP-позиций; обычный портфель остаётся отдельным.\n\n<i>Личные данные и адрес кошелька можно закрыть. Изображения передаются в OpenAI для распознавания. Нужен только просмотр: кошелёк подключать не требуется.</i>',[[{text:'Распознать LP-позиции',callback_data:'lp:done:'+imp.id}],[{text:'Отменить',callback_data:'lp:cancel:'+imp.id}]]);
 }
 async file(job,user,file,imp){
  if(!await this.require(job,user))return;
  if(imp.status!=='uploading')return this.radar.reply(job,user,'Сохраните или отмените текущий список LP-позиций. /cancel — отмена.');
  if(imp.files.some(f=>f.unique_id===file.unique_id))return this.radar.reply(job,user,'Этот скриншот уже добавлен. /done — распознать пулы.');
  if(imp.files.length>=8)return this.radar.reply(job,user,'Добавлено 8 скриншотов. /done — распознать пулы.');
  await this.db.patch('pr_lp_imports',{files:[...imp.files,file],updated_at:new Date().toISOString()},{id:'eq.'+imp.id,user_id:'eq.'+user,status:'eq.uploading'});
  await this.event(user,'upload',imp.id);
  return this.radar.reply(job,user,`📸 Скриншот LP-позиций ${imp.files.length+1} добавлен. Пришлите остальные или нажмите «Распознать».`,[[{text:'Распознать LP-позиции',callback_data:'lp:done:'+imp.id}],[{text:'Отменить',callback_data:'lp:cancel:'+imp.id}]]);
 }
 async begin(job,user,imp){
  if(!await this.require(job,user))return;
  if(imp.status==='preview')return this.preview(job,user,imp);
  if(imp.status==='processing')return this.radar.reply(job,user,'Распознавание пулов уже идёт.');
  if(imp.status!=='uploading'||!imp.files?.length)return this.radar.reply(job,user,'Пришлите скриншоты LP-позиций в текущую загрузку.');
  await this.radar.queue('lp:extract:'+imp.id+':'+job.id,'extract',{pool_import_id:imp.id,chat_id:user},user);
  await this.db.patch('pr_lp_imports',{status:'processing',updated_at:new Date().toISOString()},{id:'eq.'+imp.id,user_id:'eq.'+user,status:'eq.uploading'});
  return this.radar.reply(job,user,'🔎 Распознаю LP-позиции. Покажу список для проверки перед сохранением.');
 }
 async previewBody(user,id,page=0,access=null){
  access ||=await this.radar.billing.access(user);if(!lpPaid(access))return this.body(user,'home',0,access);
  const imp=(await this.db.get('pr_lp_imports',{id:'eq.'+id,user_id:'eq.'+user,status:'eq.preview',limit:1}))[0];if(!imp)return null;
  const markets=await this.markets(),view=previewText(imp,markets.flatMap(m=>m.data?.pools||[]),page),keyboard=[];
  if(view.pages>1)keyboard.push([...(view.page>0?[{text:'←',callback_data:`lp:preview:${id}:${view.page-1}`}]:[]),...(view.page+1<view.pages?[{text:'→',callback_data:`lp:preview:${id}:${view.page+1}`}]:[])]);
  keyboard.push([{text:'Сохранить новый список целиком',callback_data:'lp:save:'+id}],[{text:'Отменить',callback_data:'lp:cancel:'+id}]);
  return {chat_id:user,text:view.text,parse_mode:'HTML',reply_markup:{inline_keyboard:keyboard},link_preview_options:{is_disabled:true}};
 }
 async preview(job,user,imp,page=0){
  const body=await this.previewBody(user,imp.id,page);if(!body)return;
  await this.db.post('pr_outbox',{dedup_key:`${job.id}:lp_preview:${imp.id}:${page}`,user_id:user,body:{...body,_portfolius:{lp_preview:imp.id,page}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
  await this.event(user,'preview',imp.id);
 }
 async correction(job,user,text){
  if(!await this.require(job,user))return;
  let imp=await this.current(user);
  if(imp&&imp.status!=='preview')return this.radar.reply(job,user,'Сначала распознайте LP-скриншоты через /done.');
  if(imp?.last_edit_key===String(job.id))return this.preview(job,user,imp);
  const profile=imp?null:await this.profile(user),rows=imp?.rows||profile?.positions||[];
  if(!rows.length)return this.radar.reply(job,user,'Сначала добавьте LP-позиции через /pools.');
  const next=correctPosition(rows,text);if(!next)return this.radar.reply(job,user,'Уточнение: <code>/poolfix 1 сумма=1000</code> или <code>/poolfix 1 актив=MSFTx сеть=Solana площадка=Raydium пул=АДРЕС</code>.');
  const normalized=next.map(r=>({...normalizePosition(r),symbol:r.symbol?canonicalXStock(r.symbol):null}));
  if(!imp)imp=(await this.db.post('pr_lp_imports',{user_id:user,status:'preview',base_version:profile.version,rows:normalized,last_edit_key:String(job.id)}))[0];
  else{imp.rows=normalized;await this.db.patch('pr_lp_imports',{rows:normalized,last_edit_key:String(job.id),updated_at:new Date().toISOString()},{id:'eq.'+imp.id,user_id:'eq.'+user,status:'eq.preview'});}
  return this.preview(job,user,imp);
 }
 async extract(job){
  const user=job.user_id,imp=(await this.db.get('pr_lp_imports',{id:'eq.'+job.payload.pool_import_id,user_id:'eq.'+user,limit:1}))[0];
  if(!imp||!['processing','preview'].includes(imp.status))return;
  if(!await this.require(job,user)){await this.db.patch('pr_lp_imports',{status:'uploading'},{id:'eq.'+imp.id,status:'eq.processing'});return;}
  if(imp.status==='preview')return this.preview(job,user,imp);
  try{
   if(job.payload.lp_request_started)throw Error('lp_recognition_uncertain');
   const images=await this.radar.downloadImages(imp.files);
   job.payload.lp_request_started=true;await this.db.patch('pr_jobs',{payload:job.payload},{id:'eq.'+job.id});
   const parsed=await extractPools(images,this.radar.config.openai_key,r=>this.radar.recordUsage(r,user));
   imp.rows=parsed.positions.map(r=>({...r,symbol:r.symbol?canonicalXStock(r.symbol):null}));imp.warnings=parsed.warnings;
   const changed=await this.db.patch('pr_lp_imports',{status:'preview',rows:imp.rows,warnings:imp.warnings,files:[],updated_at:new Date().toISOString()},{id:'eq.'+imp.id,user_id:'eq.'+user,status:'eq.processing'});
   if(changed?.length)await this.preview(job,user,imp);
  }catch(e){
   await this.db.patch('pr_lp_imports',{status:'uploading',updated_at:new Date().toISOString()},{id:'eq.'+imp.id,status:'eq.processing'});
   const uncertain=job.payload.lp_request_started&&!/^openai_|^lp_positions_not_found|^lp_too_many_positions|^http_4/.test(e.message);
   const reason=e.message==='lp_positions_not_found'?'На изображении не найдены позиции xStocks / USDC.':uncertain?'Ответ распознавания не удалось подтвердить. Автоматически повторять платный запрос не буду.':'Сервис распознавания временно недоступен.';
   await this.radar.reply(job,user,'⚠️ '+reason+' Скриншоты сохранены в загрузке; состав ваших пулов не изменён. Можно повторить /done или отменить /cancel.',[[{text:'Повторить распознавание',callback_data:'lp:done:'+imp.id}]],'lp_error');
  }
 }
 async deliveryBody(row,guard,access){
  if(guard.lp_preview)return this.previewBody(row.user_id,guard.lp_preview,guard.page,access);
  if(guard.automatic){
   const [u,p]=await Promise.all([this.db.get('pr_users',{chat_id:'eq.'+row.user_id,limit:1}),this.profile(row.user_id)]);
   if(!lpPaid(access)||!u[0]?.subscribed||!p?.enabled||guard.version!==p.version)return null;
   if(guard.lp_kind==='alert'){
    const pools=(await this.markets()).flatMap(m=>m.data?.pools||[]);
    if(!p.positions.slice((guard.page||0)*2,(guard.page||0)*2+2).some(r=>comparison(r,pools).delta>=5))return null;
   }
  }
  const body=await this.body(row.user_id,guard.section,guard.page,access);
  if(guard.lp_kind==='alert')body.text='🔔 <b>Устойчивая разница комиссий: от 5 п.п.</b>\n\n'+body.text;
  return body;
 }
 async automatic(user,key,kind,profile,page=0){
  // Body is re-rendered with current entitlement, subscription and LP version
  // immediately before delivery. No stale paid content survives expiration.
  const body=await this.body(user,'home',page);
  await this.db.post('pr_outbox',{dedup_key:key,user_id:user,body:{...body,_portfolius:{pools:true,section:'home',page,automatic:true,version:profile.version,lp_kind:kind}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
 }
 async work(){
  const token=crypto.randomUUID();if(!await this.db.rpc('pr_lp_lock',{p_token:token}))return {busy:true};
  try{
   await this.db.rpc('pr_lp_maintenance');
   const [targets,markets]=await Promise.all([this.db.rpc('pr_lp_targets'),this.markets()]);
   const symbols=[...new Set([...(targets||[]).map(canonicalXStock),...defaults])].filter(s=>/^[A-Z0-9.\-]{1,20}x$/.test(s));
   const bySymbol=new Map(markets.map(m=>[m.symbol,m]));
   // User positions take precedence; one shared asset per minute keeps the
   // public APIs comfortably below their limits. Backlog remains observable.
   const due=symbols.filter(s=>!bySymbol.has(s)||Date.now()-Date.parse(bySymbol.get(s).updated_at)>HOUR).sort((a,b)=>(Date.parse(bySymbol.get(a)?.updated_at)||0)-(Date.parse(bySymbol.get(b)?.updated_at)||0));
   const symbol=due[0];let latest=null;
   if(symbol){
    latest=await this.provider.collect(symbol);const previous=bySymbol.get(symbol)?.data;
    // Retain old rows for an unavailable source with their ORIGINAL timestamp.
    // Never renew stale data simply because a new collection attempt ran.
    if(previous&&latest.coverage.some(c=>c.status==='unavailable')){
     const keys=new Set(latest.pools.map(p=>p.key));latest.pools.push(...previous.pools.filter(p=>!keys.has(p.key)&&Date.now()-Date.parse(p.observed_at)<7*24*HOUR));
     latest.asset ||=previous.asset;
    }
    await this.db.post('pr_lp_market',{symbol,data:latest,updated_at:new Date().toISOString()},{on_conflict:'symbol'},'resolution=merge-duplicates,return=minimal');
   }
   for(const item of await this.db.rpc('pr_lp_due')){const profile=await this.profile(item.user_id);await this.automatic(item.user_id,`lp:daily:${item.user_id}:${item.service_day}`,'daily',profile);}
   if(latest){
    const previous=bySymbol.get(symbol)?.data;
    for(let offset=0;offset<10000;offset+=100){
     const profiles=await this.db.get('pr_lp_profiles',{enabled:'eq.true',positions:'cs.'+JSON.stringify([{symbol}]),order:'user_id.asc',limit:100,offset});
     for(const profile of profiles){
      const user=profile.user_id,u=(await this.db.get('pr_users',{chat_id:'eq.'+user,subscribed:'eq.true',limit:1}))[0];if(!u||!lpPaid(await this.radar.billing.access(user)))continue;
      const rows=profile.positions.filter(p=>p.symbol===symbol),newPools=latest.pools||[],oldPools=previous?.pools||[];
      const currentMarkets=markets.filter(m=>m.symbol!==symbol).concat({symbol,data:latest});
      if(profile.positions.every(p=>currentMarkets.some(m=>m.symbol===p.symbol&&m.data.asset&&Date.now()-Date.parse(m.data.checked_at)<4*HOUR)))await this.automatic(user,`lp:first:${user}:${profile.version}`,'first',profile);
      const stable=previous&&Date.parse(latest.checked_at)-Date.parse(previous.checked_at)>=30*60000&&rows.find(r=>{const a=comparison(r,oldPools,Date.parse(previous.checked_at)),b=comparison(r,newPools);return a.delta>=5&&b.delta>=5&&a.best?.key===b.best?.key&&Date.parse(b.best.observed_at)>Date.parse(a.best.observed_at)&&Date.parse(b.current.observed_at)>Date.parse(a.current.observed_at);});
      if(stable&&(!profile.last_alert_at||Date.now()-Date.parse(profile.last_alert_at)>24*HOUR)){
       const page=Math.floor(profile.positions.indexOf(stable)/2),day=new Date().toISOString().slice(0,10);await this.automatic(user,`lp:alert:${user}:${day}`,'alert',profile,page);
       await this.db.patch('pr_lp_profiles',{last_alert_at:new Date().toISOString()},{user_id:'eq.'+user});
      }
     }
     if(profiles.length<100)break;
    }
   }
   return {collected:symbol||null};
  }finally{await this.db.rpc('pr_lp_unlock',{p_token:token});}
 }
}
