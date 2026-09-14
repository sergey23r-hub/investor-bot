import {html,splitText} from './core.js';
import {entitledPortfolio,portfolioAssets,upgradeOffer} from './freemium.js';
import {newsDay} from './daily.js';
import {cachedMarket} from './first-look.js';
import {fullAccess,filterSnapshot,stories,storyId,reportPages,reportKeyboard,weeklySnapshot,dateLabel} from './report-format.js';
import {answerPortfolioQuestion} from './portfolio-qa.js';

const validId=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s||'');
const reportSections=new Set(['summary','assets','news','calendar','market','structure']);
export class Insights{
 constructor(radar){this.radar=radar;this.db=radar.db;}
 async event(user,event,key){
  try{await this.db.post('pr_product_events',{user_id:user,event,dedup_key:event+':'+key},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');}catch{console.error('product_metric_pending');}
 }
 async accounts(user){return this.db.get('pr_accounts',{user_id:'eq.'+user,order:'id.asc'});}
 async save(user,kind,serviceDay,snapshot){
  await this.db.post('pr_reports',{user_id:user,kind,service_day:serviceDay,snapshot},{on_conflict:'user_id,kind,service_day'},(kind==='first'?'resolution=merge-duplicates':'resolution=ignore-duplicates')+',return=minimal');
  let report=(await this.db.get('pr_reports',{user_id:'eq.'+user,kind:'eq.'+kind,service_day:'eq.'+serviceDay,limit:1}))[0];
  if(!report)throw new Error('report_save_failed');
  // A weekly preview opened before today's daily report must include that report
  // later. The conditional write prevents an older concurrent preview replacing it.
  if(kind==='weekly'&&snapshot.as_of>report.snapshot.as_of){
   await this.db.patch('pr_reports',{snapshot},{id:'eq.'+report.id,user_id:'eq.'+user,'snapshot->>as_of':'lt.'+snapshot.as_of});
   report=(await this.db.get('pr_reports',{id:'eq.'+report.id,user_id:'eq.'+user,limit:1}))[0];
   if(!report)throw new Error('report_save_failed');
  }
  return report;
 }
 async latest(user,kind='daily'){
  return (await this.db.get('pr_reports',{user_id:'eq.'+user,kind:'eq.'+kind,order:'service_day.desc',limit:1}))[0];
 }
 async current(user){
  const candidates=await Promise.all([this.latest(user),this.latest(user,'first')]);
  const time=r=>Date.parse(r?.snapshot?.as_of||r?.created_at||r?.service_day)||0;
  const portfolioTime=r=>Math.max(0,...(r?.snapshot?.accounts||[]).map(a=>Date.parse(a.updated_at)||0));
  return candidates.filter(Boolean).sort((a,b)=>portfolioTime(b)-portfolioTime(a)||time(b)-time(a))[0]||null;
 }
 async readable(user,reportId,access){
  if(!validId(reportId))return null;
  const r=(await this.db.get('pr_reports',{id:'eq.'+reportId,user_id:'eq.'+user,limit:1}))[0];
  if(!r)return null;
  if(!fullAccess(access)){
   const latest=await this.latest(user,r.kind);if(latest?.id!==r.id)return null;
   if(r.kind==='weekly'&&Date.now()-Date.parse(r.service_day)>8*86400000)return null;
  }
  return r;
 }
 async body(user,report,section='summary',page=0,access=null){
  access ||= await this.radar.billing.access(user);
  const current=access.tier==='free'?await this.accounts(user):null;
  const snapshot=filterSnapshot(report.snapshot,access,current);
  if(report.kind==='first')snapshot.initial_pending=(await this.db.get('pr_initial_reports',{user_id:'eq.'+user,limit:1}))[0]?.state==='queued';
  const pages=reportPages(report,snapshot,section,access);
  if(!Number.isInteger(page)||page<0||page>=pages.length)return null;
  const keyboard=snapshot.empty_portfolio?[[{text:'📸 Добавить позиции',callback_data:'ui:upload'},{text:'Главный экран',callback_data:'ui:home'}]]:reportKeyboard(report.id,section,access,page,pages.length);
  return {chat_id:user,text:pages[page],parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:keyboard}};
 }
 async sendReport(job,user,report,section='summary',page=0,{automatic=false}={}){
  const access=await this.radar.billing.access(user),body=await this.body(user,report,section,page,access);
  if(!body)return this.radar.reply(job,user,'Эта страница недоступна. /report — последний готовый обзор.');
  const dedup=automatic&&report.kind==='first'?`initial:${user}:summary`:`${job.id}:report:${report.id}:${section}:${page}`;
  await this.db.post('pr_outbox',{dedup_key:dedup,user_id:user,body:{...body,_portfolius:{report_id:report.id,section,page,automatic,kind:report.kind}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
 }
 async open(job,user,section='summary',id=null,page=0){
  if(!reportSections.has(section))return;
  const access=await this.radar.billing.access(user);
  let report=id?await this.readable(user,id,access):await this.current(user)||await this.afterSave(job,{chat_id:user},{announce:false});
  if(!id&&report?.kind==='first'&&!report.snapshot.empty_portfolio){
   const initial=(await this.db.get('pr_initial_reports',{user_id:'eq.'+user,limit:1}))[0];
   if(!initial){report=await this.afterSave(job,{chat_id:user},{announce:false})||report;await this.db.rpc('pr_initial_begin',{p_user:user});}
  }
  if(!report)return this.radar.reply(job,user,'Этот выпуск недоступен. /report — последний готовый обзор. Если портфель ещё не добавлен, пришлите его скриншоты. Архив прошлых выпусков открыт в подписке.',[[{text:'📸 Добавить портфель',callback_data:'ui:upload'},{text:'💎 Подписка',callback_data:'billing:upgrade'}]]);
  await this.event(user,'report_open',job.id+':'+report.id+':'+section);
  return this.sendReport(job,user,report,section,page);
 }
 async daily(job,user,all,view,quotes,news,market,facts={},fx=null){
  const serviceDay=newsDay(new Date(job.payload.news_as_of)),previous=await this.db.get('pr_reports',{user_id:'eq.'+user.chat_id,kind:'eq.daily',service_day:'lt.'+serviceDay,order:'service_day.desc',limit:7});
  const snapshot={accounts:view.accounts,quotes,news,market,facts,fx,as_of:new Date().toISOString(),total_assets:portfolioAssets(all).length,hidden:view.hidden,previous_story_ids:[...new Set(previous.flatMap(r=>stories(r.snapshot).map(storyId)))]};
  // Persist only the assets the current entitlement actually allowed.
  const access=await this.radar.billing.access(user.chat_id),filtered=filterSnapshot(snapshot,access,all);
  const report=await this.save(user.chat_id,'daily',serviceDay,filtered);
  await this.event(user.chat_id,'report_ready',report.id);
  await this.sendReport(job,user.chat_id,report,'summary',0,{automatic:true});
  const weekday=new Intl.DateTimeFormat('en-US',{timeZone:user.timezone||'Europe/Moscow',weekday:'short'}).format(new Date());
  if(weekday==='Sun')await this.week(job,user.chat_id,true);
 }
 async afterSave(job,user,{announce=true}={}){
  const accounts=await this.accounts(user.chat_id),access=await this.radar.billing.access(user.chat_id),view=entitledPortfolio(accounts,access),now=new Date();
  if(!accounts.some(a=>a.positions?.length)){
   if(!announce)return null;
   await this.save(user.chat_id,'first',newsDay(now),{accounts,quotes:{},news:{},facts:{},as_of:now.toISOString(),total_assets:0,hidden:0,empty_portfolio:true});
   await this.event(user.chat_id,'saved',job.id);
   return this.radar.reply(job,user.chat_id,'✅ <b>Портфель обновлён</b>\n\nВ сохранённых счетах больше нет позиций. Пришлите скриншоты, когда захотите добавить активы.',[[{text:'📸 Добавить позиции',callback_data:'ui:upload'}]],'passport');
  }
  const previous=await this.latest(user.chat_id),market=await cachedMarket(this.db,view.assets,now,previous?.snapshot);
  const snapshot={accounts:view.accounts,...market,as_of:now.toISOString(),total_assets:view.total,hidden:view.hidden,has_prior_daily:!!previous};
  const {news,quotes}=market;
  const report=await this.save(user.chat_id,'first',newsDay(now),snapshot);
  if(!announce)return report;
  const initial=await this.db.rpc('pr_initial_begin',{p_user:user.chat_id});
  const allPositions=accounts.flatMap(a=>a.positions),unresolved=allPositions.filter(p=>!p.verified).length,offer=upgradeOffer(access,{hidden:view.hidden});
  const text=`✅ <b>Портфель сохранён</b>\n\nСчетов: ${accounts.length} · Позиций: ${allPositions.length}\nАктивов для обзора: ${view.assets.length}${unresolved?'\nНужно уточнить: '+unresolved+' — /edit':''}\n\nЕжедневная сводка — в <b>${html(user.digest_time.slice(0,5))}</b> (${html(user.timezone)}).\n${initial?.state==='queued'?'Готовим первый обзор — он придёт отдельным сообщением.':Object.keys(news).length||Object.keys(quotes).length?'Готовые данные уже доступны в обзоре ниже.':'Рыночные данные появятся в выпуске по расписанию. Состав портфеля уже доступен.'}\n\n${offer.text}`;
  await this.radar.reply(job,user.chat_id,text,[[{text:'📊 Готовый обзор',callback_data:'report:summary:'+report.id+':0'},{text:'🧩 Структура',callback_data:'report:structure:'+report.id+':0'}],...(offer.keyboard||[])],'passport');
  await this.event(user.chat_id,'saved',job.id);
 }
 async week(job,user,automatic=false){
  const from=newsDay(new Date(Date.now()-6*86400000)),reports=await this.db.get('pr_reports',{user_id:'eq.'+user,kind:'eq.daily',service_day:'gte.'+from,order:'service_day.asc',limit:7});
  if(!reports.length){if(!automatic)return this.radar.reply(job,user,'Для итогов недели нужен хотя бы один сохранённый дневной выпуск. Отчёт появится после первой сводки.');return;}
  const snapshot=weeklySnapshot(reports),report=await this.save(user,'weekly',newsDay(),snapshot);
  return this.sendReport(job,user,report,'summary',0,{automatic});
 }
 async initialAllowed(job){
  if(job.job_key!=='initial:'+job.user_id)return false;
  return !!(await this.db.get('pr_initial_reports',{user_id:'eq.'+job.user_id,job_id:'eq.'+job.id,state:'eq.queued',limit:1}))[0];
 }
 async finishInitial(job,user,quotes,news,market,facts,fx){
  const accounts=await this.accounts(user.chat_id),access=await this.radar.billing.access(user.chat_id),view=entitledPortfolio(accounts,access),now=new Date();
  if(!accounts.some(a=>a.positions?.length)){
   await this.db.patch('pr_initial_reports',{state:'failed',finished_at:now.toISOString()},{user_id:'eq.'+user.chat_id,job_id:'eq.'+job.id});return;
  }
  const snapshot=filterSnapshot({accounts:view.accounts,quotes,news,market,facts,fx,as_of:now.toISOString(),total_assets:view.total,hidden:view.hidden,initial_ready:true,reused_market_as_of:job.payload.reused_market_as_of},access,accounts);
  const report=await this.save(user.chat_id,'first',newsDay(now),snapshot);
  await this.event(user.chat_id,'initial_ready',report.id);
  await this.sendReport(job,user.chat_id,report,'summary',0,{automatic:true});
  await this.db.patch('pr_initial_reports',{state:'ready',report_id:report.id,asset_count:view.assets.length,cached_assets:Math.min(view.assets.length,job.payload.initial_cached_assets||0),quote_count:Object.keys(snapshot.quotes).filter(k=>snapshot.quotes[k]?.status==='ok').length,news_count:Object.keys(snapshot.news).filter(k=>snapshot.news[k]?.status==='ok').length,finished_at:now.toISOString()},{user_id:'eq.'+user.chat_id,job_id:'eq.'+job.id});
 }
 async archive(job,user,offset=0){
  const access=await this.radar.billing.access(user);
  if(!fullAccess(access))return this.radar.reply(job,user,'🗂 <b>Архив обзоров</b>\n\nПоследний готовый обзор доступен через /report. История за 90 дней и сравнение недель открываются в подписке.',[[{text:'Последний обзор',callback_data:'insight:report'},{text:'💎 Открыть архив',callback_data:'billing:upgrade'}]]);
  if(!Number.isInteger(offset)||offset<0||offset>80)offset=0;
  const reports=await this.db.get('pr_reports',{user_id:'eq.'+user,kind:'eq.daily',order:'service_day.desc',limit:11,offset});
  const keyboard=reports.slice(0,10).map(r=>[{text:'📊 '+dateLabel(r.service_day),callback_data:'report:summary:'+r.id+':0'}]);
  if(reports.length>10)keyboard.push([{text:'Раньше →',callback_data:'insight:archive:'+(offset+10)}]);
  return this.radar.reply(job,user,'🗂 <b>Архив дневных обзоров</b>\n\n'+(reports.length?'Выберите дату. Показываю данные, сохранённые в тот день.':'Архив начнёт наполняться после первой ежедневной сводки.'),keyboard);
 }
 async ask(job,user,question=''){
  const access=await this.radar.billing.access(user);
  if(!fullAccess(access))return this.radar.reply(job,user,'💬 <b>Вопросы по портфелю</b>\n\nВ подписке — до трёх запросов в день по данным готового выпуска. /learn — бесплатная справка по терминам.',[[{text:'💎 Открыть вопросы',callback_data:'billing:upgrade'}]]);
  const report=await this.current(user)||await this.afterSave(job,{chat_id:user},{announce:false});
  if(!report||report.snapshot.empty_portfolio)return this.radar.reply(job,user,'Сначала сохраните портфель с позициями. Вопросы будут доступны по его готовым данным.');
  if(!question){
   await this.db.post('pr_ui_sessions',{user_id:user,mode:'ask',expires_at:new Date(Date.now()+5*60000).toISOString()},{on_conflict:'user_id'},'resolution=merge-duplicates,return=minimal');
   return this.radar.reply(job,user,'💬 <b>Что хотите узнать?</b>\n\nНапример: «Что означает ближайшая оферта?» или «Где в портфеле самая высокая концентрация?»\n\nНапишите вопрос следующим сообщением либо используйте /ask Вопрос. До 3 запросов в день, сброс в 00:00 МСК. Ответ строится ИИ по сохранённому выпуску; данные по вашему вопросу передаются в OpenAI.\n\n/cancel — выйти из режима вопроса.');
  }
  await this.clearQuestion(user);
  if(question.length>1000)return this.radar.reply(job,user,'Сократите вопрос до 1000 символов.');
  if(!this.radar.config.openai_key)return this.radar.reply(job,user,'Ответы на вопросы сейчас недоступны. Готовый обзор можно открыть через /report.');
  const requestKey='question:'+job.id,reservation=await this.db.rpc('pr_qa_reserve',{p_user:user,p_request:requestKey});
  if(!reservation.allowed){
   if(reservation.answer)return this.sendAnswer(job,user,reservation.answer);
   return this.radar.reply(job,user,reservation.reason==='limit'?'На сегодня использованы 3 запроса. Новые будут доступны после 00:00 МСК.':reservation.reason==='subscription'?'Вопросы доступны с полным доступом. /subscribe — подписка.':'Этот запрос уже обрабатывался. Повторный запрос к ИИ не отправляю; откройте /report для готовых данных.');
  }
  try{
   const snapshot=filterSnapshot(report.snapshot,access),answer=await answerPortfolioQuestion(question,snapshot,this.radar.config.openai_key,record=>this.radar.recordUsage(record,user));
   await this.db.patch('pr_qa_requests',{state:'completed',answer},{request_key:'eq.'+requestKey,user_id:'eq.'+user});
   await this.event(user,'qa_answer',requestKey);return this.sendAnswer(job,user,answer);
  }catch{
   await this.db.patch('pr_qa_requests',{state:'failed'},{request_key:'eq.'+requestKey,user_id:'eq.'+user});
   return this.radar.reply(job,user,'Не удалось подготовить ответ. Попытка учтена в дневном лимите; автоматический повтор отключён. /report — сохранённый обзор.');
  }
 }
 async sendAnswer(job,user,answer){
  for(const [i,text] of splitText('<b>💬 Portfolius отвечает</b>\n\n'+answer).entries())await this.db.post('pr_outbox',{dedup_key:job.id+':qa:'+i,user_id:user,body:{chat_id:user,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},_portfolius:{requires_full:true}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
 }
 async pendingQuestion(user){return (await this.db.get('pr_ui_sessions',{user_id:'eq.'+user,expires_at:'gt.'+new Date().toISOString(),limit:1}))[0];}
 async clearQuestion(user){await this.db.patch('pr_ui_sessions',{expires_at:new Date(0).toISOString()},{user_id:'eq.'+user});}
 async deliveryBody(row){
  const {_portfolius:guard,...body}=row.body;if(!guard)return body;
  if(body.chat_id!==row.user_id)return null;
  const access=await this.radar.billing.access(row.user_id);
  if(guard.notice){if(guard.notice==='trial_ending'&&access.tier!=='trial'||guard.notice==='trial_ended'&&access.tier!=='free')return null;return body;}
  if(guard.requires_full&&!fullAccess(access))return {...body,text:'Полный доступ закончился. Ответы по портфелю доступны в подписке. /subscribe — подключение.'};
  if(guard.report_id){
   const report=await this.readable(row.user_id,guard.report_id,access);if(!report)return null;
   return this.body(row.user_id,report,guard.section,guard.page,access);
  }
  return body;
 }
 async delivered(row){
  const g=row.body._portfolius;if(g?.report_id&&g.automatic)await this.event(row.user_id,g.kind==='weekly'?'weekly_delivered':g.kind==='first'?'initial_delivered':'report_delivered',g.report_id);
 }
 async maintenance(){return this.db.rpc('pr_insights_maintenance');}
 async admin(job,user){
  if(user!==Number(this.radar.env.PORTFOLIO_OWNER_CHAT||85572233))return this.radar.reply(job,user,'Эта команда доступна владельцу бота.');
  const m=await this.db.rpc('pr_product_metrics'),usd=n=>Number(n||0).toFixed(3);
  return this.radar.reply(job,user,`<b>📈 Portfolius · показатели за 30 дней</b>\n\nНовые пользователи: ${m.new_users}\nЗагрузили скриншоты: ${m.upload_users}\nУвидели предпросмотр: ${m.preview_users}\nСохранили портфель: ${m.saved_users}\nПервый обзор подготовлен: ${m.initial_ready_users}\nПолучили первый обзор: ${m.initial_delivered_users}\nПолучили любой обзор: ${m.delivered_users}\nОткрыли подробности: ${m.opened_users}\nВпервые оплатили: ${m.new_payers}\nАктивных платных: ${m.active_paid}\n\n<b>Первый опыт</b>\nАктивов с готовыми новостями и котировкой: ${m.initial_cached_assets} из ${m.initial_total_assets}.\n\n<b>Повторная оплата</b>\n${m.renewed_users} из ${m.renewal_cohort} пользователей, у которых прошло 7 дней с первой оплаты.\n\n<b>Деньги и API</b>\nПодтверждённые оплаты минус возвраты: ${m.net_receipts_rub} ₽\nОценка расходов ИИ: $${usd(m.ai_estimated_usd)}\nОбщие новости: $${usd(m.ai_shared_usd)}\nИндивидуальные запросы: $${usd(m.ai_direct_usd)}\nНа получателя обзоров в среднем: ${m.api_cost_per_served_user_usd===null?'пока нет данных':'$'+usd(m.api_cost_per_served_user_usd)}\n\nВопросов: ${m.qa_requests}\nПроблем с доставкой за 7 дней: ${m.failed_deliveries}\n\n<i>Доставка не означает прочтение. События использования считаются с версии 0.4, этапы первой загрузки — с 0.5; платежи и API — по имеющейся истории. Расходы ИИ оценочные, без комиссии банка, партнёрских выплат и инфраструктуры; это не расчёт прибыли.</i>`);
 }
 async learn(job,user){
  return this.radar.reply(job,user,'<b>📚 Коротко об инвестиционных событиях</b>\n\n<b>Купон</b> — процентная выплата по облигации. При плавающей ставке будущая сумма может быть неизвестна.\n\n<b>Оферта</b> — возможность или условие досрочного выкупа облигации. Порядок участия зависит от условий выпуска и брокера.\n\n<b>Амортизация</b> — возврат части номинала облигации. Это возврат капитала, а не купонный доход.\n\n<b>Дивидендная отсечка</b> — дата определения владельцев, имеющих право на выплату. Это не дата поступления денег; учитывайте срок расчётов при покупке.\n\n<b>Разблокировка токенов</b> — снятие ограничений на обращение части токенов. Увеличение доступного предложения не гарантирует падение цены.\n\n<b>Концентрация</b> — большая доля портфеля в одном активе, эмитенте или секторе. Связанные активы могут двигаться одновременно.',[[{text:'📊 Мой обзор',callback_data:'insight:report'},{text:'💬 Вопрос',callback_data:'insight:ask'}]]);
 }
}
