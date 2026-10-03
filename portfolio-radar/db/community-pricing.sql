-- Community pricing: all functions remain service-role-only, SECURITY INVOKER.
-- Activate only after both runtimes and the isolated bank adapter are deployed.
alter table public.pr_billing_settings add column if not exists community_pricing_enabled boolean not null default false;
alter table public.pr_tbank_orders add column if not exists membership_checked_at timestamptz;
alter table public.pr_tbank_orders add column if not exists community_chat_ids bigint[] not null default '{}';
alter table public.pr_tbank_orders drop constraint pr_tbank_orders_amount_kopecks_check;
alter table public.pr_tbank_orders add constraint pr_tbank_orders_amount_kopecks_check check(amount_kopecks in (14500,29000));
alter table public.pr_tbank_orders drop constraint pr_tbank_orders_refunded_kopecks_check;
alter table public.pr_tbank_orders add constraint pr_tbank_orders_refunded_kopecks_check check(refunded_kopecks between 0 and amount_kopecks);
alter table public.pr_tbank_subscriptions drop constraint pr_tbank_subscriptions_amount_kopecks_check;
alter table public.pr_tbank_subscriptions add constraint pr_tbank_subscriptions_amount_kopecks_check check(amount_kopecks in (14500,29000));
alter table public.pr_tbank_subscriptions drop constraint pr_tbank_subscriptions_consent_version_check;
alter table public.pr_tbank_subscriptions add constraint pr_tbank_subscriptions_consent_version_check check(consent_version in ('rub-weekly-v1','rub-weekly-community-v2'));

CREATE OR REPLACE FUNCTION public.pr_config() RETURNS jsonb LANGUAGE sql SET search_path TO '' AS $function$
 select portfolio_private.read_config() || jsonb_build_object('community_pricing_enabled',(select community_pricing_enabled from public.pr_billing_settings where id=1));
