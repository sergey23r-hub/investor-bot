-- Apply before freemium.sql. Amounts are RUB kopecks, periods are 168 hours.
alter table public.pr_billing_settings add column tbank_enabled boolean not null default false;
create table public.pr_tbank_subscriptions (
 id uuid primary key default gen_random_uuid(), user_id bigint not null references public.pr_customers(user_id),
 amount_kopecks integer not null default 29000 check(amount_kopecks=29000),
 consent_version text not null check(consent_version='rub-weekly-v1'), consented_at timestamptz not null default now(),
 renew_enabled boolean not null default true, cancelled_at timestamptz,
 status text not null default 'pending' check(status in ('pending','active','cancelled','past_due')),
 next_charge_at timestamptz, created_at timestamptz not null default now()
);
create index pr_tbank_subscriptions_user on public.pr_tbank_subscriptions(user_id);
create index pr_tbank_subscriptions_due on public.pr_tbank_subscriptions(next_charge_at) where renew_enabled and status='active';
create table public.pr_tbank_orders (
 id text primary key default 'pr_'||replace(gen_random_uuid()::text,'-','') check(id ~ '^pr_[a-f0-9]{32}$'),
 subscription_id uuid not null references public.pr_tbank_subscriptions(id), user_id bigint not null references public.pr_customers(user_id),
 cycle integer not null check(cycle>=0), amount_kopecks integer not null default 29000 check(amount_kopecks=29000),
 payment_id text unique, payment_url text, provider_status text not null default 'CREATED',
 init_started_at timestamptz, charge_started_at timestamptz, confirmed_at timestamptz,
 period_from timestamptz, period_until timestamptz, refunded_kopecks integer not null default 0 check(refunded_kopecks between 0 and 29000),
 referral_pct numeric not null, hold_days integer not null check(hold_days>=21),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '1 hour',
 check_at timestamptz not null default now(), attempts integer not null default 0, last_error text,
 unique(subscription_id,cycle)
);
create index pr_tbank_orders_access on public.pr_tbank_orders(user_id,period_until) where confirmed_at is not null and refunded_kopecks<29000;
create index pr_tbank_orders_work on public.pr_tbank_orders(check_at) where confirmed_at is null;
-- Saved bank reference stays outside the exposed API schema; no card numbers are stored.
create table portfolio_private.pr_rebill (
 subscription_id uuid primary key references public.pr_tbank_subscriptions(id),
 rebill_id text not null check(rebill_id ~ '^[0-9]{1,30}$'), updated_at timestamptz not null default now()
);
create table public.pr_rub_referrals (
 order_id text primary key references public.pr_tbank_orders(id),
 partner_id bigint not null references public.pr_customers(user_id), referred_id bigint not null references public.pr_customers(user_id),
 amount_kopecks integer not null check(amount_kopecks>=0), original_kopecks integer not null,
 available_at timestamptz not null, payout_reference text, paid_at timestamptz,
 check((payout_reference is null)=(paid_at is null))
);
create index pr_rub_referrals_partner on public.pr_rub_referrals(partner_id);
create index pr_rub_referrals_referred on public.pr_rub_referrals(referred_id);
do $$ declare t text;begin
 foreach t in array array['pr_tbank_subscriptions','pr_tbank_orders','pr_rub_referrals'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy portfolio_service_only on public.%I to service_role using(true) with check(true)',t);
 end loop;
end $$;
alter table portfolio_private.pr_rebill enable row level security;
revoke all on portfolio_private.pr_rebill from public,anon,authenticated;
grant all on portfolio_private.pr_rebill to service_role;
create policy portfolio_service_only on portfolio_private.pr_rebill to service_role using(true) with check(true);

create function public.pr_tbank_begin(p_user bigint,p_consent text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders; cfg public.pr_billing_settings;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found then raise exception 'customer_missing';end if;
 select * into cfg from public.pr_billing_settings where id=1;
 if not cfg.tbank_enabled or p_consent is distinct from 'rub-weekly-v1' then raise exception 'billing_disabled';end if;
 if exists(select 1 from public.pr_tbank_orders where user_id=p_user and period_until>now() and refunded_kopecks<29000) then raise exception 'subscription_active';end if;
 select x.* into o from public.pr_tbank_orders x join public.pr_tbank_subscriptions y on y.id=x.subscription_id
 where x.user_id=p_user and x.cycle=0 and x.expires_at>now() and x.provider_status in ('CREATED','NEW','FORM_SHOWED','AUTHORIZING','AUTHORIZED') and y.renew_enabled order by x.created_at desc limit 1;
 if found then return to_jsonb(o);end if;
 update public.pr_tbank_subscriptions set renew_enabled=false,status='cancelled',cancelled_at=now() where user_id=p_user and status='pending';
 insert into public.pr_tbank_subscriptions(user_id,consent_version) values(p_user,p_consent) returning * into s;
 insert into public.pr_tbank_orders(subscription_id,user_id,cycle,referral_pct,hold_days) values(s.id,p_user,0,cfg.referral_pct,cfg.hold_days) returning * into o;
 return to_jsonb(o);
end $$;

-- Exactly one worker may dispatch each Init or Charge. A timeout is reconciled,
-- never retried as a new debit. Cancellation and claims lock the same subscription.
create function public.pr_tbank_claim(p_order text,p_step text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders; token text;
begin
 select x.* into s from public.pr_tbank_subscriptions x join public.pr_tbank_orders y on y.subscription_id=x.id where y.id=p_order for update of x;
 select * into o from public.pr_tbank_orders where id=p_order for update;
 if not found or not s.renew_enabled or s.cancelled_at is not null or o.expires_at<=now() or o.confirmed_at is not null
 or not (select tbank_enabled from public.pr_billing_settings where id=1) then return null;end if;
 if p_step='init' and o.init_started_at is null then
  update public.pr_tbank_orders set init_started_at=now(),check_at=now()+interval '2 minutes' where id=o.id;
 elsif p_step='charge' and o.cycle>0 and o.payment_id is not null and o.charge_started_at is null and s.next_charge_at<=now() and s.status='active' then
  select rebill_id into token from portfolio_private.pr_rebill where subscription_id=s.id;
  if token is null then return null;end if;
  update public.pr_tbank_orders set charge_started_at=now(),check_at=now()+interval '2 minutes' where id=o.id;
 else return null;
 end if;
 return to_jsonb(o)||jsonb_build_object('rebill_id',token);
end $$;

create function public.pr_tbank_cancel(p_user bigint) returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.pr_tbank_subscriptions set renew_enabled=false,cancelled_at=coalesce(cancelled_at,now()),status='cancelled' where user_id=p_user;
end $$;

create function public.pr_tbank_fail(p_order text,p_reason text) returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.pr_tbank_subscriptions; o public.pr_tbank_orders;
begin
 select x.* into s from public.pr_tbank_subscriptions x join public.pr_tbank_orders y on y.subscription_id=x.id where y.id=p_order for update of x;
 select * into o from public.pr_tbank_orders where id=p_order for update;
 if not found or o.confirmed_at is not null then return false;end if;
 update public.pr_tbank_orders set provider_status='DEADLINE_EXPIRED',last_error=left(p_reason,100) where id=o.id;
 update public.pr_tbank_subscriptions set renew_enabled=false,status='past_due' where id=s.id and status<>'cancelled';
 return true;
end $$;

-- Caller must authenticate the bank signature (or a GetState response) first.
-- A single transaction grants access, credits a referral and queues the receipt.
create function public.pr_tbank_event(p_body jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
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
  select greatest(now(),c.trial_expires_at,(select max(period_until) from public.pr_tbank_orders where user_id=o.user_id and confirmed_at is not null and refunded_kopecks<29000)) into baseline from public.pr_customers c where c.user_id=o.user_id;
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
   case result when 'paid' then '✅ <b>Оплата 290 ₽ подтверждена</b>'||E'\n\nПолный доступ до '||to_char(expiry at time zone 'Europe/Moscow','DD.MM.YYYY HH24:MI')||E' МСК.\nСледующее продление — через 7 дней после начала оплаченной недели. /subscribe — статус, /unsubscribe — отключить автосписания.'
   when 'refund' then E'↩️ <b>Возврат учтён</b>\nАвтопродление отключено. /subscribe — статус доступа. /paysupport — помощь.'
   else E'Не удалось продлить подписку.\nПосле окончания оплаченного доступа сводка продолжится по трём активам. /subscribe — подключить снова.' end)) on conflict(dedup_key) do nothing;
 end if;
 return jsonb_build_object('result',result,'period_until',expiry);
end $$;

create function public.pr_tbank_due() returns setof public.pr_tbank_orders language plpgsql security invoker set search_path='' as $$
declare s public.pr_tbank_subscriptions; cfg public.pr_billing_settings; cycle_no integer;
begin
 select * into cfg from public.pr_billing_settings where id=1;
 if not cfg.tbank_enabled then return;end if;
 for s in select * from public.pr_tbank_subscriptions where renew_enabled and status='active' and next_charge_at<=now() order by next_charge_at limit 10 for update skip locked loop
  select coalesce(max(cycle),0)+1 into cycle_no from public.pr_tbank_orders where subscription_id=s.id and confirmed_at is not null;
  if not exists(select 1 from portfolio_private.pr_rebill where subscription_id=s.id) then
   update public.pr_tbank_subscriptions set renew_enabled=false,status='past_due' where id=s.id;
   continue;
  end if;
  insert into public.pr_tbank_orders(subscription_id,user_id,cycle,referral_pct,hold_days) values(s.id,s.user_id,cycle_no,cfg.referral_pct,cfg.hold_days) on conflict(subscription_id,cycle) do nothing;
 end loop;
 return query select * from public.pr_tbank_orders where confirmed_at is null and check_at<=now() and attempts<30 and provider_status in ('CREATED','NEW','FORM_SHOWED','AUTHORIZING','AUTHORIZED','CONFIRMING','3DS_CHECKING','3DS_CHECKED') order by check_at limit 3;
end $$;

create function public.pr_rub_referral_stats(p_user bigint) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('code',c.ref_code,'share_pct',s.referral_pct,'invited',(select count(*) from public.pr_customers where referrer_id=c.user_id),
 'pending',coalesce(sum(r.amount_kopecks) filter(where r.paid_at is null and r.available_at>now()),0)/100.0,
 'available',coalesce(sum(r.amount_kopecks) filter(where r.paid_at is null and r.available_at<=now()),0)/100.0,
 'paid',coalesce(sum(r.original_kopecks) filter(where r.paid_at is not null),0)/100.0,
 'adjustment',coalesce(sum(r.original_kopecks-r.amount_kopecks) filter(where r.paid_at is not null),0)/100.0)
 from public.pr_customers c cross join public.pr_billing_settings s left join public.pr_rub_referrals r on r.partner_id=c.user_id
 where c.user_id=p_user and s.id=1 group by c.user_id,s.referral_pct;
$$;
revoke all on function public.pr_tbank_begin(bigint,text),public.pr_tbank_claim(text,text),public.pr_tbank_cancel(bigint),public.pr_tbank_fail(text,text),public.pr_tbank_event(jsonb),public.pr_tbank_due(),public.pr_rub_referral_stats(bigint) from public,anon,authenticated;
grant execute on function public.pr_tbank_begin(bigint,text),public.pr_tbank_claim(text,text),public.pr_tbank_cancel(bigint),public.pr_tbank_fail(text,text),public.pr_tbank_event(jsonb),public.pr_tbank_due(),public.pr_rub_referral_stats(bigint) to service_role;

create or replace function portfolio_private.read_config() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(substring(name from 11),decrypted_secret),'{}'::jsonb) from vault.decrypted_secrets
 where name in ('portfolio_telegram_token','portfolio_openai_key','portfolio_coingecko_key','portfolio_finnhub_key','portfolio_webhook_secret','portfolio_worker_secret','portfolio_gateway_signing_key','portfolio_gateway_url');
$$;

-- Billing runs independently from expensive news/OCR work, only while orders exist.
create function portfolio_private.dispatch_billing() returns void language plpgsql security definer set search_path='' as $$
declare cfg jsonb;
begin
 if not (select tbank_enabled from public.pr_billing_settings where id=1) then return;end if;
 if not exists(select 1 from public.pr_tbank_subscriptions where renew_enabled and status='active' and next_charge_at<=now())
 and not exists(select 1 from public.pr_tbank_orders where confirmed_at is null and check_at<=now() and attempts<30 and provider_status in ('CREATED','NEW','FORM_SHOWED','AUTHORIZING','AUTHORIZED','CONFIRMING','3DS_CHECKING','3DS_CHECKED')) then return;end if;
 cfg:=portfolio_private.read_config();
 perform net.http_post(url:='https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/billing-work',
 headers:=jsonb_build_object('Content-Type','application/json','x-portfolio-worker-secret',cfg->>'worker_secret'),body:='{}'::jsonb,timeout_milliseconds:=5000);
end $$;
revoke all on function portfolio_private.dispatch_billing() from public,anon,authenticated,service_role;
select cron.schedule('portfolio-radar-billing','* * * * *','select portfolio_private.dispatch_billing()');
