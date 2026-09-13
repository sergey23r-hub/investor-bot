-- Transactional integration tests: no payments, configuration or customers survive.
begin;
do $$
declare u bigint:=8000000000000+floor(random()*100000000)::bigint; v bigint; w bigint; code text; i jsonb; j jsonb; r jsonb; stamp bigint:=extract(epoch from now())::bigint;
begin
 v:=u+1; w:=u+2;
 perform public.pr_customer(u);
 select ref_code into code from public.pr_customers where user_id=u;
 perform public.pr_customer(v,code);perform public.pr_customer(v,null);
 assert (select referrer_id=u from public.pr_customers where user_id=v),'first touch lost';
 perform public.pr_customer(w);perform public.pr_customer(w,code);
 assert (select referrer_id is null from public.pr_customers where user_id=w),'organic signup overwritten';
 assert not (select enabled from public.pr_billing_settings where id=1),'run only while sales disabled';
 assert (public.pr_access(v)->>'allowed')::boolean,'test access lost';
 update public.pr_billing_settings set enabled=true,price_stars=1000,trial_days=0 where id=1;
 assert not (public.pr_access(v)->>'allowed')::boolean,'unpaid access';
 i:=public.pr_create_invoice(v);
 assert not public.pr_checkout(w,(i->>'id')::uuid,'XTR',1000,'wrong-user');
 assert not public.pr_checkout(v,(i->>'id')::uuid,'RUB',1000,'wrong-currency');
 assert not public.pr_checkout(v,(i->>'id')::uuid,'XTR',999,'wrong-price');
 assert public.pr_checkout(v,(i->>'id')::uuid,'XTR',1000,'initial');
 assert public.pr_checkout(v,(i->>'id')::uuid,'XTR',1000,'initial'),'checkout replay';
 assert not public.pr_checkout(v,(i->>'id')::uuid,'XTR',1000,'parallel'),'parallel checkout';
 r:=public.pr_payment(v,(i->>'id')::uuid,'test-'||v,'XTR',1000,stamp+2592000,stamp,true,true);
 assert not (r->>'duplicate')::boolean;
 r:=public.pr_payment(v,(i->>'id')::uuid,'test-'||v,'XTR',1000,stamp+2592000,stamp,true,true);
 assert (r->>'duplicate')::boolean;
 assert (select count(*)=1 from public.pr_referral_ledger where referred_id=v),'duplicate referral';
 assert (select amount_stars=200 from public.pr_referral_ledger where referred_id=v),'referral amount';
 assert (public.pr_access(v)->>'allowed')::boolean;
 assert not public.pr_checkout(v,(i->>'id')::uuid,'XTR',1000,'duplicate-subscription');
 -- Price changes do not alter an existing recurring contract.
 update public.pr_billing_settings set price_stars=2000 where id=1;
 perform public.pr_payment(v,(i->>'id')::uuid,'renew-'||v,'XTR',1000,stamp+2*2592000,stamp+2592000,true,false);
 assert (select count(*)=2 from public.pr_referral_ledger where referred_id=v),'renewal commission missing';
 perform public.pr_refund(v,(i->>'id')::uuid,'renew-'||v,'XTR',1000);
 perform public.pr_refund(v,(i->>'id')::uuid,'renew-'||v,'XTR',1000);
 assert extract(epoch from (public.pr_access(v)->>'paid_until')::timestamptz)::bigint=stamp+2592000,'refund revoked wrong period';
 assert (select count(*)=1 from public.pr_referral_ledger where referred_id=v and reversed),'refund duplicated';
 -- Refund-before-payment delivery cannot grant access or commission later.
 j:=public.pr_create_invoice(w);
 perform public.pr_refund(w,(j->>'id')::uuid,'late-'||w,'XTR',2000);
 perform public.pr_payment(w,(j->>'id')::uuid,'late-'||w,'XTR',2000,stamp+2592000,stamp,true,true);
 assert not (public.pr_access(w)->>'allowed')::boolean,'reordered refund granted access';
 -- Expiry is authoritative even if no cancellation callback exists.
 update public.pr_payments set expires_at=now()-interval '1 second' where user_id=v;
 assert not (public.pr_access(v)->>'allowed')::boolean,'expired access';
 assert not has_function_privilege('anon','public.pr_payment(bigint,uuid,text,text,integer,bigint,bigint,boolean,boolean)','EXECUTE'),'anonymous payment RPC';
 assert not has_table_privilege('authenticated','public.pr_referral_ledger','SELECT'),'client ledger access';
end $$;
rollback;