$function$;
CREATE OR REPLACE FUNCTION public.pr_access(p_user bigint, p_start_trial boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.pr_billing_settings; c public.pr_customers; paid timestamptz; tier text; lim integer;
begin
 select * into s from public.pr_billing_settings where id=1;
 select * into c from public.pr_customers where user_id=p_user for update;
 if not found then raise exception 'customer_missing';end if;
 select max(period_until) into paid from public.pr_tbank_orders where user_id=p_user and confirmed_at is not null and refunded_kopecks<amount_kopecks;
 if s.freemium_enabled and p_start_trial and c.trial_started_at is null and paid is null then
  update public.pr_customers set trial_started_at=now(),trial_expires_at=now()+interval '72 hours' where user_id=p_user returning * into c;
 end if;
 tier:=case when not s.freemium_enabled then 'test' when paid>now() then 'paid'
  when c.trial_expires_at>now() then 'trial' when c.trial_started_at is null and paid is null then 'pending' else 'free' end;
 lim:=case when tier='free' then s.free_asset_limit else s.asset_limit end;
 return jsonb_build_object('freemium',s.freemium_enabled,'enabled',s.tbank_enabled,'checkout_enabled',s.tbank_enabled,
  'allowed',true,'tier',tier,'paid_until',paid,'trial_until',c.trial_expires_at,'trial_days',3,
  'price_stars',s.price_stars,'price_week_rub',s.price_week_rub,'asset_limit',lim,
  'full_asset_limit',s.asset_limit,'free_asset_limit',s.free_asset_limit,'manual_daily',0);
end $function$
;
CREATE OR REPLACE FUNCTION public.pr_tbank_begin(p_user bigint, p_consent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders; cfg public.pr_billing_settings;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found then raise exception 'customer_missing';end if;
 select * into cfg from public.pr_billing_settings where id=1;
 if cfg.community_pricing_enabled then raise exception 'community_consent_required';end if;
 if not cfg.tbank_enabled or p_consent is distinct from 'rub-weekly-v1' then raise exception 'billing_disabled';end if;
 if exists(select 1 from public.pr_tbank_orders where user_id=p_user and period_until>now() and refunded_kopecks<amount_kopecks) then raise exception 'subscription_active';end if;
 select x.* into o from public.pr_tbank_orders x join public.pr_tbank_subscriptions y on y.id=x.subscription_id
 where x.user_id=p_user and x.cycle=0 and x.expires_at>now() and x.provider_status in ('CREATED','NEW','FORM_SHOWED','AUTHORIZING','AUTHORIZED') and y.renew_enabled order by x.created_at desc limit 1;
 if found then return to_jsonb(o);end if;
 update public.pr_tbank_subscriptions set renew_enabled=false,status='cancelled',cancelled_at=now() where user_id=p_user and status='pending';
 insert into public.pr_tbank_subscriptions(user_id,consent_version) values(p_user,p_consent) returning * into s;
 insert into public.pr_tbank_orders(subscription_id,user_id,cycle,referral_pct,hold_days) values(s.id,p_user,0,cfg.referral_pct,cfg.hold_days) returning * into o;
 return to_jsonb(o);
end $function$
;
CREATE OR REPLACE FUNCTION public.pr_tbank_event(p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders; st text:=p_body->>'Status'; amount integer;
 expiry timestamptz; baseline timestamptz; partner bigint; result text; rebill text:=p_body->>'RebillId';
begin
 select x.* into s from public.pr_tbank_subscriptions x join public.pr_tbank_orders y on y.subscription_id=x.id where y.id=p_body->>'OrderId' for update of x;
 select * into o from public.pr_tbank_orders where id=p_body->>'OrderId' for update;
 if not found then raise exception 'unknown_order';end if;
 if o.payment_id is distinct from p_body->>'PaymentId' then raise exception 'payment_mismatch';end if;
 amount:=(p_body->>'Amount')::integer;
 if st not in ('REFUNDED','PARTIAL_REFUNDED') and amount is distinct from o.amount_kopecks then raise exception 'amount_mismatch';end if;
 if rebill ~ '^[0-9]{1,30}$' and rebill<>'0' and o.cycle=0 and st in ('AUTHORIZED','CONFIRMED') and p_body->>'Success'='true' then
  insert into portfolio_private.pr_rebill(subscription_id,rebill_id) values(s.id,rebill) on conflict(subscription_id) do update set rebill_id=excluded.rebill_id,updated_at=now();
 end if;
 if st in ('REFUNDED','PARTIAL_REFUNDED') and p_body->>'Success'='true' then
  if st='PARTIAL_REFUNDED' and (amount is null or amount<0 or amount>o.amount_kopecks) then raise exception 'refund_amount_invalid';end if;
  update public.pr_tbank_orders set provider_status=st,refunded_kopecks=greatest(refunded_kopecks,case when st='REFUNDED' then amount_kopecks else amount_kopecks-amount end) where id=o.id returning * into o;
  update public.pr_rub_referrals set amount_kopecks=floor((o.amount_kopecks-o.refunded_kopecks)*o.referral_pct/100) where order_id=o.id;
  update public.pr_tbank_subscriptions set renew_enabled=false,cancelled_at=coalesce(cancelled_at,now()),status='cancelled' where id=s.id;
  result:='refund';
 elsif st='CONFIRMED' and p_body->>'Success'='true' then
  if o.confirmed_at is not null or o.refunded_kopecks>0 then return jsonb_build_object('duplicate',true);end if;
  -- Trial days are preserved when a customer purchases their first week early.
  select greatest(now(),c.trial_expires_at,(select max(period_until) from public.pr_tbank_orders where user_id=o.user_id and confirmed_at is not null and refunded_kopecks<amount_kopecks)) into baseline from public.pr_customers c where c.user_id=o.user_id;
  expiry:=baseline+interval '168 hours';
  update public.pr_tbank_orders set provider_status='CONFIRMED',confirmed_at=now(),period_from=baseline,period_until=expiry,last_error=null where id=o.id;
  update public.pr_tbank_subscriptions set status=case when renew_enabled then 'active' else 'cancelled' end,next_charge_at=expiry where id=s.id;
  select referrer_id into partner from public.pr_customers where user_id=o.user_id;
  if partner is not null then
   insert into public.pr_rub_referrals(order_id,partner_id,referred_id,amount_kopecks,original_kopecks,available_at)
   values(o.id,partner,o.user_id,floor(o.amount_kopecks*o.referral_pct/100),floor(o.amount_kopecks*o.referral_pct/100),now()+make_interval(days=>o.hold_days)) on conflict do nothing;
  end if;
  result:='paid';
 elsif o.confirmed_at is null and o.refunded_kopecks=0 then
  if o.provider_status not in ('REJECTED','CANCELED','DEADLINE_EXPIRED','REFUNDED','PARTIAL_REFUNDED') then
   update public.pr_tbank_orders set provider_status=st,check_at=now()+interval '5 minutes' where id=o.id;
  end if;
  if st in ('REJECTED','CANCELED','DEADLINE_EXPIRED') then
   update public.pr_tbank_subscriptions set renew_enabled=false,status='past_due' where id=s.id and status<>'cancelled';
   result:='failed';
  end if;
 end if;
 if result is not null and exists(select 1 from public.pr_users where chat_id=o.user_id) then
  insert into public.pr_outbox(dedup_key,user_id,body) values('tbank:'||o.id||':'||result,o.user_id,jsonb_build_object('chat_id',o.user_id,'parse_mode','HTML','text',
   case result when 'paid' then '✅ <b>Оплата '||(o.amount_kopecks/100)::text||' ₽ подтверждена</b>'||E'\n\nПолный доступ до '||to_char(expiry at time zone 'Europe/Moscow','DD.MM.YYYY HH24:MI')||E' МСК.\nСледующее продление — через 7 дней после начала оплаченной недели. /subscribe — статус, /unsubscribe — отключить автосписания.'
   when 'refund' then E'↩️ <b>Возврат учтён</b>\nАвтопродление отключено. /subscribe — статус доступа. /paysupport — помощь.'
   else E'Не удалось продлить подписку.\nПосле окончания оплаченного доступа сводка продолжится по трём активам. /subscribe — подключить снова.' end)) on conflict(dedup_key) do nothing;
 end if;
 return jsonb_build_object('result',result,'period_until',expiry);
end $function$
;
CREATE OR REPLACE FUNCTION public.pr_product_metrics()
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
 with first_pay as (
  select user_id,min(confirmed_at) as first_at,count(*) as paid_weeks
  from public.pr_tbank_orders where confirmed_at is not null and refunded_kopecks<amount_kopecks group by user_id
 ), cohorts as (
  select count(*) as mature,count(*) filter(where paid_weeks>1) as renewed
  from first_pay where first_at between now()-interval '30 days' and now()-interval '7 days'
 )
 select jsonb_build_object(
  'period_days',30,
  'upload_users',(select count(distinct user_id) from public.pr_product_events where event='upload_started' and created_at>now()-interval '30 days'),
  'preview_users',(select count(distinct user_id) from public.pr_product_events where event='import_preview' and created_at>now()-interval '30 days'),
  'initial_ready_users',(select count(*) from public.pr_initial_reports where state='ready' and created_at>now()-interval '30 days'),
  'initial_delivered_users',(select count(distinct user_id) from public.pr_product_events where event='initial_delivered' and created_at>now()-interval '30 days'),
  'initial_cached_assets',(select coalesce(sum(cached_assets),0) from public.pr_initial_reports where created_at>now()-interval '30 days'),
  'initial_total_assets',(select coalesce(sum(asset_count),0) from public.pr_initial_reports where created_at>now()-interval '30 days'),
  'new_users',(select count(*) from public.pr_customers where first_seen_at>now()-interval '30 days'),
  'saved_users',(select count(distinct user_id) from public.pr_product_events where event='saved' and created_at>now()-interval '30 days'),
  'delivered_users',(select count(distinct user_id) from public.pr_product_events where event in ('report_delivered','initial_delivered') and created_at>now()-interval '30 days'),
  'opened_users',(select count(distinct user_id) from public.pr_product_events where event='report_open' and created_at>now()-interval '30 days'),
  'new_payers',(select count(*) from first_pay where first_at>now()-interval '30 days'),
  'renewal_cohort',(select mature from cohorts),'renewed_users',(select renewed from cohorts),
  'active_paid',(select count(distinct user_id) from public.pr_tbank_orders where confirmed_at is not null and refunded_kopecks<amount_kopecks and period_until>now()),
  'net_receipts_rub',(select coalesce(sum(amount_kopecks-refunded_kopecks),0)/100.0 from public.pr_tbank_orders where confirmed_at>now()-interval '30 days'),
  'ai_estimated_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where created_at>now()-interval '30 days'),
  'ai_shared_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where user_id is null and created_at>now()-interval '30 days'),
  'ai_direct_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where user_id is not null and created_at>now()-interval '30 days'),
  'api_cost_per_served_user_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where created_at>now()-interval '30 days')/nullif((select count(distinct user_id) from public.pr_product_events where event in ('report_delivered','initial_delivered') and created_at>now()-interval '30 days'),0),
  'qa_requests',(select count(*) from public.pr_qa_requests where created_at>now()-interval '30 days'),
  'failed_deliveries',(select count(*) from public.pr_outbox where state in ('failed','uncertain') and created_at>now()-interval '7 days')
 );
$function$
;
CREATE OR REPLACE FUNCTION public.pr_insights_maintenance()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare n integer;
begin
 delete from public.pr_reports where created_at<now()-interval '90 days';
 delete from public.pr_qa_requests where created_at<now()-interval '30 days';
 delete from public.pr_ui_sessions where expires_at<now();
 delete from public.pr_product_events where created_at<now()-interval '180 days';
 with eligible as (
  select u.chat_id,c.trial_expires_at,
   case when c.trial_expires_at>now() then 'trial_ending' else 'trial_ended' end as notice
  from public.pr_users u join public.pr_customers c on c.user_id=u.chat_id
  where u.subscribed and c.trial_expires_at between now()-interval '24 hours' and now()+interval '24 hours'
   and not exists(select 1 from public.pr_tbank_orders o where o.user_id=u.chat_id and o.confirmed_at is not null and o.refunded_kopecks<o.amount_kopecks and o.period_until>now())
 ), inserted as (
  insert into public.pr_outbox(dedup_key,user_id,body)
  select 'lifecycle:'||chat_id||':'||notice||':'||extract(epoch from trial_expires_at),chat_id,
   jsonb_build_object('chat_id',chat_id,'parse_mode','HTML','text',case when notice='trial_ending' then
    '🎁 <b>Пробный доступ скоро закончится</b>'||E'\n\n'||'Полный портфель открыт до '||to_char(trial_expires_at at time zone 'Europe/Moscow','DD.MM HH24:MI')||' МСК. Затем ежедневная сводка продолжится по первым трём активам. Весь портфель и аналитика — 290 ₽ каждые 7 дней; участникам Стратегии или Take Profit — 145 ₽.'
    else '🎁 <b>Пробный период завершён</b>'||E'\n\n'||'Портфель сохранён. Бесплатная сводка продолжится по первым трём активам. Полный обзор, итоги недели и аналитика всего портфеля — 290 ₽ каждые 7 дней; участникам Стратегии или Take Profit — 145 ₽.' end,
    'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','💎 Открыть весь портфель','callback_data','billing:upgrade')))),
    '_portfolius',jsonb_build_object('notice',notice))
  from eligible on conflict(dedup_key) do nothing returning id
 ) select count(*) into n from inserted;
 return n;
