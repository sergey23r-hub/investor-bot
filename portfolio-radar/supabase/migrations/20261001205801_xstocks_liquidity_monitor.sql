-- Private LP positions; public sources are shared across customers.
create table public.pr_lp_profiles (
 user_id bigint primary key references public.pr_users(chat_id) on delete cascade,
 positions jsonb not null default '[]' check(jsonb_typeof(positions)='array' and jsonb_array_length(positions)<=30),
 version integer not null default 0, enabled boolean not null default true,
 updated_at timestamptz not null default now(), last_alert_at timestamptz
);
create table public.pr_lp_imports (
 id uuid primary key default gen_random_uuid(), user_id bigint not null references public.pr_users(chat_id) on delete cascade,
 base_version integer not null default 0,
 status text not null default 'uploading' check(status in ('uploading','processing','preview','committed','cancelled')),
 files jsonb not null default '[]', rows jsonb not null default '[]', warnings jsonb not null default '[]',
 extraction_key text, last_edit_key text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(jsonb_array_length(files)<=8), check(jsonb_array_length(rows)<=30)
);
create unique index pr_lp_one_import on public.pr_lp_imports(user_id) where status in ('uploading','processing','preview');
create index pr_lp_import_user_created on public.pr_lp_imports(user_id,created_at);
create index pr_lp_profile_positions on public.pr_lp_profiles using gin(positions jsonb_path_ops);
create table public.pr_lp_fetches (
 cache_key text not null, bucket timestamptz not null, state text not null check(state in ('working','done','failed')),
 value jsonb, created_at timestamptz not null default now(), primary key(cache_key,bucket)
);
create table public.pr_lp_market (
 symbol text primary key, data jsonb not null, updated_at timestamptz not null default now()
);
create index pr_lp_fetch_bucket on public.pr_lp_fetches(bucket);
create table public.pr_lp_events (
 id bigint generated always as identity primary key, user_id bigint references public.pr_users(chat_id) on delete cascade,
 event text not null check(event in ('open','upload','preview','saved','daily','alert','teaser','upgrade')),
 dedup_key text not null unique, created_at timestamptz not null default now()
);
create index pr_lp_event_created on public.pr_lp_events(created_at);
create table portfolio_private.lp_worker (
 id integer primary key check(id=1), token uuid, lease_until timestamptz
);
insert into portfolio_private.lp_worker(id) values(1);

alter table public.pr_lp_profiles enable row level security;
alter table public.pr_lp_imports enable row level security;
alter table public.pr_lp_fetches enable row level security;
alter table public.pr_lp_market enable row level security;
alter table public.pr_lp_events enable row level security;
alter table portfolio_private.lp_worker enable row level security;
revoke all on public.pr_lp_profiles,public.pr_lp_imports,public.pr_lp_fetches,public.pr_lp_market,public.pr_lp_events from anon,authenticated;
grant all on public.pr_lp_profiles,public.pr_lp_imports,public.pr_lp_fetches,public.pr_lp_market,public.pr_lp_events to service_role;
grant usage,select on sequence public.pr_lp_events_id_seq to service_role;
grant select,update on portfolio_private.lp_worker to service_role;

create function public.pr_lp_lock(p_token uuid) returns boolean language plpgsql set search_path='' as $$
declare n integer;
begin
 update portfolio_private.lp_worker set token=p_token,lease_until=now()+interval '4 minutes'
 where id=1 and (lease_until is null or lease_until<now());
 get diagnostics n=row_count;return n=1;
end $$;
create function public.pr_lp_unlock(p_token uuid) returns void language sql set search_path='' as $$
 update portfolio_private.lp_worker set token=null,lease_until=null where id=1 and token=p_token;
