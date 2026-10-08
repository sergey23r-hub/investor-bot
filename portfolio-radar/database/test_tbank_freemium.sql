begin;
set local role service_role;
do $$
declare u bigint:=919000001; partner bigint:=919000002; a jsonb; o jsonb; child public.pr_tbank_orders;
 body jsonb; expiry timestamptz; original_trial timestamptz; count_before integer;
begin
 perform public.pr_customer(partner);
 perform public.pr_customer(u,(select ref_code from public.pr_customers where user_id=partner));
 a:=public.pr_access(u);
 if a->>'tier'<>'pending' then raise exception 'trial_starts_too_early';end if;
 a:=public.pr_access(u,true);original_trial:=(a->>'trial_until')::timestamptz;
 if a->>'tier'<>'trial' or original_trial<>now()+interval '72 hours' then raise exception 'trial_duration';end if;
 perform public.pr_access(u,true);
 if (public.pr_access(u)->>'trial_until')::timestamptz<>original_trial then raise exception 'trial_reset';end if;
 update public.pr_customers set trial_expires_at=now() where user_id=u;
 a:=public.pr_access(u);
 if a->>'tier'<>'free' or (a->>'asset_limit')::int<>3 or a->>'allowed'<>'true' then raise exception 'free_boundary';end if;
 update public.pr_billing_settings set tbank_enabled=true where id=1;
 o:=public.pr_tbank_begin(u,'rub-weekly-v1');
 if o->>'id'<>public.pr_tbank_begin(u,'rub-weekly-v1')->>'id' then raise exception 'duplicate_checkout';end if;
 if public.pr_tbank_claim(o->>'id','init') is null or public.pr_tbank_claim(o->>'id','init') is not null then raise exception 'init_not_exclusive';end if;
 update public.pr_tbank_orders set payment_id='991001',provider_status='NEW' where id=o->>'id';
 body:=jsonb_build_object('OrderId',o->>'id','PaymentId','991001','Amount',29000,'Status','AUTHORIZED','Success',true,'RebillId','777888');
 perform public.pr_tbank_event(body);
 if public.pr_access(u)->>'tier'<>'free' then raise exception 'authorization_granted_access';end if;
 begin
  perform public.pr_tbank_event(body||'{"Status":"CONFIRMED","Amount":1}'::jsonb);
  raise exception 'bad_amount_accepted';
 exception when others then if sqlerrm<>'amount_mismatch' then raise;end if;end;
 perform public.pr_tbank_event(body||'{"Status":"CONFIRMED"}'::jsonb);
 expiry:=(public.pr_access(u)->>'paid_until')::timestamptz;
 if expiry<>now()+interval '168 hours' or public.pr_access(u)->>'tier'<>'paid' then raise exception 'paid_period';end if;
 perform public.pr_tbank_event(body||'{"Status":"CONFIRMED"}'::jsonb);
 if (public.pr_access(u)->>'paid_until')::timestamptz<>expiry then raise exception 'duplicate_extended_access';end if;
 if (select sum(amount_kopecks) from public.pr_rub_referrals where referred_id=u)<>5800 then raise exception 'referral_amount';end if;
 if public.pr_tbank_fail(o->>'id','racing_error') then raise exception 'failure_overrode_payment';end if;
 -- Make renewal due; the SQL scheduler must reserve one cycle even on two ticks.
 update public.pr_tbank_orders set period_until=now()-interval '1 second' where id=o->>'id';
 update public.pr_tbank_subscriptions set next_charge_at=now()-interval '1 second' where id=(o->>'subscription_id')::uuid;
 perform public.pr_tbank_due();perform public.pr_tbank_due();
 select * into child from public.pr_tbank_orders where subscription_id=(o->>'subscription_id')::uuid and cycle=1;
 if child.id is null or (select count(*) from public.pr_tbank_orders where subscription_id=child.subscription_id and cycle=1)<>1 then raise exception 'renewal_duplicate';end if;
 perform public.pr_tbank_claim(child.id,'init');
 update public.pr_tbank_orders set payment_id='991002' where id=child.id;
 if public.pr_tbank_claim(child.id,'charge')->>'rebill_id'<>'777888' or public.pr_tbank_claim(child.id,'charge') is not null then raise exception 'charge_not_exclusive';end if;
 perform public.pr_tbank_cancel(u);
 -- A debit already sent may confirm after cancellation, but must not re-enable renewal.
 perform public.pr_tbank_event(jsonb_build_object('OrderId',child.id,'PaymentId','991002','Amount',29000,'Status','CONFIRMED','Success',true));
 if (select renew_enabled from public.pr_tbank_subscriptions where id=child.subscription_id) then raise exception 'cancel_reversed';end if;
 if public.pr_access(u)->>'tier'<>'paid' then raise exception 'cancel_lost_paid_access';end if;
 if (select sum(amount_kopecks) from public.pr_rub_referrals where referred_id=u)<>11600 then raise exception 'renewal_referral';end if;
 perform public.pr_tbank_event(jsonb_build_object('OrderId',child.id,'PaymentId','991002','Amount',14500,'Status','PARTIAL_REFUNDED','Success',true));
 if (select amount_kopecks from public.pr_rub_referrals where order_id=child.id)<>2900 then raise exception 'partial_refund_ledger';end if;
 update public.pr_rub_referrals set available_at=now()-interval '1 day' where order_id=child.id;
 if public.pr_rub_record_payout(partner,array[child.id],'test-rub-payout')<>2900 then raise exception 'payout_amount';end if;
 if public.pr_rub_record_payout(partner,array[child.id],'test-rub-payout')<>2900 then raise exception 'payout_replay';end if;
 if (public.pr_rub_referral_stats(partner)->>'paid')::numeric<>29 then raise exception 'payout_stats';end if;
 perform public.pr_tbank_event(jsonb_build_object('OrderId',child.id,'PaymentId','991002','Amount',0,'Status','REFUNDED','Success',true));
 if public.pr_access(u)->>'tier'<>'free' then raise exception 'refund_kept_access';end if;
 if (public.pr_rub_referral_stats(partner)->>'adjustment')::numeric<>29 then raise exception 'payout_refund_adjustment';end if;
 perform public.pr_tbank_event(jsonb_build_object('OrderId',child.id,'PaymentId','991002','Amount',29000,'Status','CONFIRMED','Success',true));
 if public.pr_access(u)->>'tier'<>'free' then raise exception 'late_confirmation_undid_refund';end if;
 -- Cancelling before dispatch prevents both Init and Charge.
 o:=public.pr_tbank_begin(u,'rub-weekly-v1');perform public.pr_tbank_cancel(u);
 if public.pr_tbank_claim(o->>'id','init') is not null then raise exception 'cancelled_init';end if;
 -- Trial identity survives account deletion/recreation.
 perform public.pr_forget(u);perform public.pr_customer(u);perform public.pr_access(u,true);
 if public.pr_access(u)->>'tier'<>'free' then raise exception 'deletion_reset_trial';end if;
 if has_function_privilege('anon','public.pr_tbank_claim(text,text)','EXECUTE') or has_table_privilege('authenticated','public.pr_tbank_orders','SELECT') then raise exception 'payment_privileges';end if;
end $$;
rollback;
