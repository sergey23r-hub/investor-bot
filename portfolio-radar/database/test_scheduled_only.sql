-- Run after scheduled_only.sql. Everything is rolled back, including scheduled jobs.
begin;
do $$
declare u bigint:=8100000000000+floor(random()*100000000)::bigint;
begin
 perform public.pr_customer(u);
 insert into public.pr_users(chat_id,subscribed,digest_time,timezone) values(u,true,'00:00','Pacific/Kiritimati');
 insert into public.pr_accounts(user_id,name,positions) values(u,'Test','[{"key":"test","name":"Test","verified":true}]');
 perform public.pr_daily_jobs();
 assert (select count(*)=1 from public.pr_jobs where kind='digest' and user_id=u),'daily digest not scheduled';
 assert (select count(*)=1 from public.pr_digest_days where user_id=u),'day not reserved';
 perform public.pr_daily_jobs();
 assert (select count(*)=1 from public.pr_jobs where kind='digest' and user_id=u),'duplicate daily job';
 update public.pr_users set timezone='Etc/GMT+12' where chat_id=u;
 perform public.pr_daily_jobs();
 assert (select count(*)=1 from public.pr_jobs where kind='digest' and user_id=u),'timezone reset daily allowance';
 update public.pr_users set subscribed=false where chat_id=u;
 update public.pr_users set subscribed=true where chat_id=u;
 perform public.pr_daily_jobs();
 assert (select count(*)=1 from public.pr_jobs where kind='digest' and user_id=u),'pause reset daily allowance';
 begin
  perform public.pr_enqueue('manual:test','digest','{}',u);
  raise exception 'manual digest unexpectedly accepted';
 exception when others then
  if sqlerrm<>'manual_updates_disabled' then raise;end if;
 end;
 perform public.pr_forget(u);
 assert (select count(*)=1 from public.pr_digest_days where user_id=u),'deletion reset daily allowance';
 insert into public.pr_users(chat_id,subscribed,digest_time,timezone) values(u,true,'00:00','Europe/Moscow');
 insert into public.pr_accounts(user_id,name,positions) values(u,'Test','[{"key":"test","name":"Test","verified":true}]');
 perform public.pr_daily_jobs();
 assert not exists(select 1 from public.pr_jobs where kind='digest' and user_id=u),'recreation triggered another digest';
 -- Previous days do not block the next day.
 update public.pr_digest_days set service_day=service_day-1 where user_id=u;
 perform public.pr_daily_jobs();
 assert (select count(*)=1 from public.pr_jobs where kind='digest' and user_id=u),'old reservation blocked new day';
 assert not has_table_privilege('anon','public.pr_digest_days','INSERT'),'anonymous quota access';
end $$;
rollback;