$$;
create function public.pr_lp_commit(p_user bigint,p_import uuid) returns jsonb language plpgsql set search_path='' as $$
declare i public.pr_lp_imports; v integer;
begin
 if public.pr_access(p_user)->>'tier'<>'paid' then raise exception 'lp_paid_required';end if;
 select * into i from public.pr_lp_imports where id=p_import and user_id=p_user for update;
 if not found then raise exception 'lp_import_missing';end if;
 if i.status='committed' then return jsonb_build_object('already_committed',true);end if;
 if i.status<>'preview' then raise exception 'lp_import_not_ready';end if;
 insert into public.pr_lp_profiles(user_id) values(p_user) on conflict do nothing;
 select version into v from public.pr_lp_profiles where user_id=p_user for update;
 if v<>i.base_version then raise exception 'stale_import';end if;
 update public.pr_lp_profiles set positions=i.rows,version=version+1,enabled=jsonb_array_length(i.rows)>0,updated_at=now() where user_id=p_user;
 update public.pr_lp_imports set status='committed',files='[]',updated_at=now() where id=i.id;
 update public.pr_users set subscribed=true where chat_id=p_user;
 return jsonb_build_object('saved',jsonb_array_length(i.rows));
end $$;
create function public.pr_lp_targets() returns jsonb language sql set search_path='' as $$
 select coalesce(jsonb_agg(distinct r->>'symbol'),'[]'::jsonb) from public.pr_lp_profiles p
 cross join lateral jsonb_array_elements(p.positions) r
 where p.enabled and r->>'symbol' is not null and public.pr_access(p.user_id)->>'tier'='paid';
$$;
create function public.pr_lp_due() returns table(user_id bigint,service_day date) language sql set search_path='' as $$
 select u.chat_id,(now() at time zone u.timezone)::date
 from public.pr_users u join public.pr_lp_profiles p on p.user_id=u.chat_id
 where u.subscribed and p.enabled and jsonb_array_length(p.positions)>0 and public.pr_access(u.chat_id)->>'tier'='paid'
 and (now() at time zone u.timezone)::time>=u.digest_time
 and not exists(select 1 from public.pr_outbox o where o.dedup_key='lp:daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date)
 order by u.chat_id limit 50;
$$;
create function public.pr_lp_maintenance() returns void language plpgsql set search_path='' as $$
begin
 update public.pr_lp_imports set status='cancelled',files='[]',rows='[]',warnings='[]' where status in ('uploading','processing','preview') and updated_at<now()-interval '24 hours';
 delete from public.pr_lp_imports where status in ('committed','cancelled') and updated_at<now()-interval '7 days';
 delete from public.pr_lp_fetches where bucket<now()-interval '8 days';
 delete from public.pr_lp_events where created_at<now()-interval '90 days';
end $$;
create function public.pr_lp_metrics() returns jsonb language sql set search_path='' as $$
 select jsonb_build_object(
 'profiles',(select count(*) from public.pr_lp_profiles where enabled),
 'tracked_assets',(select count(*) from public.pr_lp_market),
 'verified_pools',(select count(*) from public.pr_lp_market m cross join lateral jsonb_array_elements(m.data->'pools') p),
 'comparable_pools',(select count(*) from public.pr_lp_market m cross join lateral jsonb_array_elements(m.data->'pools') p where p->>'fee_apr24h' is not null and (p->>'observed_at')::timestamptz>now()-interval '4 hours'),
 'failed_sources_24h',(select count(*) from public.pr_lp_fetches where state='failed' and created_at>now()-interval '24 hours'),
 'events_30d',(select coalesce(jsonb_object_agg(event,n),'{}'::jsonb) from (select event,count(*) n from public.pr_lp_events where created_at>now()-interval '30 days' group by event) e));
$$;
revoke all on function public.pr_lp_lock(uuid),public.pr_lp_unlock(uuid),public.pr_lp_commit(bigint,uuid),public.pr_lp_targets(),public.pr_lp_due(),public.pr_lp_maintenance(),public.pr_lp_metrics() from public,anon,authenticated;
grant execute on function public.pr_lp_lock(uuid),public.pr_lp_unlock(uuid),public.pr_lp_commit(bigint,uuid),public.pr_lp_targets(),public.pr_lp_due(),public.pr_lp_maintenance(),public.pr_lp_metrics() to service_role;

-- Cron is enabled after the compatible runtime is deployed, in the release step.