end $function$
;
CREATE OR REPLACE FUNCTION public.pr_tbank_claim(p_order text, p_step text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders; token text;
begin
 select x.* into s from public.pr_tbank_subscriptions x join public.pr_tbank_orders y on y.subscription_id=x.id where y.id=p_order for update of x;
 select * into o from public.pr_tbank_orders where id=p_order for update;
 if not found or not s.renew_enabled or s.cancelled_at is not null or o.expires_at<=now() or o.confirmed_at is not null
 or not (select tbank_enabled from public.pr_billing_settings where id=1) then return null;end if;
 if (select community_pricing_enabled from public.pr_billing_settings where id=1) and
 (o.membership_checked_at is null or o.membership_checked_at<now()-interval '2 minutes') then return null;end if;
 if p_step='init' and o.init_started_at is null then
  update public.pr_tbank_orders set init_started_at=now(),check_at=now()+interval '2 minutes' where id=o.id;
 elsif p_step='charge' and o.cycle>0 and o.payment_id is not null and o.charge_started_at is null and s.next_charge_at<=now() and s.status='active' then
  select rebill_id into token from portfolio_private.pr_rebill where subscription_id=s.id;
  if token is null then return null;end if;
  update public.pr_tbank_orders set charge_started_at=now(),check_at=now()+interval '2 minutes' where id=o.id;
 else return null;
 end if;
 return to_jsonb(o)||jsonb_build_object('rebill_id',token);
end $function$
;

CREATE OR REPLACE FUNCTION public.pr_tbank_price(p_order text,p_eligible boolean,p_checked_at timestamptz,p_chat_ids bigint[])
RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
declare o public.pr_tbank_orders; amount integer;
begin
 if p_eligible is null or p_checked_at is null or p_checked_at<now()-interval '90 seconds' or p_checked_at>now()+interval '30 seconds'
 or p_chat_ids is null or not p_chat_ids <@ array[-1002230180865,-1002094215821]::bigint[]
 or p_eligible is distinct from (cardinality(p_chat_ids)>0) then raise exception 'membership_unavailable';end if;
 perform 1 from public.pr_tbank_subscriptions s join public.pr_tbank_orders x on x.subscription_id=s.id where x.id=p_order for update of s;
 select * into o from public.pr_tbank_orders where id=p_order for update;
 if not found or o.confirmed_at is not null or o.charge_started_at is not null then return null;end if;
 amount:=case when p_eligible then 14500 else 29000 end;
 if o.amount_kopecks<>amount and (o.init_started_at is not null or o.cycle=0) then return jsonb_build_object('price_changed',true);end if;
 update public.pr_tbank_orders set amount_kopecks=amount,membership_checked_at=p_checked_at,community_chat_ids=p_chat_ids,
  last_error=case when last_error in ('membership_unavailable','membership_price_changed') then null else last_error end
 where id=o.id returning * into o;
 update public.pr_tbank_subscriptions set amount_kopecks=amount where id=o.subscription_id;
 return to_jsonb(o);
end $function$;

CREATE OR REPLACE FUNCTION public.pr_tbank_begin_community(p_user bigint,p_consent text,p_eligible boolean,p_checked_at timestamptz,p_chat_ids bigint[])
RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders; cfg public.pr_billing_settings; amount integer;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found then raise exception 'customer_missing';end if;
 select * into cfg from public.pr_billing_settings where id=1;
 if not cfg.tbank_enabled or not cfg.community_pricing_enabled or p_consent is distinct from 'rub-weekly-community-v2' then raise exception 'billing_disabled';end if;
 if p_eligible is null or p_checked_at is null or p_checked_at<now()-interval '90 seconds' or p_checked_at>now()+interval '30 seconds'
 or p_chat_ids is null or not p_chat_ids <@ array[-1002230180865,-1002094215821]::bigint[]
 or p_eligible is distinct from (cardinality(p_chat_ids)>0) then raise exception 'membership_unavailable';end if;
 amount:=case when p_eligible then 14500 else 29000 end;
 if exists(select 1 from public.pr_tbank_orders where user_id=p_user and confirmed_at is not null and period_until>now() and refunded_kopecks<amount_kopecks) then raise exception 'subscription_active';end if;
 select x.* into o from public.pr_tbank_orders x join public.pr_tbank_subscriptions y on y.id=x.subscription_id
 where x.user_id=p_user and x.cycle=0 and x.expires_at>now() and x.provider_status in ('CREATED','NEW','FORM_SHOWED','AUTHORIZING','AUTHORIZED') and y.renew_enabled order by x.created_at desc limit 1;
 if found then
  if o.amount_kopecks<>amount then raise exception 'membership_price_changed';end if;
  perform public.pr_tbank_price(o.id,p_eligible,p_checked_at,p_chat_ids);
  return to_jsonb(o);
 end if;
 update public.pr_tbank_subscriptions set renew_enabled=false,status='cancelled',cancelled_at=now() where user_id=p_user and status='pending';
 insert into public.pr_tbank_subscriptions(user_id,consent_version,amount_kopecks) values(p_user,p_consent,amount) returning * into s;
 insert into public.pr_tbank_orders(subscription_id,user_id,cycle,referral_pct,hold_days,amount_kopecks,membership_checked_at,community_chat_ids)
 values(s.id,p_user,0,cfg.referral_pct,cfg.hold_days,amount,p_checked_at,p_chat_ids) returning * into o;
 return to_jsonb(o);
end $function$;
revoke all on function public.pr_tbank_price(text,boolean,timestamptz,bigint[]) from public,anon,authenticated;
revoke all on function public.pr_tbank_begin_community(bigint,text,boolean,timestamptz,bigint[]) from public,anon,authenticated;
grant execute on function public.pr_tbank_price(text,boolean,timestamptz,bigint[]) to service_role;
grant execute on function public.pr_tbank_begin_community(bigint,text,boolean,timestamptz,bigint[]) to service_role;
