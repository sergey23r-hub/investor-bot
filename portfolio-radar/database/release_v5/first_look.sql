-- One automatic first report per billing identity; deleting a portfolio cannot reset it.
create table public.pr_initial_reports (
 user_id bigint primary key references public.pr_customers(user_id),
 job_id bigint unique,
 report_id uuid references public.pr_reports(id) on delete set null,
 state text not null default 'queued' check(state in ('queued','ready','failed')),
 asset_count integer not null default 0 check(asset_count between 0 and 500),
 cached_assets integer not null default 0 check(cached_assets between 0 and 500),
 quote_count integer not null default 0 check(quote_count between 0 and 500),
 news_count integer not null default 0 check(news_count between 0 and 500),
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
create index pr_initial_reports_created on public.pr_initial_reports(created_at);
create index pr_initial_reports_report on public.pr_initial_reports(report_id);
alter table public.pr_initial_reports enable row level security;
revoke all on public.pr_initial_reports from public,anon,authenticated;
grant all on public.pr_initial_reports to service_role;
create policy portfolio_service_only on public.pr_initial_reports to service_role using(true) with check(true);

create function public.pr_initial_begin(p_user bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare initial public.pr_initial_reports; job bigint;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found then return jsonb_build_object('started',false,'reason','customer_missing');end if;
 select * into initial from public.pr_initial_reports where user_id=p_user;
 if found then return jsonb_build_object('started',false,'state',initial.state,'job_id',initial.job_id);end if;
 if not exists(select 1 from public.pr_accounts a cross join lateral jsonb_array_elements(a.positions) p where a.user_id=p_user and p->>'verified'='true' and p->>'provider'<>'cash') then
  return jsonb_build_object('started',false,'reason','no_verified_assets');
 end if;
 insert into public.pr_initial_reports(user_id) values(p_user);
 insert into public.pr_jobs(job_key,kind,payload,user_id)
 values('initial:'||p_user,'digest',jsonb_build_object('initial',true,'chat_id',p_user,'news_as_of',now()),p_user)
 returning id into job;
 update public.pr_initial_reports set job_id=job where user_id=p_user;
 return jsonb_build_object('started',true,'state','queued','job_id',job);
end $$;
revoke all on function public.pr_initial_begin(bigint) from public,anon,authenticated;
grant execute on function public.pr_initial_begin(bigint) to service_role;

alter table public.pr_product_events drop constraint pr_product_events_event_check;
alter table public.pr_product_events add constraint pr_product_events_event_check check(event in (
 'start','saved','report_ready','report_open','report_delivered','weekly_delivered','upgrade_open','qa_answer','referral_share',
 'upload_started','import_preview','initial_ready','initial_delivered'
));

-- Backfill shared quotes from existing provider results, without copying positions or identities.
with positions as (
 select p->>'key' as raw_key,case
  when p->>'isin' ~ '^[A-Z]{2}[A-Z0-9]{10}$' then 'isin:'||(p->>'isin')
  when p->>'provider'='coingecko' then 'cg:'||lower(p->>'provider_id')
  else p->>'key' end as asset_key
 from public.pr_accounts a cross join lateral jsonb_array_elements(a.positions) p where p->>'verified'='true'
), aliases as (
 select raw_key,min(asset_key) as asset_key from positions group by raw_key having count(distinct asset_key)=1
), candidates as (
 select q.key,q.value,j.created_at as captured_at from public.pr_jobs j cross join lateral jsonb_each(coalesce(j.payload->'digest_quotes','{}')) q
 where j.kind='digest' and j.state='done' and j.created_at>now()-interval '7 days'
 union all
 select q.key,q.value,r.created_at from public.pr_reports r cross join lateral jsonb_each(coalesce(r.snapshot->'quotes','{}')) q
 where r.created_at>now()-interval '7 days'
), eligible as (
 select coalesce(a.asset_key,c.key) as asset_key,captured_at,c.value
 from candidates c left join aliases a on a.raw_key=c.key
 where value->>'status'='ok' and jsonb_typeof(value->'price')='number'
 and value->>'as_of' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}'
), safe as (
 select asset_key,captured_at,jsonb_strip_nulls(jsonb_build_object(
  'status','ok','price',value->'price','currency',value->'currency','change_pct',value->'change_pct',
  'as_of',value->'as_of','url',value->'url','unit_price',value->'unit_price','unit_currency',value->'unit_currency'
 )) as value from eligible
 where (value->>'as_of')::timestamptz between now()-interval '7 days' and now()+interval '1 day'
), selected as (
 select distinct on (asset_key,(captured_at at time zone 'Europe/Moscow')::date)
 'quote:daily:v1:'||(captured_at at time zone 'Europe/Moscow')::date||':'||asset_key as key,value,captured_at
 from safe order by asset_key,(captured_at at time zone 'Europe/Moscow')::date,captured_at desc
)
insert into public.pr_cache(key,value,expires_at) select key,value,captured_at+interval '7 days' from selected
on conflict(key) do nothing;

create or replace function public.pr_product_metrics() returns jsonb
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
  'active_paid',(select count(distinct user_id) from public.pr_tbank_orders where confirmed_at is not null and refunded_kopecks<29000 and period_until>now()),
  'net_receipts_rub',(select coalesce(sum(amount_kopecks-refunded_kopecks),0)/100.0 from public.pr_tbank_orders where confirmed_at>now()-interval '30 days'),
  'ai_estimated_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where created_at>now()-interval '30 days'),
  'ai_shared_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where user_id is null and created_at>now()-interval '30 days'),
  'ai_direct_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where user_id is not null and created_at>now()-interval '30 days'),
  'api_cost_per_served_user_usd',(select coalesce(sum(estimated_usd),0) from public.pr_usage where created_at>now()-interval '30 days')/nullif((select count(distinct user_id) from public.pr_product_events where event in ('report_delivered','initial_delivered') and created_at>now()-interval '30 days'),0),
  'qa_requests',(select count(*) from public.pr_qa_requests where created_at>now()-interval '30 days'),
  'failed_deliveries',(select count(*) from public.pr_outbox where state in ('failed','uncertain') and created_at>now()-interval '7 days')
 );
$$;

revoke all on function public.pr_product_metrics() from public,anon,authenticated;
grant execute on function public.pr_product_metrics() to service_role;
