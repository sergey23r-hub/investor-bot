import {PoolProvider,canonicalXStock} from './lp-provider.js';
import {HOUR,correctPosition,normalizePosition,applyVenue,venueSuggestions,positionCandidates,candidateToken,withPool} from './lp-data.js';
import {lpPaid,poolsView,previewText,teaser,matchingButtons,candidatesView,top5Summary} from './lp-format.js';
import {extractPools} from './lp-extraction.js';
import {portfolioProposals,opportunity,actionable,stableOpportunity} from './lp-opportunities.js';
const uuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s||'');
const defaults=['MSFTx','TSLAx','NVDAx','SPYx','QQQx','COINx','AAPLx'];
export class Pools{
 constructor(radar){this.radar=radar;this.db=radar.db;this.provider=new PoolProvider(this.db);}
 async event(user,event,key){try{await this.db.post('pr_lp_events',{user_id:user,event,dedup_key:event+':'+key},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');}catch{console.error('lp_metric_pending');}}
 async markets(){return this.db.get('pr_lp_market',{order:'symbol.asc',limit:1000});}
 async profile(user){return (await this.db.get('pr_lp_profiles',{user_id:'eq.'+user,limit:1}))[0];}
 async current(user){return (await this.db.get('pr_lp_imports',{user_id:'eq.'+user,status:'in.(uploading,processing,preview)',limit:1}))[0];}
 async require(job,user){if(lpPaid(await this.radar.billing.access(user)))return true;await this.open(job,user);return false;}
 async teaser(access=null){const markets=await this.markets().catch(()=>[]);return lpPaid(access)?top5Summary(markets):teaser(markets.flatMap(m=>m.data?.pools||[]));}
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
  if(['home','top','holdings','positions','market','coverage','unrated'].includes(action))return this.open(job,user,action,Number(ref)||0);
  if(action==='upload')return this.upload(job,user);
  if(action==='match')return this.match(job,user);
  if(action==='accept')return this.accept(job,user,ref,page);
  if(!uuid(ref))return;
  const imp=(await this.db.get('pr_lp_imports',{id:'eq.'+ref,user_id:'eq.'+user,limit:1}))[0];if(!imp)return this.radar.reply(job,user,'Эта загрузка пулов недоступна. /pools — открыть раздел.');
  if(action==='cancel'){await this.cancel(user);return this.radar.reply(job,user,'Загрузка LP-позиций отменена.');}
  if(!await this.require(job,user))return;
  if(action==='done')return this.begin(job,user,imp);
  if(action==='preview'&&imp.status==='preview')return this.preview(job,user,imp,Number(page)||0);
  if(action==='options'&&imp.status==='preview')return this.preview(job,user,imp,Number(page)||0,true);
  if(['venue','choose','pick'].includes(action)){
   if(imp.status!=='preview')return this.radar.reply(job,user,'Этот список уже закрыт. /pools — открыть текущие пулы.');
   const all=(await this.markets()).flatMap(m=>m.data?.pools||[]);
   if(action==='choose')return this.choose(job,user,imp,page);
   if(imp.last_edit_key===String(job.id))return this.preview(job,user,imp);
   let rows;
   if(action==='venue'){
    if(!venueSuggestions(imp.rows,all).some(g=>g.key===page))return this.preview(job,user,imp);
    rows=applyVenue(imp.rows,all,page);
   }else{
    const [indexText,token]=String(page).split('.'),index=Number(indexText),row=imp.rows[index];
    if(!Number.isInteger(index)||!row)return;
    const candidates=positionCandidates(row,all).filter(p=>candidateToken(p)===token);
    if(candidates.length!==1)return this.choose(job,user,imp,index+'.0');
    rows=imp.rows.map((r,i)=>i===index?withPool(r,candidates[0]):r);
   }
   await this.db.patch('pr_lp_imports',{rows,last_edit_key:String(job.id),updated_at:new Date().toISOString()},{id:'eq.'+imp.id,user_id:'eq.'+user,status:'eq.preview'});
   return this.preview(job,user,imp,action==='pick'?Math.floor(Number(String(page).split('.')[0])/10):0);
  }
  if(action==='save'){
   await this.db.rpc('pr_lp_commit',{p_user:user,p_import:ref});await this.event(user,'saved',ref);
   return this.open(job,user);
  }
 }
 async accept(job,user,ref,token){
  if(!await this.require(job,user))return;
  const pools=(await this.markets()).flatMap(m=>m.data?.pools||[]);
  let imp,profile,source;
  const marker=`accept:${ref}:${token}`;
  if(uuid(ref)){
   imp=(await this.db.get('pr_lp_imports',{id:'eq.'+ref,user_id:'eq.'+user,limit:1}))[0];
   if(!imp)return this.open(job,user);
   if(imp.status==='committed')return this.open(job,user);
   if(imp.status!=='preview')return this.radar.reply(job,user,'Этот список уже закрыт. /pools — текущие предложения.');
   source=imp.rows;
  }else{
   if(!/^\d+$/.test(String(ref)))return;
   profile=await this.profile(user);if(!profile||profile.version!==Number(ref))return this.open(job,user);
   if(await this.radar.currentImport(user))return this.radar.reply(job,user,'Сначала завершите открытую загрузку обычного портфеля. /cancel — отменить загрузку.');
   imp=await this.current(user);
   if(imp&&!(imp.status==='preview'&&imp.base_version===profile.version&&imp.last_edit_key===marker))return imp.status==='preview'?this.preview(job,user,imp):this.radar.reply(job,user,'Сначала завершите открытую загрузку скриншотов через /done.');
   source=profile.positions;
  }
  if(imp?.last_edit_key!==marker){
   const matches=portfolioProposals(source,pools).filter(p=>p.token===token);
   if(matches.length!==1)return imp?this.preview(job,user,imp):this.open(job,user);
   const rows=matches[0].rows.map(r=>({...r,captured_at:r.captured_at||profile?.updated_at||imp?.created_at}));
   if(imp)await this.db.patch('pr_lp_imports',{rows,last_edit_key:marker,updated_at:new Date().toISOString()},{id:'eq.'+imp.id,user_id:'eq.'+user,status:'eq.preview'});
   else imp=(await this.db.post('pr_lp_imports',{user_id:user,status:'preview',base_version:profile.version,rows,last_edit_key:marker}))[0];
  }
  await this.db.rpc('pr_lp_commit',{p_user:user,p_import:imp.id});await this.event(user,'saved',imp.id);
  return this.open(job,user);
 }
 async match(job,user){
  if(!await this.require(job,user))return;
  if(await this.radar.currentImport(user))return this.radar.reply(job,user,'Сначала сохраните или отмените загрузку обычного портфеля через /cancel.');
  let imp=await this.current(user);
  if(imp&&imp.status!=='preview')return this.radar.reply(job,user,'Сначала завершите загрузку LP-скриншотов через /done или отмените /cancel.');
  if(!imp){
   const p=await this.profile(user);if(!p?.positions?.length)return this.upload(job,user);
   imp=(await this.db.post('pr_lp_imports',{user_id:user,status:'preview',base_version:p.version,rows:p.positions.map(r=>normalizePosition({...r,captured_at:r.captured_at||p.updated_at}))}))[0];
  }
  return this.preview(job,user,imp);
 }
 async chooseBody(user,id,ref,access=null){
  access ||=await this.radar.billing.access(user);if(!lpPaid(access))return this.body(user,'home',0,access);
  const imp=(await this.db.get('pr_lp_imports',{id:'eq.'+id,user_id:'eq.'+user,status:'eq.preview',limit:1}))[0];if(!imp)return null;
  const view=candidatesView(imp,(await this.markets()).flatMap(m=>m.data?.pools||[]),ref);if(!view)return null;
  return {chat_id:user,text:view.text,parse_mode:'HTML',reply_markup:{inline_keyboard:view.keyboard},link_preview_options:{is_disabled:true}};
 }
 async choose(job,user,imp,ref){
  const body=await this.chooseBody(user,imp.id,ref);if(!body)return;
  await this.db.post('pr_outbox',{dedup_key:`${job.id}:lp_candidates:${imp.id}:${ref}`,user_id:user,body:{...body,_portfolius:{lp_candidates:imp.id,candidate_ref:ref}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
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
  return this.radar.reply(job,user,'📸 <b>Покажите ваши пулы xStocks / USDC</b>\n\nПришлите до 8 скриншотов, где видны актив, сумма и комиссия пула. Если попадает название площадки — отлично. Подходящие пулы и адреса предложим сами.\n\nВы проверите короткий список и подтвердите его. Затем покажем, где доходность выше и сколько это может дать на вашу сумму. Новый список заменит предыдущие LP-позиции.\n\n<i>Личные данные и адрес кошелька можно закрыть. Скриншоты передаются в OpenAI для распознавания. Подключать кошелёк не нужно.</i>',[[{text:'Распознать LP-позиции',callback_data:'lp:done:'+imp.id}],[{text:'Отменить',callback_data:'lp:cancel:'+imp.id}]]);
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
 async previewBody(user,id,page=0,access=null,manual=false){
  access ||=await this.radar.billing.access(user);if(!lpPaid(access))return this.body(user,'home',0,access);
  const imp=(await this.db.get('pr_lp_imports',{id:'eq.'+id,user_id:'eq.'+user,status:'eq.preview',limit:1}))[0];if(!imp)return null;
  const markets=await this.markets(),all=markets.flatMap(m=>m.data?.pools||[]),view=previewText(imp,all,page,manual),keyboard=manual?matchingButtons(imp,all,view.page):[];
  if(!manual)for(const p of view.proposals||[])keyboard.push([{text:view.proposals.length===1?'✅ Да, это мои пулы · сохранить':`✅ ${p.platform} · ${p.network} — сохранить`,callback_data:`lp:accept:${id}:${p.token}`}]);
  const route=manual?'options':'preview';
  if(view.pages>1)keyboard.push([...(view.page>0?[{text:'←',callback_data:`lp:${route}:${id}:${view.page-1}`}]:[]),...(view.page+1<view.pages?[{text:'→',callback_data:`lp:${route}:${id}:${view.page+1}`}]:[])]);
  if(manual||!view.proposals?.length)keyboard.push([{text:'✅ Сохранить список',callback_data:'lp:save:'+id}]);
  keyboard.push([{text:manual?'← Короткий список':'Изменить / другие варианты',callback_data:`lp:${manual?'preview':'options'}:${id}:0`}],[{text:'Отменить',callback_data:'lp:cancel:'+id}]);
  return {chat_id:user,text:view.text,parse_mode:'HTML',reply_markup:{inline_keyboard:keyboard},link_preview_options:{is_disabled:true}};
 }
 async preview(job,user,imp,page=0,manual=false){
  const body=await this.previewBody(user,imp.id,page,null,manual);if(!body)return;
  await this.db.post('pr_outbox',{dedup_key:`${job.id}:lp_preview:${imp.id}:${page}:${manual}`,user_id:user,body:{...body,_portfolius:{lp_preview:imp.id,page,manual}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
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
  const normalized=next.map(r=>({...normalizePosition({...r,captured_at:r.captured_at||profile?.updated_at||imp?.created_at}),symbol:r.symbol?canonicalXStock(r.symbol):null}));
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
   imp.rows=parsed.positions.map(r=>({...r,captured_at:imp.created_at,symbol:r.symbol?canonicalXStock(r.symbol):null}));imp.warnings=parsed.warnings;
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
  if(guard.lp_candidates)return this.chooseBody(row.user_id,guard.lp_candidates,guard.candidate_ref,access);
  if(guard.lp_preview)return this.previewBody(row.user_id,guard.lp_preview,guard.page,access,!!guard.manual);
  if(guard.automatic){
   const [u,p]=await Promise.all([this.db.get('pr_users',{chat_id:'eq.'+row.user_id,limit:1}),this.profile(row.user_id)]);
   if(!lpPaid(access)||!u[0]?.subscribed||!p?.enabled||guard.version!==p.version)return null;
   if(guard.lp_kind==='alert'){
    const pools=(await this.markets()).flatMap(m=>m.data?.pools||[]);
    const relevant=guard.lp_offer?p.positions.filter((r,i)=>i===guard.lp_offer.index):p.positions.slice((guard.page||0)*2,(guard.page||0)*2+2);
    if(!relevant.some(r=>{const o=opportunity(r,pools);return actionable(o)&&(!guard.lp_offer||o.best.key===guard.lp_offer.best_key);} ))return null;
   }
  }
  const body=await this.body(row.user_id,guard.section,guard.page,access);
  if(guard.lp_kind==='alert')body.text='🔔 <b>Появилась устойчивая возможность увеличить доход от комиссий</b>\nДва свежих замера: от +5 п.п. и от $1 за 30 дней на вашу сумму.\n\n'+body.text;
  return body;
 }
 async automatic(user,key,kind,profile,page=0,offer=null){
  // Body is re-rendered with current entitlement, subscription and LP version
  // immediately before delivery. No stale paid content survives expiration.
  const section=kind==='alert'?'positions':'home',body=await this.body(user,section,page);
  await this.db.post('pr_outbox',{dedup_key:key,user_id:user,body:{...body,_portfolius:{pools:true,section,page,automatic:true,version:profile.version,lp_kind:kind,lp_offer:offer}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
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
      const rows=profile.positions.filter(p=>p.symbol===symbol),newPools=latest.pools||[];
      const currentMarkets=markets.filter(m=>m.symbol!==symbol).concat({symbol,data:latest});
      if(profile.positions.every(p=>currentMarkets.some(m=>m.symbol===p.symbol&&m.data.asset&&Date.now()-Date.parse(m.data.checked_at)<4*HOUR)))await this.automatic(user,`lp:first:${user}:${profile.version}`,'first',profile);
      const stable=rows.find(r=>stableOpportunity(r,previous,latest));
      if(stable&&(!profile.last_alert_at||Date.now()-Date.parse(profile.last_alert_at)>24*HOUR)){
       const index=profile.positions.indexOf(stable),page=Math.floor(index/2),day=new Date().toISOString().slice(0,10),best=opportunity(stable,newPools).best;
       await this.automatic(user,`lp:alert:${user}:${day}`,'alert',profile,page,{index,best_key:best.key});
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
