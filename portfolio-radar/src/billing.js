import {html,safeUrl} from './core.js';
export const PERIOD=30*24*3600;
export function invoiceId(payload){const m=String(payload||'').match(/^pr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);return m?.[1]||null;}
const date=s=>new Date(s).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'});
export class Billing{
 constructor(radar){this.radar=radar;this.db=radar.db;}
 async touch(user,ref=null){await this.db.rpc('pr_customer',{p_user:user,p_ref:ref});}
 async access(user,start=false){return this.db.rpc('pr_access',{p_user:user,p_start_trial:start});}
 async require(job,user){
  const a=await this.access(user,true);
  if(a.allowed)return a;
  await this.radar.reply(job,user,'🔐 <b>Нужна подписка</b>\n\nПортфель сохранён. Для новых сводок и распознавания откройте /subscribe.\n/portfolio — посмотреть позиции · /paysupport — помощь',null,'subscription_required');
  return null;
 }
 async menu(job,user,buy=false){
  const a=await this.access(user);
  if(!a.enabled)return this.radar.reply(job,user,'💎 <b>Подписка Portfolius</b>\n\nСейчас бот работает в тестовом доступе. Стоимость подписки ещё не установлена.\n\nПосле запуска: ежедневные новости и котировки, календарь событий, обновление портфеля скриншотами. Оплата каждые 30 дней с возможностью отключить продление.\n/referral — ваша ссылка для приглашений.');
  if(a.paid_until&&new Date(a.paid_until)>new Date())return this.radar.reply(job,user,`💎 <b>Подписка активна до ${date(a.paid_until)}</b>\n\nНовости и котировки до ${a.asset_limit} активов.\nАвтопродление можно отключить через /unsubscribe или в настройках Telegram. Доступ сохранится до конца оплаченного периода.\n/paysupport — вопросы по оплате`);
  if(!buy)return this.radar.reply(job,user,`💎 <b>Portfolius · ${a.price_stars} ⭐ / 30 дней</b>\n\n• До ${a.asset_limit} активов во всех счетах\n• Ежедневные новости, котировки и календарь\n• Один дополнительный обзор в сутки\n• Обновление скриншотами и исправления текстом\n\n${a.trial_until&&new Date(a.trial_until)>new Date()?'Пробный доступ до '+date(a.trial_until):a.trial_days?'Пробный доступ: '+a.trial_days+' дней с первого использования':'Пробный доступ завершён'}\n\nПодписка автоматически продлевается каждые 30 дней. Перед оплатой прочитайте /terms. Отключить продление: /unsubscribe.`,[[{text:'Продолжить к оплате',callback_data:'billing:buy'}]]);
  const i=await this.db.rpc('pr_create_invoice',{p_user:user});
  const url=await this.radar.telegram('createInvoiceLink',{title:'Portfolius · 30 дней',description:`Новости и котировки до ${i.asset_limit} активов. ${i.price_stars} Stars каждые 30 дней, с автопродлением. Отключение: /unsubscribe.`,payload:'pr:'+i.id,currency:'XTR',provider_token:'',subscription_period:PERIOD,prices:[{label:'Подписка на 30 дней',amount:i.price_stars}]});
  if(!safeUrl(url)||new URL(url).hostname!=='t.me')throw new Error('invalid_invoice_url');
  return this.radar.reply(job,user,`⭐ <b>${i.price_stars} Stars каждые 30 дней</b>\n\nTelegram покажет итоговые условия перед оплатой. Подписка начнётся после подтверждённого платежа.`,[[{text:'Оформить подписку',url}]],'invoice');
 }
 async checkout(query){
  let ok=false;const id=invoiceId(query.invoice_payload);
  if(id&&Number.isSafeInteger(query.from?.id)&&Number.isSafeInteger(query.total_amount))ok=await this.db.rpc('pr_checkout',{p_user:query.from.id,p_invoice:id,p_currency:query.currency,p_amount:query.total_amount,p_query:query.id});
  // Called synchronously from authenticated webhook, outside the research queue.
  await this.radar.telegram('answerPreCheckoutQuery',{pre_checkout_query_id:query.id,ok:!!ok,...(!ok?{error_message:'Счёт устарел или подписка уже активна. Откройте /subscribe и попробуйте снова.'}:{})});
 }
 async payment(job,user,message){
  const p=message.successful_payment||message.refunded_payment,id=invoiceId(p.invoice_payload);
  if(!id)throw new Error('invalid_payment_payload');
  const args={p_user:user,p_invoice:id,p_charge:p.telegram_payment_charge_id,p_currency:p.currency,p_amount:p.total_amount};
  if(message.refunded_payment){
   await this.db.rpc('pr_refund',args);
   return this.radar.reply(job,user,'↩️ <b>Возврат оплаты учтён</b>\nДоступ за возвращённый период отключён. Другие оплаченные периоды сохраняются. /subscribe — статус.',null,'refund');
  }
  const result=await this.db.rpc('pr_payment',{...args,p_expiry:p.subscription_expiration_date??null,p_paid:message.date,p_recurring:p.is_recurring===true,p_first:p.is_first_recurring===true});
  if(result.duplicate||result.refunded)return;
  return this.radar.reply(job,user,`✅ <b>${p.is_first_recurring?'Подписка оформлена':'Подписка продлена'}</b>\n\nДоступ до ${date(result.expires_at)}.\n/brief — обзор сейчас · /unsubscribe — отключить следующее продление`,null,'payment:'+p.telegram_payment_charge_id);
 }
 async cancel(user){
  const invoices=await this.db.get('pr_invoices',{user_id:'eq.'+user,status:'eq.paid',renewal_stopped:'eq.false'});
  for(const i of invoices){
   const p=await this.db.get('pr_payments',{invoice_id:'eq.'+i.id,expires_at:'gt.'+new Date().toISOString(),limit:1});
   if(!p.length)continue;
   await this.radar.telegram('editUserStarSubscription',{user_id:user,telegram_payment_charge_id:i.first_charge_id,is_canceled:true});
   await this.db.patch('pr_invoices',{renewal_stopped:true},{id:'eq.'+i.id,user_id:'eq.'+user});
  }
 }
 async cancelMenu(job,user,confirmed=false){
  if(!confirmed)return this.radar.reply(job,user,'Отключить автоматическое продление? Доступ останется до конца оплаченного периода.',[[{text:'Отключить продление',callback_data:'billing:cancel'}]]);
  await this.cancel(user);
  return this.radar.reply(job,user,'✅ Продление отключено для действующих подписок. Доступ сохранится до конца оплаченного срока.\n/subscribe — проверить статус.');
 }
 async referral(job,user){
  const stats=await this.db.rpc('pr_referral_stats',{p_user:user}),me=await this.radar.telegram('getMe',{});
  const url='https://t.me/'+me.username+'?start=ref_'+stats.code;
  return this.radar.reply(job,user,`🤝 <b>Приглашайте друзей</b>\n\n${html(url)}\n\nПартнёру — ${stats.share_pct}% от подтверждённой оплаты приглашённого, включая продления. Первый пригласивший закрепляется навсегда.\n\n<b>Ваш кабинет</b>\nПриглашено: ${stats.invited}\nНа удержании: ${stats.pending} ⭐\nДоступно к расчёту: ${stats.available} ⭐\nВыплачено: ${stats.paid} ⭐${Number(stats.adjustment)?'\nКорректировка за возвраты: −'+stats.adjustment+' ⭐':''}\n\nНачисления учитываются в эквиваленте Stars; автоматических переводов нет. Выплаты после проверки и удержания минимум 21 день. Возвраты отменяют начисления. /paysupport — запрос выплаты.`);
 }
 async terms(job,user){
  const a=await this.access(user);
  return this.radar.reply(job,user,`📋 <b>Условия подписки</b>\n\n${a.enabled?`${a.price_stars} Stars за 30 дней. До ${a.asset_limit} активов, ежедневная сводка и один дополнительный обзор в сутки.`:'Продажи ещё не открыты, стоимость будет показана перед оплатой.'}\n\nОплата через Telegram Stars. Автопродление каждые 30 дней. /unsubscribe отключает следующие списания; текущий оплаченный срок сохраняется. /pause останавливает только рассылку.\n\nДоступ к котировкам и новостям зависит от источников; отсутствие данных отмечается в сводке. Это информационный обзор, без обещания доходности.\n\n/paysupport — поддержка, вопросы о возврате и выплатах. /delete удаляет портфели и историю и отключает продление; необходимые записи об оплатах, возвратах и рефералах сохраняются для расчётов.`);
 }
 async support(job,user){return this.radar.reply(job,user,'💬 <b>Помощь с оплатой</b>\n\nНапишите <a href="https://t.me/romanovsv">@romanovsv</a>: опишите проблему и приложите квитанцию Telegram. Здесь же можно запросить возврат или расчёт партнёрского вознаграждения.\n\n/subscribe — статус · /unsubscribe — отключить продление');}
}
