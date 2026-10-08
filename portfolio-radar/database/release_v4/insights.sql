-- Portfolius 0.4: stored reports, bounded questions and product metrics.
create table public.pr_reports (
 id uuid primary key default gen_random_uuid(),
 user_id bigint not null references public.pr_users(chat_id) on delete cascade,
 kind text not null check(kind in ('daily','first','weekly')),
 service_day date not null,
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 created_at timestamptz not null default now(),
 unique(user_id,kind,service_day)
);
create index pr_reports_user_recent on public.pr_reports(user_id,created_at desc);
create table public.pr_product_events (
 dedup_key text primary key,
 user_id bigint references public.pr_users(chat_id) on delete set null,
 event text not null check(event in ('start','saved','report_ready','report_open','report_delivered','weekly_delivered','upgrade_open','qa_answer','referral_share')),
 created_at timestamptz not null default now()
);
create index pr_product_events_date on public.pr_product_events(created_at,event);
create index pr_product_events_user on public.pr_product_events(user_id);
create table public.pr_qa_requests (
 request_key text primary key,
 user_id bigint not null references public.pr_users(chat_id) on delete cascade,
 service_day date not null default (now() at time zone 'Europe/Moscow')::date,
 state text not null default 'started' check(state in ('started','completed','failed')),
 answer text,
 created_at timestamptz not null default now(),
 check(length(answer)<=12000)
);
create index pr_qa_user_day on public.pr_qa_requests(user_id,service_day);
create table public.pr_ui_sessions (
 user_id bigint primary key references public.pr_users(chat_id) on delete cascade,
 mode text not null check(mode='ask'),
 expires_at timestamptz not null
);
do $$ declare t text; begin
 foreach t in array array['pr_reports','pr_product_events','pr_qa_requests','pr_ui_sessions'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create function public.pr_qa_reserve(p_user bigint,p_request text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare q public.pr_qa_requests; n integer; a jsonb;
begin
 if length(p_request)>100 or length(p_request)<1 then raise exception 'invalid_request';end if;
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found then return jsonb_build_object('allowed',false,'reason','customer_missing');end if;
 a:=public.pr_access(p_user);
 if a->>'tier' not in ('paid','trial','test') then return jsonb_build_object('allowed',false,'reason','subscription');end if;
 select * into q from public.pr_qa_requests where request_key=p_request and user_id=p_user;
 if found then return jsonb_build_object('allowed',false,'reason','duplicate','state',q.state,'answer',q.answer);end if;
 select count(*) into n from public.pr_qa_requests where user_id=p_user and service_day=(now() at time zone 'Europe/Moscow')::date;
 if n>=3 then return jsonb_build_object('allowed',false,'reason','limit');end if;
 insert into public.pr_qa_requests(request_key,user_id) values(p_request,p_user);
 return jsonb_build_object('allowed',true,'remaining',2-n);
end $$;

create function public.pr_insights_maintenance() returns integer
language plpgsql security invoker set search_path='' as $$
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
   and not exists(select 1 from public.pr_tbank_orders o where o.user_id=u.chat_id and o.confirmed_at is not null and o.refunded_kopecks<29000 and o.period_until>now())
 ), inserted as (
  insert into public.pr_outbox(dedup_key,user_id,body)
  select 'lifecycle:'||chat_id||':'||notice||':'||extract(epoch from trial_expires_at),chat_id,
   jsonb_build_object('chat_id',chat_id,'parse_mode','HTML','text',case when notice='trial_ending' then
    '🎁 <b>Пробный доступ скоро закончится</b>'||E'\n\n'||'Полный портфель открыт до '||to_char(trial_expires_at at time zone 'Europe/Moscow','DD.MM HH24:MI')||' МСК. Затем ежедневная сводка продолжится по первым трём активам. Весь портфель и аналитика — 290 ₽ каждые 7 дней.'
    else '🎁 <b>Пробный период завершён</b>'||E'\n\n'||'Портфель сохранён. Бесплатная сводка продолжится по первым трём активам. Полный обзор, итоги недели и аналитика всего портфеля — 290 ₽ каждые 7 дней.' end,
    'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','💎 Открыть весь портфель','callback_data','billing:upgrade')))),
    '_portfolius',jsonb_build_object('notice',notice))
  from eligible on conflict(dedup_key) do nothing returning id
 ) select count(*) into n from inserted;
 return n;
end $$;

create function public.pr_product_metrics() returns jsonb
language sql security invoker set search_path='' as $$
 with first_pay as (
  select user_id,min(confirmed_at) as first_at,count(*) as paid_weeks
  from public.pr_tbank_orders where confirmed_at is not null and refunded_kopecks<29000 group by user_id
 ), cohorts as (
  select count(*) as mature,count(*) filter(where paid_weeks>1) as renewed
  from first_pay where first_at between now()-interval '30 days' and now()-interval '7 days'
 )
 select jsonb_build_object(
  'period_days',30,
  'new_users',(select count(*) from public.pr_customers where first_seen_at>now()-interval '30 days'),
  'saved_users',(select count(distinct user_id) from public.pr_product_events where event='saved' and created_at>now()-interval '30 days'),
  'delivered_users',(select count(distinct user_id) from public.pr_product_events where event='report_delivered' and created_at>now()-interval '30 days'),
  'opened_users',(select count(distinct user_id) from public.pr_product_events where event='report_open' and created_at>now()-interval '30 days'),
  'new_payers',(select count(*) from first_pay where first_at>now()-interval '30 days'),
  'renewal_cohort',(select mature from cohorts),'renewed_users',(select renewed from cohorts),
  'active_paid',(select count(distinct user_id) from public.pr_tbank_orders where confirmed_at is not null and refunded_kopecks<29000 and period_until>now()),
  'net_receipts_rub',(select coalesce(sum(amount_kopecks-refunded_kopecks),0)/100.0 from public.pr_tbank_orders where confirmed_at>now()-interval '30 days'),
  'ai_estimated_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where created_at>now()-interval '30 days'),
  'ai_shared_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where user_id is null and created_at>now()-interval '30 days'),
  'ai_direct_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where user_id is not null and created_at>now()-interval '30 days'),
  'api_cost_per_served_user_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where created_at>now()-interval '30 days')/nullif((select count(distinct user_id) from public.pr_product_events where event='report_delivered' and created_at>now()-interval '30 days'),0),
  'qa_requests',(select count(*) from public.pr_qa_requests where created_at>now()-interval '30 days'),
  'failed_deliveries',(select count(*) from public.pr_outbox where state in ('failed','uncertain') and created_at>now()-interval '7 days')
 );
$$;
revoke all on function public.pr_qa_reserve(bigint,text),public.pr_insights_maintenance(),public.pr_product_metrics() from public,anon,authenticated;
grant execute on function public.pr_qa_reserve(bigint,text),public.pr_insights_maintenance(),public.pr_product_metrics() to service_role;
