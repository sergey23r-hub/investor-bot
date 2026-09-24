alter table public.pr_imports add column correction boolean not null default false, add column edit_row integer;
alter table portfolio_private.worker_lock drop constraint worker_lock_id_check;
alter table portfolio_private.worker_lock add constraint worker_lock_id_check check(id in (1,2));
insert into portfolio_private.worker_lock(id) values(2);
drop function public.pr_lock(uuid);
drop function public.pr_unlock(uuid);
drop function public.pr_next_job();
create function public.pr_lock(p_token uuid,p_lane integer default 1) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update portfolio_private.worker_lock set token=p_token,expires_at=now()+interval '150 seconds' where id=p_lane and expires_at<now();
  return found;
end $$;
create function public.pr_unlock(p_token uuid,p_lane integer default 1) returns void language sql security invoker set search_path='' as $$
 update portfolio_private.worker_lock set expires_at='-infinity',token=null where id=p_lane and token=p_token;
$$;
create function public.pr_next_job(p_lane integer default 1) returns setof public.pr_jobs language sql security invoker set search_path='' as $$
 update public.pr_jobs set state='running',attempts=attempts+1,lease_until=now()+interval '150 seconds'
 where id=(select id from public.pr_jobs where ((state='pending' and available_at<=now()) or (state='running' and lease_until<now())) and ((p_lane=1 and kind in ('update','extract')) or (p_lane=2 and kind in ('research','digest'))) order by case kind when 'update' then 0 when 'extract' then 1 when 'research' then 2 else 3 end,case when p_lane=2 then available_at else created_at end,id for update skip locked limit 1)
 returning *;
$$;
revoke all on function public.pr_lock(uuid,integer) from public,anon,authenticated;
grant execute on function public.pr_lock(uuid,integer) to service_role;
revoke all on function public.pr_unlock(uuid,integer) from public,anon,authenticated;
grant execute on function public.pr_unlock(uuid,integer) to service_role;
revoke all on function public.pr_next_job(integer) from public,anon,authenticated;
grant execute on function public.pr_next_job(integer) to service_role;
create or replace function portfolio_private.dispatch() returns void language plpgsql security definer set search_path='' as $$
declare config jsonb;
begin
 config:=portfolio_private.read_config();
 if not (config ? 'telegram_token') then return;end if;
 if (select count(*) from portfolio_private.worker_lock where expires_at>now())=2 then return;end if;
 if not exists(select 1 from public.pr_jobs where (state='pending' and available_at<=now()) or (state='running' and lease_until<now()))
    and not exists(select 1 from public.pr_outbox where state='pending' and available_at<=now())
    and not exists(select 1 from public.pr_users u where u.subscribed and (now() at time zone u.timezone)::time>=u.digest_time
      and not exists(select 1 from public.pr_jobs j where j.job_key='daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date)) then return;end if;
 perform net.http_post(
  url:='https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/work',
  headers:=jsonb_build_object('Content-Type','application/json','x-portfolio-worker-secret',config->>'worker_secret'),
  body:='{}'::jsonb,timeout_milliseconds:=5000
 );
end $$;
