-- Explicit acknowledgement permits retaining observations without verified instrument IDs.
drop function public.pr_commit(uuid,bigint);
create function public.pr_commit(p_import uuid,p_user bigint,p_allow_unresolved boolean default false) returns jsonb language plpgsql security invoker set search_path='' as $$
declare imp public.pr_imports; account public.pr_accounts; result jsonb; cnt integer;
begin
 select * into imp from public.pr_imports where id=p_import and user_id=p_user for update;
 if not found then raise exception 'import_not_found';end if;
 if imp.status='committed' then return jsonb_build_object('already_committed',true);end if;
 if imp.status<>'preview' then raise exception 'import_not_ready';end if;
 select * into account from public.pr_accounts where id=imp.account_id and user_id=p_user for update;
 if not found then raise exception 'account_not_found';end if;
 if account.version<>imp.base_version then raise exception 'stale_import';end if;
 if jsonb_array_length(imp.rows)=0 or jsonb_array_length(imp.rows)>100 then raise exception 'invalid_rows';end if;
 if exists(select 1 from jsonb_array_elements(imp.rows) r where (not coalesce(p_allow_unresolved,false) and not coalesce((r->>'verified')::boolean,false)) or nullif(r->>'name','') is null or nullif(r->>'key','') is null or (r->>'quantity' is not null and r->>'quantity' !~ '^\d+(\.\d{1,18})?$')) then raise exception 'unresolved_rows';end if;
 select count(distinct r->>'key') into cnt from jsonb_array_elements(imp.rows) r;
 if cnt<>jsonb_array_length(imp.rows) then raise exception 'duplicate_rows';end if;
 select coalesce(jsonb_agg(r),'[]') into result from (
   select r from jsonb_array_elements(account.positions) r where imp.mode='partial' and not exists(select 1 from jsonb_array_elements(imp.rows) n where n->>'key'=r->>'key')
   union all
   select r from jsonb_array_elements(imp.rows) r where r->>'quantity' is distinct from '0'
 ) combined;
 if jsonb_array_length(result)>100 then raise exception 'portfolio_limit';end if;
 insert into public.pr_history(account_id,import_id,before_positions,after_positions,version) values(account.id,imp.id,account.positions,result,account.version+1);
 update public.pr_accounts set positions=result,version=version+1,updated_at=now() where id=account.id;
 update public.pr_imports set status='committed',files='[]',updated_at=now() where id=imp.id;
 update public.pr_users set subscribed=true where chat_id=p_user;
 return jsonb_build_object('count',jsonb_array_length(result),'version',account.version+1);
end $$;
revoke all on function public.pr_commit(uuid,bigint,boolean) from public,anon,authenticated;
grant execute on function public.pr_commit(uuid,bigint,boolean) to service_role;
