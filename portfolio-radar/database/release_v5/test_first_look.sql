begin;
set local role service_role;
do $$
declare u bigint:=940000000021; a jsonb; b jsonb; first_job bigint;
begin
 insert into public.pr_users(chat_id,subscribed) values(u,true);
 perform public.pr_customer(u);
 if public.pr_initial_begin(u)->>'reason'<>'no_verified_assets' then raise exception 'empty_initial';end if;
 insert into public.pr_accounts(user_id,name,positions) values(u,'Test','[{"key":"test:asset","provider":"moex","verified":true}]');
 a:=public.pr_initial_begin(u);first_job:=(a->>'job_id')::bigint;
 b:=public.pr_initial_begin(u);
 if a->>'started'<>'true' or b->>'started'<>'false' or (b->>'job_id')::bigint<>first_job then raise exception 'initial_not_idempotent';end if;
 if (select count(*) from public.pr_jobs where job_key='initial:'||u)<>1 then raise exception 'duplicate_initial_job';end if;
 if public.pr_access(u)->>'tier'<>'pending' then raise exception 'initial_reset_trial';end if;
 begin
  perform public.pr_enqueue('fake:initial','digest','{"initial":true}',u);
  raise exception 'manual_digest_allowed';
 exception when others then if sqlerrm<>'manual_updates_disabled' then raise;end if;end;
 update public.pr_initial_reports set state='ready',asset_count=1,cached_assets=1,quote_count=1,news_count=1,finished_at=now() where user_id=u;
 insert into public.pr_product_events(dedup_key,user_id,event) values('first-test-upload',u,'upload_started'),('first-test-preview',u,'import_preview'),('first-test-delivered',u,'initial_delivered');
 a:=public.pr_product_metrics();
 if not (a ?& array['upload_users','preview_users','initial_delivered_users','initial_cached_assets']) then raise exception 'metrics_missing';end if;
 if has_function_privilege('anon','public.pr_initial_begin(bigint)','EXECUTE') or has_table_privilege('authenticated','public.pr_initial_reports','SELECT') then raise exception 'initial_public';end if;
 perform public.pr_forget(u);
 insert into public.pr_users(chat_id) values(u);
 insert into public.pr_accounts(user_id,name,positions) values(u,'Again','[{"key":"test:asset","provider":"moex","verified":true}]');
 b:=public.pr_initial_begin(u);
 if b->>'started'<>'false' or (b->>'job_id')::bigint<>first_job then raise exception 'deletion_reset_initial';end if;
end $$;
rollback;
