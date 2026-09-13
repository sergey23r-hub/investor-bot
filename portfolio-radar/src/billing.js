import {html} from './core.js';
import {TBank} from './tbank.js';
import {upgradeOffer} from './freemium.js';
export const PERIOD=30*24*3600;
export function invoiceId(payload){const m=String(payload||'').match(/^pr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);return m?.[1]||null;}
const date=s=>new Date(s).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'});
export class Billing{
 constructor(radar){this.radar=radar;this.db=radar.db;this.bank=new TBank(radar);}
 async touch(user,ref=null){await this.db.rpc('pr_customer',{p_user:user,p_ref:ref});}
 async access(user,start=false){return this.db.rpc('pr_access',{p_user:user,p_start_trial:start});}
 async require(job,user){
  const a=await this.access(user,false);
  if(a.allowed)return a;
  await this.radar.reply(job,user,'🔐 <b>Нужна подписка</b>\n\nПортфель сохранён. Для новых сводок и распознавания откройте /subscribe.\n/portfolio — посмотреть позиции · /paysupport — помощь',null,'subscription_required');
  return null;
 }
 async menu(job,user,buy=false){
  const a=await this.access(user),offer=upgradeOffer(a);
  const sub=(await this.db.get('pr_tbank_subscriptions',{user_id:'eq.'+user,order:'created_at.desc',limit:1}))[0];
  if(a.tier==='paid')return this.radar.reply(job,user,`💎 <b>Полный портфель открыт</b>\n\nДоступ до ${date(a.paid_until)}.\n${sub?.renew_enabled?'Следующее списание — 290 ₽ в конце оплаченного периода.':'Автопродление отключено. После оплаченного периода останутся три актива.'}\n\n/unsubscribe — отключить автосписания\n/paysupport — помощь с оплатой`);
  const text=`💎 <b>Portfolius · 290 ₽ / неделю</b>\n\n• Новости и котировки всего портфеля\n• Календарь событий по вашим активам\n• Ежедневный обзор по расписанию\n\n${offer.text}\n\n<b>Условия оплаты</b>\nПервая неделя оплачивается сейчас. Оставшиеся бесплатные дни сохраняются. Далее — 290 ₽ каждые 7 дней с привязанной карты через Т‑Банк.\n\n/unsubscribe отключает следующие списания. Без оплаты остаются сводки по трём активам. /terms — полные условия.`;
  if(!a.checkout_enabled)return this.radar.reply(job,user,text+'\n\nОплата временно недоступна. /paysupport — помощь.');
  if(!buy)return this.radar.reply(job,user,text,[[{text:'Согласен: 290 ₽ каждые 7 дней',callback_data:'billing:buy'}]]);
  try{
   const order=await this.bank.checkout(user);
   if(!order?.payment_url)return this.radar.reply(job,user,'Проверяю статус счёта. Повторно оплачивать не нужно. /subscribe — статус, /paysupport — помощь.');
   return this.radar.reply(job,user,'💳 <b>Оплата на странице Т‑Банка</b>\n\n290 ₽ за первую неделю; затем автоматически каждые 7 дней. Оставшиеся пробные дни сохраняются. Для автопродления оплатите картой.\n\nДоступ откроется после подтверждения банка. Реквизиты карты вводятся только на странице банка. /unsubscribe — отменить продление.',[[{text:'Оплатить 290 ₽ через Т‑Банк',url:order.payment_url}]],'invoice');
  }catch(e){return this.radar.reply(job,user,e.message==='subscription_active'?'Подписка уже активна. /subscribe — статус.':'Т‑Банк пока не подтвердил создание счёта. Доступные данные сохранены. /paysupport — помощь с подключением оплаты.');}
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
  return this.radar.reply(job,user,`✅ <b>${p.is_first_recurring?'Подписка оформлена':'Подписка продлена'}</b>\n\nДоступ до ${date(result.expires_at)}.\nСводки будут приходить по расписанию.\n/time — время сводки · /unsubscribe — отключить следующее продление`,null,'payment:'+p.telegram_payment_charge_id);
 }
 async cancel(user){await this.db.rpc('pr_tbank_cancel',{p_user:user});}
 async cancelMenu(job,user,confirmed=false){
  if(!confirmed)return this.radar.reply(job,user,'Отключить автоматическое продление? Доступ останется до конца оплаченного периода.',[[{text:'Отключить продление',callback_data:'billing:cancel'}]]);
  await this.cancel(user);
  return this.radar.reply(job,user,'✅ Продление отключено для действующих подписок. Доступ сохранится до конца оплаченного срока.\n/subscribe — проверить статус.');
 }
 async referral(job,user){
  const stats=await this.db.rpc('pr_rub_referral_stats',{p_user:user}),me=await this.radar.telegram('getMe',{});
  const url='https://t.me/'+me.username+'?start=ref_'+stats.code;
  return this.radar.reply(job,user,`🤝 <b>Приглашайте друзей</b>\n\n${html(url)}\n\nПартнёру — ${stats.share_pct}% от подтверждённой оплаты приглашённого, включая продления. Первый пригласивший закрепляется навсегда.\n\n<b>Ваш кабинет</b>\nПриглашено: ${stats.invited}\nНа удержании: ${stats.pending} ₽\nДоступно к расчёту: ${stats.available} ₽\nВыплачено: ${stats.paid} ₽${Number(stats.adjustment)?'\nКорректировка за возвраты: −'+stats.adjustment+' ₽':''}\n\nНачисления учитываются в рублях; автоматических переводов нет. Выплаты после проверки и удержания минимум 21 день. Возвраты отменяют начисления. /paysupport — запрос выплаты.`);
 }
 async terms(job,user){
  return this.radar.reply(job,user,'📋 <b>Условия Portfolius</b>\n\n🎁 Первые 72 часа после сохранения первого портфеля — полный доступ бесплатно. Затем без подписки — новости, котировки и календарь до трёх первых активов. Все загруженные позиции сохраняются. В бесплатную сводку попадают первые три уникальных актива портфеля.\n\n💳 <b>290 ₽ каждые 7 дней через Т‑Банк</b>\nПервая неделя оплачивается при подключении. Неиспользованные пробные дни прибавляются к доступу. Следующие 290 ₽ списываются автоматически в конце оплаченного периода. Автосписания начинаются только после согласия с условиями и успешной оплаты картой.\n\n/unsubscribe отключает будущие списания; оплаченный доступ сохраняется. Если платёж уже отправлен в банк, его обработка может завершиться после отмены — /paysupport поможет с возвратом. /pause останавливает только рассылку. При неудачной оплате после окончания доступа остаются три актива.\n\nНовости и котировки обновляются по расписанию, один обзор в сутки. Ручного обновления нет. Доступность данных зависит от источников; обзор информационный и не обещает доходности.\n\n/delete удаляет портфели и отключает продление. Записи о пробном сроке, оплатах и рефералах сохраняются для расчётов и не дают начать пробный срок заново.\n/paysupport — поддержка и возвраты.');
 }
 async support(job,user){return this.radar.reply(job,user,'💬 <b>Помощь с оплатой</b>\n\nНапишите <a href="https://t.me/romanovsv">@romanovsv</a>: опишите проблему и приложите квитанцию Т‑Банка. Здесь же можно запросить возврат или расчёт партнёрского вознаграждения.\n\n/subscribe — статус · /unsubscribe — отключить продление');}
}
