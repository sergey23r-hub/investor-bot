create function portfolio_private.dispatch_outlooks() returns void
language plpgsql security definer set search_path='' as $$
declare cfg jsonb;
begin
 if not exists(select 1 from public.pr_accounts where jsonb_array_length(positions)>0) then return;end if;
 perform public.pr_outlook_schedule();
 if not exists(select 1 from public.pr_outlook_jobs where state='pending' and service_day=(now() at time zone 'Europe/Moscow')::date) then return;end if;
 cfg:=portfolio_private.read_config();
 perform net.http_post(url:='https://swlwrhkfcmsexscfsrtc.supabase.co/functions/v1/portfolio-radar/outlook-work',
  headers:=jsonb_build_object('Content-Type','application/json','x-portfolio-worker-secret',cfg->>'worker_secret'),body:='{}'::jsonb,timeout_milliseconds:=5000);
end $$;
revoke all on function portfolio_private.dispatch_outlooks() from public,anon,authenticated;
select cron.schedule('portfolio-radar-outlooks','* * * * *','select portfolio_private.dispatch_outlooks()');
