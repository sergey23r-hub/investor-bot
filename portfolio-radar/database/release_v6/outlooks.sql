-- Shared public asset data only. User positions stay in pr_accounts.
create table public.pr_outlook_jobs (
 asset_key text not null, service_day date not null, asset jsonb not null,
 state text not null default 'pending' check(state in ('pending','running','done','failed')),
 attempted_at timestamptz, finished_at timestamptz,
 primary key(asset_key,service_day)
);
create index pr_outlook_jobs_pending on public.pr_outlook_jobs(service_day,asset_key) where state='pending';
create table public.pr_outlook_sources (
 source_key text not null, service_day date not null,
 status text not null check(status in ('pending','ok','empty','unavailable')),
 data jsonb, error text, created_at timestamptz not null default now(),
 primary key(source_key,service_day)
);
create table public.pr_outlook_snapshots (
 asset_key text not null,service_day date not null,data jsonb not null,
 created_at timestamptz not null default now(),primary key(asset_key,service_day)
);
alter table public.pr_outlook_jobs enable row level security;
alter table public.pr_outlook_sources enable row level security;
alter table public.pr_outlook_snapshots enable row level security;
revoke all on public.pr_outlook_jobs,public.pr_outlook_sources,public.pr_outlook_snapshots from public,anon,authenticated;
grant all on public.pr_outlook_jobs,public.pr_outlook_sources,public.pr_outlook_snapshots to service_role;
create policy portfolio_service_only on public.pr_outlook_jobs to service_role using(true) with check(true);
create policy portfolio_service_only on public.pr_outlook_sources to service_role using(true) with check(true);
create policy portfolio_service_only on public.pr_outlook_snapshots to service_role using(true) with check(true);
alter table portfolio_private.worker_lock drop constraint worker_lock_id_check;
alter table portfolio_private.worker_lock add constraint worker_lock_id_check check(id in(1,2,3));
insert into portfolio_private.worker_lock(id,expires_at) values(3,'epoch') on conflict(id) do nothing;

create function public.pr_outlook_schedule() returns integer
language plpgsql security invoker set search_path='' as $$
declare day date:=(now() at time zone 'Europe/Moscow')::date; inserted integer;
begin
 -- No recovery retry that would silently multiply daily provider requests.
 update public.pr_outlook_jobs set state='failed',finished_at=now()
 where state='running' and attempted_at<now()-interval '4 minutes';
 update public.pr_outlook_sources set status='unavailable',error='collection_interrupted'
 where status='pending' and created_at<now()-interval '4 minutes';
 delete from public.pr_outlook_sources where service_day<day-8;
 delete from public.pr_outlook_jobs where service_day<day-8;
 delete from public.pr_outlook_snapshots where service_day<day-95;
 with positions as (
  select p,case when p->>'isin' ~* '^[A-Z]{2}[A-Z0-9]{10}$' then 'isin:'||upper(p->>'isin')
  when p->>'provider'='coingecko' then 'cg:'||lower(p->>'provider_id') else p->>'key' end as asset_key
  from public.pr_accounts a cross join lateral jsonb_array_elements(a.positions) p
  where (p->>'verified'='true' or p->>'provider'='cash') and p->>'key' is not null
 ), assets as (
  select distinct on(asset_key) asset_key,jsonb_strip_nulls(jsonb_build_object(
   'key',asset_key,'name',p->>'name','symbol',p->>'symbol','isin',p->>'isin',
   'provider',p->>'provider','provider_id',p->>'provider_id','kind',p->>'kind',
   'currency',p->>'currency','verified',p->'verified'
  )) as asset from positions where asset_key is not null order by asset_key,p->>'provider_id'
 )
 insert into public.pr_outlook_jobs(asset_key,service_day,asset) select asset_key,day,asset from assets
 on conflict(asset_key,service_day) do nothing;
 get diagnostics inserted=row_count;return inserted;
end $$;
create function public.pr_outlook_claim() returns setof public.pr_outlook_jobs
language sql security invoker set search_path='' as $$
 update public.pr_outlook_jobs set state='running',attempted_at=now()
 where (asset_key,service_day) in (
  select asset_key,service_day from public.pr_outlook_jobs
  where state='pending' and service_day=(now() at time zone 'Europe/Moscow')::date
  order by asset_key for update skip locked limit 1
 ) returning *;
$$;
create function public.pr_outlook_latest(p_keys text[]) returns setof public.pr_outlook_snapshots
language sql stable security invoker set search_path='' as $$
 select distinct on(asset_key) s.* from public.pr_outlook_snapshots s
 where asset_key=any(p_keys) and service_day between (now() at time zone 'Europe/Moscow')::date-95 and (now() at time zone 'Europe/Moscow')::date
 order by asset_key,service_day desc;
$$;
create function public.pr_outlook_metrics() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'assets',(select count(*) from public.pr_outlook_jobs where service_day=(now() at time zone 'Europe/Moscow')::date),
 'done',(select count(*) from public.pr_outlook_jobs where service_day=(now() at time zone 'Europe/Moscow')::date and state='done'),
 'failed',(select count(*) from public.pr_outlook_jobs where service_day=(now() at time zone 'Europe/Moscow')::date and state='failed'),
 'consensus',(select count(*) from public.pr_outlook_snapshots where service_day=(now() at time zone 'Europe/Moscow')::date and data->>'status'='consensus'),
 'opinions',(select count(*) from public.pr_outlook_snapshots where service_day=(now() at time zone 'Europe/Moscow')::date and data->>'status'='opinions'),
 'context',(select count(*) from public.pr_outlook_snapshots where service_day=(now() at time zone 'Europe/Moscow')::date and data->>'status'='context'),
 'opens',(select count(*) from public.pr_product_events where event='outlook_open' and created_at>now()-interval '30 days'),
 'source_failures',(select count(*) from public.pr_outlook_sources where service_day=(now() at time zone 'Europe/Moscow')::date and status='unavailable')
 );
$$;
revoke all on function public.pr_outlook_schedule(),public.pr_outlook_claim(),public.pr_outlook_latest(text[]),public.pr_outlook_metrics() from public,anon,authenticated;
grant execute on function public.pr_outlook_schedule(),public.pr_outlook_claim(),public.pr_outlook_latest(text[]),public.pr_outlook_metrics() to service_role;
alter table public.pr_product_events drop constraint pr_product_events_event_check;
alter table public.pr_product_events add constraint pr_product_events_event_check check(event in (
 'start','saved','report_ready','report_open','report_delivered','weekly_delivered','upgrade_open','qa_answer','referral_share',
 'upload_started','import_preview','initial_ready','initial_delivered','outlook_open'
));
-- Install the minute scheduler only after the compatible Edge Function is deployed.
