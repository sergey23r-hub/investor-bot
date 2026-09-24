create or replace function public.pr_next_job(p_lane integer default 1) returns setof public.pr_jobs language sql security invoker set search_path='' as $$
 update public.pr_jobs set state='running',attempts=attempts+1,lease_until=now()+interval '150 seconds'
 where id=(select id from public.pr_jobs where ((state='pending' and available_at<=now()) or (state='running' and lease_until<now())) and ((p_lane=1 and kind in ('update','extract')) or (p_lane=2 and kind in ('research','digest'))) order by case kind when 'update' then 0 when 'extract' then 1 when 'research' then 2 else 3 end,case when p_lane=2 then available_at else created_at end,id for update skip locked limit 1)
 returning *;
$$;
