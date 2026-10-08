-- Freemium access is separate from checkout availability.
alter table public.pr_billing_settings add column freemium_enabled boolean not null default true;
alter table public.pr_billing_settings add column free_asset_limit integer not null default 3 check(free_asset_limit=3);
alter table public.pr_billing_settings add column price_week_rub integer not null default 290 check(price_week_rub>0);
alter table public.pr_customers add column trial_expires_at timestamptz;
update public.pr_billing_settings set trial_days=3,asset_limit=500 where id=1;
-- Existing testers get a fresh 72 hours from rollout; never reset an existing trial.
update public.pr_customers c set trial_started_at=coalesce(c.trial_started_at,now()),
 trial_expires_at=coalesce(c.trial_started_at,now())+interval '72 hours'
where exists(select 1 from public.pr_accounts a where a.user_id=c.user_id and jsonb_array_length(a.positions)>0);

create or replace function public.pr_access(p_user bigint,p_start_trial boolean default false) returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.pr_billing_settings; c public.pr_customers; paid timestamptz; tier text; lim integer;
begin
 select * into s from public.pr_billing_settings where id=1;
 select * into c from public.pr_customers where user_id=p_user for update;
 if not found then raise exception 'customer_missing';end if;
 select max(period_until) into paid from public.pr_tbank_orders where user_id=p_user and confirmed_at is not null and refunded_kopecks<29000;
 if s.freemium_enabled and p_start_trial and c.trial_started_at is null and paid is null then
  update public.pr_customers set trial_started_at=now(),trial_expires_at=now()+interval '72 hours' where user_id=p_user returning * into c;
 end if;
 tier:=case when not s.freemium_enabled then 'test' when paid>now() then 'paid'
  when c.trial_expires_at>now() then 'trial' when c.trial_started_at is null and paid is null then 'pending' else 'free' end;
 lim:=case when tier='free' then s.free_asset_limit else s.asset_limit end;
 return jsonb_build_object('freemium',s.freemium_enabled,'enabled',s.tbank_enabled,'checkout_enabled',s.tbank_enabled,
  'allowed',true,'tier',tier,'paid_until',paid,'trial_until',c.trial_expires_at,'trial_days',3,
  'price_stars',s.price_stars,'price_week_rub',s.price_week_rub,'asset_limit',lim,
  'full_asset_limit',s.asset_limit,'free_asset_limit',s.free_asset_limit,'manual_daily',0);
end $$;

-- A new trial starts only after a portfolio has been successfully confirmed.
-- App also calls pr_access after commit to return the exact deadline to the user.
create function portfolio_private.start_portfolio_trial() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if jsonb_array_length(new.positions)>0 and old.version<>new.version then
  perform public.pr_access(new.user_id,true);
 end if;
 return new;
end $$;
revoke all on function portfolio_private.start_portfolio_trial() from public,anon,authenticated;
grant execute on function portfolio_private.start_portfolio_trial() to service_role;
create trigger pr_start_portfolio_trial after update of positions,version on public.pr_accounts
for each row execute function portfolio_private.start_portfolio_trial();
