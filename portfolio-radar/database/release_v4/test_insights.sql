-- Transactional integration checks: no fixtures, messages or payments are committed.
begin;
set local role service_role;
do $$
declare u bigint:=940000000001; other_user bigint:=940000000002; r jsonb; t text; n integer;
begin
 insert into public.pr_users(chat_id,subscribed) values(u,true),(other_user,false);
 perform public.pr_customer(u);perform public.pr_customer(other_user);
 r:=public.pr_qa_reserve(u,'v4-test-pending');
 if r->>'reason'<>'subscription' or public.pr_access(u)->>'tier'<>'pending' then raise exception 'question_started_trial';end if;
 perform public.pr_access(u,true);perform public.pr_access(other_user,true);
 update public.pr_customers set trial_expires_at=now()+interval '12 hours' where user_id=u;
 for n in 1..3 loop
  r:=public.pr_qa_reserve(u,'v4-test-'||n);
  if r->>'allowed'<>'true' or (r->>'remaining')::int<>3-n then raise exception 'quota_reservation';end if;
 end loop;
 update public.pr_qa_requests set state='completed',answer='Saved answer' where request_key='v4-test-1';
 r:=public.pr_qa_reserve(u,'v4-test-1');
 if r->>'reason'<>'duplicate' or r->>'answer'<>'Saved answer' then raise exception 'question_replay';end if;
 if public.pr_qa_reserve(u,'v4-test-4')->>'reason'<>'limit' then raise exception 'quota_exceeded';end if;
 if public.pr_qa_reserve(other_user,'v4-test-other')->>'allowed'<>'true' then raise exception 'quota_not_per_user';end if;
 perform public.pr_insights_maintenance();perform public.pr_insights_maintenance();
 if (select count(*) from public.pr_outbox where user_id=u and dedup_key like 'lifecycle:%')<>1 then raise exception 'trial_notice_duplicate';end if;
 if exists(select 1 from public.pr_outbox where user_id=other_user and dedup_key like 'lifecycle:%') then raise exception 'paused_user_notice';end if;
 insert into public.pr_reports(user_id,kind,service_day,snapshot) values(u,'daily',current_date,'{}');
 insert into public.pr_ui_sessions(user_id,mode,expires_at) values(u,'ask',now()+interval '5 minutes');
 insert into public.pr_product_events(dedup_key,user_id,event) values('v4-test-event',u,'report_open');
 r:=public.pr_product_metrics();
 if not (r ?& array['new_users','net_receipts_rub','ai_estimated_usd','failed_deliveries']) then raise exception 'metrics_shape';end if;
 foreach t in array array['pr_reports','pr_product_events','pr_qa_requests','pr_ui_sessions'] loop
  if has_table_privilege('anon','public.'||t,'SELECT') or has_table_privilege('authenticated','public.'||t,'SELECT') then raise exception 'public_table_access %',t;end if;
  if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass) then raise exception 'rls_disabled %',t;end if;
 end loop;
 if has_function_privilege('anon','public.pr_qa_reserve(bigint,text)','EXECUTE') or has_function_privilege('authenticated','public.pr_product_metrics()','EXECUTE') then raise exception 'public_rpc_access';end if;
 delete from public.pr_users where chat_id=u;
 if exists(select 1 from public.pr_reports where user_id=u) or exists(select 1 from public.pr_qa_requests where user_id=u) or exists(select 1 from public.pr_ui_sessions where user_id=u) then raise exception 'forgotten_user_data';end if;
 if not exists(select 1 from public.pr_product_events where dedup_key='v4-test-event' and user_id is null) then raise exception 'metrics_not_anonymized';end if;
end $$;
rollback;
