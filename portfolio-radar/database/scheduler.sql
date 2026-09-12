create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
alter table public.pr_imports add column last_edit_key text;
do $$ declare r record; begin
 for r in select tablename from pg_tables where schemaname='public' and tablename like 'pr\_%' escape '\' loop
  execute format('create policy portfolio_service_only on public.%I to service_role using (true) with check (true)',r.tablename);
 end loop;
end $$;
-- Cron invocation has no browser access and never stores secrets in cron command text.
create function portfolio_private.dispatch() returns void language plpgsql security definer set search_path='' as $$
declare config jsonb;
begin
 config:=portfolio_private.read_config();
 if not (config ? 'telegram_token') then return;end if;
 if exists(select 1 from portfolio_private.worker_lock where id=1 and expires_at>now()) then return;end if;
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
revoke all on function portfolio_private.dispatch() from public,anon,authenticated,service_role;
select cron.schedule('portfolio-radar-worker','15 seconds','select portfolio_private.dispatch()');
-- Metadata retention also runs when the bot is paused or its credentials are unavailable.
select cron.schedule('portfolio-radar-cleanup','17 * * * *','select public.pr_cleanup()');
