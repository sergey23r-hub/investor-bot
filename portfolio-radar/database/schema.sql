-- Portfolio Radar v0.1. Isolated objects; does not change Strategy tables.
create schema if not exists portfolio_private;
revoke all on schema portfolio_private from public, anon, authenticated;
grant usage on schema portfolio_private to service_role;

create table public.pr_users (
  chat_id bigint primary key check(chat_id>0),
  timezone text not null default 'Europe/Moscow',
  digest_time time not null default '22:00',
  subscribed boolean not null default false,
  current_account uuid,
  created_at timestamptz not null default now()
);
create table public.pr_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.pr_users(chat_id) on delete cascade,
  name text not null check(length(name) between 1 and 60),
  positions jsonb not null default '[]' check(jsonb_typeof(positions)='array'),
  version integer not null default 0,
  updated_at timestamptz not null default now(),
  unique(user_id,name)
);
create index pr_accounts_user on public.pr_accounts(user_id);
create table public.pr_imports (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.pr_users(chat_id) on delete cascade,
  account_id uuid not null references public.pr_accounts(id) on delete cascade,
  base_version integer not null,
  mode text not null default 'partial' check(mode in ('partial','replace')),
  status text not null default 'uploading' check(status in ('uploading','processing','preview','committed','cancelled')),
  files jsonb not null default '[]',
  rows jsonb not null default '[]',
  warnings jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pr_imports_open on public.pr_imports(user_id) where status in ('uploading','processing','preview');
create index pr_imports_account on public.pr_imports(account_id);
create index pr_imports_user_date on public.pr_imports(user_id,created_at desc);
create table public.pr_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.pr_accounts(id) on delete cascade,
  import_id uuid unique references public.pr_imports(id) on delete set null,
  before_positions jsonb not null,
  after_positions jsonb not null,
  version integer not null,
  created_at timestamptz not null default now()
);
create index pr_history_account on public.pr_history(account_id,created_at desc);
create table public.pr_jobs (
  id bigint generated always as identity primary key,
  job_key text not null unique,
  kind text not null check(kind in ('update','extract','research','digest')),
  user_id bigint references public.pr_users(chat_id) on delete cascade,
  payload jsonb not null,
  state text not null default 'pending' check(state in ('pending','running','done','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index pr_jobs_ready on public.pr_jobs(available_at,id) where state in ('pending','running');
create index pr_jobs_user on public.pr_jobs(user_id);
create table public.pr_outbox (
  id bigint generated always as identity primary key,
  dedup_key text not null unique,
  user_id bigint references public.pr_users(chat_id) on delete cascade,
  method text not null default 'sendMessage',
  body jsonb not null,
  state text not null default 'pending' check(state in ('pending','sending','sent','uncertain','failed')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  telegram_message_id bigint,
  last_error text,
  created_at timestamptz not null default now()
);
create index pr_outbox_ready on public.pr_outbox(available_at,id) where state in ('pending','sending');
create index pr_outbox_user on public.pr_outbox(user_id);
create table public.pr_cache(key text primary key,value jsonb not null,expires_at timestamptz not null);
create index pr_cache_expiry on public.pr_cache(expires_at);
create table portfolio_private.worker_lock(id integer primary key check(id=1), token uuid,expires_at timestamptz not null default '-infinity');
insert into portfolio_private.worker_lock(id) values(1);
alter table portfolio_private.worker_lock enable row level security;
grant select,update on portfolio_private.worker_lock to service_role;
create policy service_worker on portfolio_private.worker_lock to service_role using(true) with check(true);

-- Only the edge's service role can reach portfolio data. Telegram IDs are not browser auth.
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname='public' and tablename like 'pr\_%' escape '\' loop
    execute format('alter table public.%I enable row level security',r.tablename);
    execute format('revoke all on public.%I from public, anon, authenticated',r.tablename);
    execute format('grant all on public.%I to service_role',r.tablename);
  end loop;
end $$;
grant usage,select on sequence public.pr_jobs_id_seq, public.pr_outbox_id_seq to service_role;

-- Vault remains encrypted. Privileged lookup is in an unexposed schema and EXECUTE
-- is revoked from PUBLIC. Service-role RPC wrapper is an invoker, never public auth.
create function portfolio_private.read_config() returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(substring(name from 11),decrypted_secret),'{}'::jsonb)
  from vault.decrypted_secrets where name in ('portfolio_telegram_token','portfolio_openai_key','portfolio_coingecko_key','portfolio_finnhub_key','portfolio_webhook_secret','portfolio_worker_secret');
$$;
revoke all on function portfolio_private.read_config() from public,anon,authenticated;
grant execute on function portfolio_private.read_config() to service_role;
create function public.pr_config() returns jsonb language sql security invoker set search_path='' as $$ select portfolio_private.read_config(); $$;

create function public.pr_lock(p_token uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update portfolio_private.worker_lock set token=p_token,expires_at=now()+interval '150 seconds' where id=1 and expires_at<now();
  return found;
end $$;
create function public.pr_unlock(p_token uuid) returns void language sql security invoker set search_path='' as $$
 update portfolio_private.worker_lock set expires_at='-infinity',token=null where id=1 and token=p_token;
$$;
create function public.pr_enqueue(p_key text,p_kind text,p_payload jsonb,p_user bigint default null) returns void language sql security invoker set search_path='' as $$
 insert into public.pr_jobs(job_key,kind,payload,user_id) values(p_key,p_kind,p_payload,p_user) on conflict(job_key) do nothing;
$$;
create function public.pr_next_job() returns setof public.pr_jobs language sql security invoker set search_path='' as $$
 update public.pr_jobs set state='running',attempts=attempts+1,lease_until=now()+interval '150 seconds'
 where id=(select id from public.pr_jobs where (state='pending' and available_at<=now()) or (state='running' and lease_until<now()) order by case kind when 'update' then 0 when 'extract' then 1 when 'research' then 2 else 3 end,id for update skip locked limit 1)
 returning *;
$$;
create function public.pr_daily_jobs() returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into public.pr_jobs(job_key,kind,payload,user_id)
 select 'daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date,'digest',jsonb_build_object('chat_id',u.chat_id,'daily',true),u.chat_id
 from public.pr_users u where subscribed and (now() at time zone u.timezone)::time>=u.digest_time
 and exists(select 1 from public.pr_accounts a where a.user_id=u.chat_id and jsonb_array_length(a.positions)>0)
 on conflict(job_key) do nothing;
 get diagnostics n=row_count; return n;
end $$;
create function public.pr_commit(p_import uuid,p_user bigint) returns jsonb language plpgsql security invoker set search_path='' as $$
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
 if exists(select 1 from jsonb_array_elements(imp.rows) r where not coalesce((r->>'verified')::boolean,false) or r->>'key' is null or (r->>'quantity' is not null and r->>'quantity' !~ '^\d+(\.\d{1,18})?$')) then raise exception 'unresolved_rows';end if;
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
create function public.pr_forget(p_user bigint) returns void language plpgsql security invoker set search_path='' as $$
begin
 delete from public.pr_jobs where kind='update' and ((payload->'message'->'from'->>'id')::bigint=p_user or (payload->'callback_query'->'from'->>'id')::bigint=p_user);
 delete from public.pr_users where chat_id=p_user;
end $$;
-- Remove retryable raw updates / screenshots promptly; keep account history until user deletion.
create function public.pr_cleanup() returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.pr_outbox set state='uncertain',last_error='delivery_status_unknown' where state='sending' and available_at<now()-interval '5 minutes';
 delete from public.pr_jobs where state in ('done','failed') and created_at<now()-interval '7 days';
 delete from public.pr_outbox where state in ('sent','failed','uncertain') and created_at<now()-interval '7 days';
 delete from public.pr_cache where expires_at<now()-interval '2 days';
 update public.pr_imports set files='[]',status='cancelled',updated_at=now() where status in ('uploading','processing','preview') and created_at<now()-interval '1 day';
end $$;
do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pr\_%' escape '\' loop
   execute format('revoke all on function %s from public,anon,authenticated',r.signature);
   execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
-- Random internal authentication; values never committed to source control.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'portfolio_webhook_secret');
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'portfolio_worker_secret');
