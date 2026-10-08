-- Run in a transaction after db/community-pricing.sql; always ROLLBACK.
BEGIN;
do $test$
declare o jsonb; b jsonb; access jsonb; sid uuid; oid text; renew_id text; n integer;
begin
 update public.pr_billing_settings set community_pricing_enabled=true where id=1;
 insert into public.pr_customers(user_id,trial_started_at,trial_expires_at) values(9000000000001,now()-interval '10 days',now()-interval '7 days'),(9000000000002,now()-interval '10 days',now()-interval '7 days'),(9000000000003,now()-interval '10 days',now()-interval '7 days');
 insert into public.pr_users(chat_id) values(9000000000001);
 update public.pr_customers set referrer_id=9000000000002 where user_id=9000000000001;
 o:=public.pr_tbank_begin_community(9000000000001,'rub-weekly-community-v2',true,now(),array[-1002094215821]::bigint[]);
 assert (o->>'amount_kopecks')::int=14500,'initial discounted amount';
 oid:=o->>'id';sid:=(o->>'subscription_id')::uuid;
 assert public.pr_tbank_claim(oid,'init') is not null,'fresh init claim';
 update public.pr_tbank_orders set payment_id='999000123' where id=oid;
 b:=jsonb_build_object('OrderId',oid,'PaymentId','999000123','Amount',14500,'Status','CONFIRMED','Success',true,'RebillId','999000456');
 perform public.pr_tbank_event(b);
 assert public.pr_access(9000000000001,false)->>'tier'='paid','discounted access';
 assert (select r.amount_kopecks=floor(14500*o.referral_pct/100) from public.pr_rub_referrals r join public.pr_tbank_orders o on o.id=r.order_id where r.order_id=oid),'referral uses actual price';
 assert exists(select 1 from public.pr_outbox where dedup_key='tbank:'||oid||':paid' and body->>'text' like '%145 ₽%'),'paid text actual price';
 assert public.pr_tbank_event(b)->>'duplicate'='true','duplicate event';
 update public.pr_tbank_subscriptions set next_charge_at=now()-interval '1 minute' where id=sid;
 insert into public.pr_tbank_orders(subscription_id,user_id,cycle,referral_pct,hold_days) values(sid,9000000000001,1,10,21) returning id into renew_id;
 assert public.pr_tbank_claim(renew_id,'init') is null,'unchecked renewal blocked';
 o:=public.pr_tbank_price(renew_id,true,now(),array[-1002094215821,-1002230180865]::bigint[]);
 assert (o->>'amount_kopecks')::int=14500,'renewal discount not stacked';
 assert public.pr_tbank_claim(renew_id,'init') is not null,'priced renewal init';
 update public.pr_tbank_orders set payment_id='999000124' where id=renew_id;
 assert public.pr_tbank_price(renew_id,false,now(),array[]::bigint[])->>'price_changed'='true','cannot change bank amount after init';
 update public.pr_tbank_orders set membership_checked_at=now()-interval '3 minutes' where id=renew_id;
 assert public.pr_tbank_claim(renew_id,'charge') is null,'stale membership charge blocked';
 perform public.pr_tbank_price(renew_id,true,now(),array[-1002094215821]::bigint[]);
 assert public.pr_tbank_claim(renew_id,'charge') is not null,'fresh renewal charge claimed once';
 assert public.pr_tbank_claim(renew_id,'charge') is null,'no duplicate charge';
 b:=jsonb_set(b,'{Status}','"REFUNDED"');
 perform public.pr_tbank_event(b);
 assert public.pr_access(9000000000001,false)->>'tier'='free','fully refunded discounted order revokes access';
 assert (select amount_kopecks=0 from public.pr_rub_referrals where order_id=oid),'refund reverses referral';
 o:=public.pr_tbank_begin_community(9000000000003,'rub-weekly-community-v2',false,now(),array[]::bigint[]);
 assert (o->>'amount_kopecks')::int=29000,'nonmember price';
 begin
  perform public.pr_tbank_begin_community(9000000000002,'rub-weekly-community-v2',true,now()-interval '5 minutes',array[-1002094215821]::bigint[]);
  raise exception 'stale check accepted';
 exception when others then if sqlerrm<>'membership_unavailable' then raise;end if;end;
 assert not has_function_privilege('anon','public.pr_tbank_price(text,boolean,timestamptz,bigint[])','EXECUTE'),'anon cannot set price';
 assert not has_function_privilege('authenticated','public.pr_tbank_begin_community(bigint,text,boolean,timestamptz,bigint[])','EXECUTE'),'users cannot self grant discount';
end $test$;
select 'passed: 16 billing, refund, referral and permission assertions; transaction rolled back' as result;
ROLLBACK;
