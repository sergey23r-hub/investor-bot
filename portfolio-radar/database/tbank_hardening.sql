-- Record the actual manual payout amount; a refund before payout must not inflate it.
alter table public.pr_rub_referrals add column paid_kopecks integer check(paid_kopecks>=0);
alter table public.pr_rub_referrals add constraint pr_rub_payout_amount check((paid_kopecks is null)=(paid_at is null));
create or replace function public.pr_rub_referral_stats(p_user bigint) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('code',c.ref_code,'share_pct',s.referral_pct,'invited',(select count(*) from public.pr_customers where referrer_id=c.user_id),
 'pending',coalesce(sum(r.amount_kopecks) filter(where r.paid_at is null and r.available_at>now()),0)/100.0,
 'available',coalesce(sum(r.amount_kopecks) filter(where r.paid_at is null and r.available_at<=now()),0)/100.0,
 'paid',coalesce(sum(r.paid_kopecks) filter(where r.paid_at is not null),0)/100.0,
 'adjustment',coalesce(sum(greatest(r.paid_kopecks-r.amount_kopecks,0)) filter(where r.paid_at is not null),0)/100.0)
 from public.pr_customers c cross join public.pr_billing_settings s left join public.pr_rub_referrals r on r.partner_id=c.user_id
 where c.user_id=p_user and s.id=1 group by c.user_id,s.referral_pct;
$$;
-- This records an already executed RUB payout. It never transfers money itself.
create function public.pr_rub_record_payout(p_partner bigint,p_orders text[],p_reference text) returns integer language plpgsql security invoker set search_path='' as $$
declare total integer;
begin
 perform 1 from public.pr_customers where user_id=p_partner for update;
 if not found or coalesce(cardinality(p_orders),0)=0 or nullif(trim(p_reference),'') is null
 or cardinality(p_orders)<>(select count(distinct x) from unnest(p_orders) x) then raise exception 'invalid_payout';end if;
 perform 1 from public.pr_rub_referrals where partner_id=p_partner order by order_id for update;
 if exists(select 1 from public.pr_rub_referrals where payout_reference=p_reference) then
  if exists(select 1 from public.pr_rub_referrals where payout_reference=p_reference and (partner_id<>p_partner or not(order_id=any(p_orders))))
  or exists(select 1 from unnest(p_orders) x where not exists(select 1 from public.pr_rub_referrals where order_id=x and payout_reference=p_reference and partner_id=p_partner)) then raise exception 'payout_reference_conflict';end if;
  return (select sum(paid_kopecks) from public.pr_rub_referrals where payout_reference=p_reference);
 end if;
 if exists(select 1 from public.pr_rub_referrals where partner_id=p_partner and paid_kopecks>amount_kopecks) then raise exception 'refund_adjustment_pending';end if;
 if exists(select 1 from unnest(p_orders) x where not exists(select 1 from public.pr_rub_referrals where order_id=x and partner_id=p_partner and paid_at is null and available_at<=now() and amount_kopecks>0)) then raise exception 'payout_not_eligible';end if;
 update public.pr_rub_referrals set paid_at=now(),paid_kopecks=amount_kopecks,payout_reference=p_reference where partner_id=p_partner and order_id=any(p_orders);
 select sum(paid_kopecks) into total from public.pr_rub_referrals where payout_reference=p_reference;
 return total;
end $$;
revoke all on function public.pr_rub_record_payout(bigint,text[],text) from public,anon,authenticated;
grant execute on function public.pr_rub_record_payout(bigint,text[],text) to service_role;
