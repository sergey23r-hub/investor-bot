-- Market refreshes are scheduler-only. Portfolio uploads/corrections stay available.
create table public.pr_digest_days (
 user_id bigint not null references public.pr_customers(user_id),
 service_day date not null,
 primary key(user_id,service_day)
);
create index pr_digest_days_date on public.pr_digest_days(service_day);
alter table public.pr_digest_days enable row level security;
revoke all on public.pr_digest_days from public,anon,authenticated;
grant all on public.pr_digest_days to service_role;
create policy portfolio_service_only on public.pr_digest_days to service_role using(true) with check(true);

-- Preserve today's allowance; changing timezone or recreating a portfolio cannot reset it.
insert into public.pr_digest_days(user_id,service_day)
select distinct j.user_id,(j.created_at at time zone 'Europe/Moscow')::date
from public.pr_jobs j join public.pr_customers c on c.user_id=j.user_id
where j.kind='digest' and j.payload->'daily'='true'::jsonb
on conflict do nothing;

create or replace function public.pr_daily_jobs() returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 delete from public.pr_digest_days where service_day<(now() at time zone 'Europe/Moscow')::date-30;
 with eligible as (
  select u.chat_id,'daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date as job_key
  from public.pr_users u where u.subscribed and (now() at time zone u.timezone)::time>=u.digest_time
  and (public.pr_access(u.chat_id)->>'allowed')::boolean
  and exists(select 1 from public.pr_accounts a where a.user_id=u.chat_id and jsonb_array_length(a.positions)>0)
  and not exists(select 1 from public.pr_jobs j where j.job_key='daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date)
 ), reserved as (
  insert into public.pr_digest_days(user_id,service_day)
  select chat_id,(now() at time zone 'Europe/Moscow')::date from eligible
  on conflict do nothing returning user_id
 )
 insert into public.pr_jobs(job_key,kind,payload,user_id)
 select e.job_key,'digest',jsonb_build_object('chat_id',e.chat_id,'daily',true),e.chat_id
 from eligible e join reserved r on r.user_id=e.chat_id
 on conflict do nothing;
 get diagnostics n=row_count;return n;
end $$;

create or replace function public.pr_enqueue(p_key text,p_kind text,p_payload jsonb,p_user bigint default null) returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_kind='digest' then raise exception 'manual_updates_disabled';end if;
 insert into public.pr_jobs(job_key,kind,payload,user_id) values(p_key,p_kind,p_payload,p_user) on conflict(job_key) do nothing;
end $$;

-- Pending legacy manual digests cannot run or be delivered after this migration.
update public.pr_outbox o set state='failed',last_error='manual_updates_disabled'
where o.state='pending' and exists(select 1 from public.pr_jobs j where j.kind='digest'
 and j.payload->'daily' is distinct from 'true'::jsonb and left(o.dedup_key,length(j.id::text)+1)=j.id||':');
update public.pr_jobs set state='done',lease_until=null,last_error='manual_updates_disabled'
where kind='digest' and state in ('pending','running') and payload->'daily' is distinct from 'true'::jsonb;

create or replace function portfolio_private.dispatch() returns void language plpgsql security definer set search_path='' as $$
declare config jsonb;
begin
 config:=portfolio_private.read_config();
 if not (config ? 'telegram_token') then return;end if;
 if (select count(*) from portfolio_private.worker_lock where expires_at>now())=2 then return;end if;
 if not exists(select 1 from public.pr_jobs where (state='pending' and available_at<=now()) or (state='running' and lease_until<now()))
    and not exists(select 1 from public.pr_outbox where state='pending' and available_at<=now())
    and not exists(select 1 from public.pr_users u where u.subscribed and (now() at time zone u.timezone)::time>=u.digest_time
      and not exists(select 1 from public.pr_digest_days d where d.user_id=u.chat_id and d.service_day=(now() at time zone 'Europe/Moscow')::date)
      and not exists(select 1 from public.pr_jobs j where j.job_key='daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date)
      and exists(select 1 from public.pr_accounts a where a.user_id=u.chat_id and jsonb_array_length(a.positions)>0)
      and (public.pr_access(u.chat_id)->>'allowed')::boolean) then return;end if;
 perform net.http_post(
  url:='https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/work',
  headers:=jsonb_build_object('Content-Type','application/json','x-portfolio-worker-secret',config->>'worker_secret'),
  body:='{}'::jsonb,timeout_milliseconds:=5000
 );
end $$;

-- Remove obsolete manual allowance from the live entitlement response, without
-- changing paid periods, prices, trial access, or portfolio permissions.
do $$ declare definition text; begin
 select pg_get_functiondef('public.pr_access(bigint,boolean)'::regprocedure) into definition;
 definition:=replace(definition,'''manual_daily'',case when s.enabled then 1 else 3 end','''manual_daily'',0');
 execute definition;
end $$;
