-- Apply after schema.sql on a new installation, or once as a live migration.
-- No price is invented: checkout cannot open until an operator sets a price and enables it.
create table public.pr_billing_settings (
 id integer primary key check(id=1), enabled boolean not null default false,
 price_stars integer check(price_stars between 1 and 10000),
 asset_limit integer not null default 20 check(asset_limit between 1 and 500),
 trial_days integer not null default 7 check(trial_days between 0 and 30),
 referral_pct numeric not null default 20 check(referral_pct between 0 and 50),
 hold_days integer not null default 21 check(hold_days>=21),
 check(not enabled or price_stars is not null)
);
insert into public.pr_billing_settings(id) values(1);
-- Billing IDs survive deletion of portfolio data to reconcile renewals/refunds.
create table public.pr_customers (
 user_id bigint primary key check(user_id>0),
 ref_code text not null unique default replace(gen_random_uuid()::text,'-',''),
 referrer_id bigint references public.pr_customers(user_id),
 first_seen_at timestamptz not null default now(), trial_started_at timestamptz,
 check(referrer_id is distinct from user_id)
);
insert into public.pr_customers(user_id,first_seen_at) select chat_id,created_at from public.pr_users;
create index pr_customers_referrer on public.pr_customers(referrer_id);
create table public.pr_invoices (
 id uuid primary key default gen_random_uuid(), user_id bigint not null references public.pr_customers(user_id),
 price_stars integer not null check(price_stars between 1 and 10000), asset_limit integer not null,
 referral_pct numeric not null, hold_days integer not null,
 status text not null default 'open' check(status in ('open','paid')),
 expires_at timestamptz not null default now()+interval '1 hour',
 checkout_query text, checkout_until timestamptz,
 first_charge_id text, renewal_stopped boolean not null default false,
 created_at timestamptz not null default now()
);
create index pr_invoices_user on public.pr_invoices(user_id,created_at desc);
create table public.pr_payments (
 charge_id text primary key, invoice_id uuid not null references public.pr_invoices(id),
 user_id bigint not null references public.pr_customers(user_id), amount_stars integer not null,
 paid_at timestamptz not null, expires_at timestamptz not null,
 refunded boolean not null default false, created_at timestamptz not null default now()
);
create index pr_payments_access on public.pr_payments(user_id,expires_at desc) where not refunded;
create table public.pr_refunds (
 charge_id text primary key, invoice_id uuid not null references public.pr_invoices(id),
 user_id bigint not null, amount_stars integer not null, created_at timestamptz not null default now()
);
create table public.pr_referral_ledger (
 charge_id text primary key references public.pr_payments(charge_id),
 partner_id bigint not null references public.pr_customers(user_id),
 referred_id bigint not null references public.pr_customers(user_id),
 amount_stars numeric(18,4) not null check(amount_stars>=0),
 share_pct numeric not null, available_at timestamptz not null,
 reversed boolean not null default false,
 payout_reference text, paid_at timestamptz, created_at timestamptz not null default now(),
 check((payout_reference is null)=(paid_at is null))
);
create index pr_referral_ledger_partner on public.pr_referral_ledger(partner_id);
create table public.pr_usage (
 response_id text primary key, scope text not null, user_id bigint references public.pr_users(chat_id) on delete set null,
 asset_key text, model text not null, status text not null,
 input_tokens bigint not null, cached_tokens bigint not null, output_tokens bigint not null,
 search_calls integer not null, estimated_usd numeric(18,8) not null, created_at timestamptz not null default now()
);
create index pr_usage_date on public.pr_usage(created_at);

create function public.pr_customer(p_user bigint,p_ref text default null) returns void language plpgsql security invoker set search_path='' as $$
begin
 insert into public.pr_customers(user_id,referrer_id)
 values(p_user,(select user_id from public.pr_customers where ref_code=p_ref and user_id<>p_user))
 on conflict(user_id) do nothing; -- first touch is immutable, including organic signups.
end $$;
create function public.pr_access(p_user bigint,p_start_trial boolean default false) returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.pr_billing_settings; c public.pr_customers; paid timestamptz; trial timestamptz; lim integer;
begin
 select * into s from public.pr_billing_settings where id=1;
 select * into c from public.pr_customers where user_id=p_user for update;
 select max(expires_at) into paid from public.pr_payments where user_id=p_user and not refunded;
 if s.enabled and p_start_trial and c.trial_started_at is null and paid is null then
  update public.pr_customers set trial_started_at=now() where user_id=p_user returning * into c;
 end if;
 trial:=c.trial_started_at+make_interval(days=>s.trial_days);
 select max(i.asset_limit) into lim from public.pr_invoices i join public.pr_payments p on p.invoice_id=i.id where p.user_id=p_user and not p.refunded and p.expires_at>now();
 return jsonb_build_object('enabled',s.enabled,'allowed',not s.enabled or coalesce(paid>now(),false) or coalesce(trial>now(),false),
  'paid_until',paid,'trial_until',trial,'trial_days',s.trial_days,'price_stars',s.price_stars,
  'asset_limit',case when s.enabled then coalesce(lim,s.asset_limit) else 500 end,'manual_daily',case when s.enabled then 1 else 3 end);
end $$;
create function public.pr_create_invoice(p_user bigint) returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.pr_billing_settings; i public.pr_invoices;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found then raise exception 'customer_missing';end if;
 select * into s from public.pr_billing_settings where id=1;
 if not s.enabled then raise exception 'billing_disabled';end if;
 if exists(select 1 from public.pr_payments where user_id=p_user and not refunded and expires_at>now()) then raise exception 'subscription_active';end if;
 select * into i from public.pr_invoices where user_id=p_user and status='open' and expires_at>now() and price_stars=s.price_stars order by created_at desc limit 1;
 if not found then
  insert into public.pr_invoices(user_id,price_stars,asset_limit,referral_pct,hold_days) values(p_user,s.price_stars,s.asset_limit,s.referral_pct,s.hold_days) returning * into i;
 end if;
 return to_jsonb(i);
end $$;
create function public.pr_checkout(p_user bigint,p_invoice uuid,p_currency text,p_amount integer,p_query text) returns boolean language plpgsql security invoker set search_path='' as $$
declare i public.pr_invoices;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if not found or not (select enabled from public.pr_billing_settings where id=1) then return false;end if;
 select * into i from public.pr_invoices where id=p_invoice and user_id=p_user for update;
 if not found or p_currency is distinct from 'XTR' or p_amount is distinct from i.price_stars or nullif(p_query,'') is null or i.expires_at<=now() or i.status<>'open' then return false;end if;
 if exists(select 1 from public.pr_payments where user_id=p_user and not refunded and expires_at>now()) then return false;end if;
 if exists(select 1 from public.pr_invoices where user_id=p_user and checkout_until>now() and checkout_query is distinct from p_query) then return false;end if;
 update public.pr_invoices set checkout_query=p_query,checkout_until=now()+interval '10 minutes' where id=i.id;
 return true;
end $$;
create function public.pr_payment(p_user bigint,p_invoice uuid,p_charge text,p_currency text,p_amount integer,p_expiry bigint,p_paid bigint,p_recurring boolean,p_first boolean default false) returns jsonb language plpgsql security invoker set search_path='' as $$
declare i public.pr_invoices; ref bigint; rev boolean; n integer;
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 select * into i from public.pr_invoices where id=p_invoice and user_id=p_user for update;
 if not found or p_currency is distinct from 'XTR' or p_amount is distinct from i.price_stars or p_recurring is distinct from true or nullif(p_charge,'') is null or p_expiry is null or p_paid is null or p_expiry<=p_paid or p_expiry>p_paid+2678400 then raise exception 'invalid_payment';end if;
 if exists(select 1 from public.pr_payments where charge_id=p_charge and (user_id<>p_user or invoice_id<>i.id or amount_stars<>p_amount or expires_at<>to_timestamp(p_expiry))) then raise exception 'payment_conflict';end if;
 if exists(select 1 from public.pr_refunds where charge_id=p_charge and (user_id<>p_user or invoice_id<>i.id or amount_stars<>p_amount)) then raise exception 'refund_conflict';end if;
 rev:=exists(select 1 from public.pr_refunds where charge_id=p_charge);
 insert into public.pr_payments(charge_id,invoice_id,user_id,amount_stars,paid_at,expires_at,refunded)
 values(p_charge,i.id,p_user,p_amount,to_timestamp(p_paid),to_timestamp(p_expiry),rev) on conflict(charge_id) do nothing;
 get diagnostics n=row_count;
 if n=0 then return jsonb_build_object('duplicate',true);end if;
 update public.pr_invoices set status='paid',first_charge_id=case when p_first then p_charge else coalesce(first_charge_id,p_charge) end,checkout_until=null where id=i.id;
 select referrer_id into ref from public.pr_customers where user_id=p_user;
 if ref is not null then
  insert into public.pr_referral_ledger(charge_id,partner_id,referred_id,amount_stars,share_pct,available_at,reversed)
  values(p_charge,ref,p_user,p_amount*i.referral_pct/100,i.referral_pct,now()+make_interval(days=>i.hold_days),rev);
 end if;
 return jsonb_build_object('duplicate',false,'refunded',rev,'expires_at',to_timestamp(p_expiry));
end $$;
create function public.pr_refund(p_user bigint,p_invoice uuid,p_charge text,p_currency text,p_amount integer) returns void language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.pr_customers where user_id=p_user for update;
 if p_currency is distinct from 'XTR' or nullif(p_charge,'') is null or not exists(select 1 from public.pr_invoices where id=p_invoice and user_id=p_user and price_stars=p_amount) then raise exception 'invalid_refund';end if;
 if exists(select 1 from public.pr_payments where charge_id=p_charge and (user_id<>p_user or invoice_id<>p_invoice)) then raise exception 'refund_conflict';end if;
 if exists(select 1 from public.pr_refunds where charge_id=p_charge and (user_id<>p_user or invoice_id<>p_invoice or amount_stars<>p_amount)) then raise exception 'refund_conflict';end if;
 insert into public.pr_refunds(charge_id,invoice_id,user_id,amount_stars) values(p_charge,p_invoice,p_user,p_amount) on conflict(charge_id) do nothing;
 update public.pr_payments set refunded=true where charge_id=p_charge;
 update public.pr_referral_ledger set reversed=true where charge_id=p_charge;
end $$;
create function public.pr_referral_stats(p_user bigint) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('code',c.ref_code,'share_pct',(select referral_pct from public.pr_billing_settings where id=1),
 'invited',(select count(*) from public.pr_customers where referrer_id=p_user),
 'pending',coalesce((select sum(amount_stars) from public.pr_referral_ledger where partner_id=p_user and not reversed and paid_at is null and available_at>now()),0),
 'available',coalesce((select sum(amount_stars) from public.pr_referral_ledger where partner_id=p_user and not reversed and paid_at is null and available_at<=now()),0),
 'paid',coalesce((select sum(amount_stars) from public.pr_referral_ledger where partner_id=p_user and paid_at is not null),0),
 'adjustment',coalesce((select sum(amount_stars) from public.pr_referral_ledger where partner_id=p_user and reversed and paid_at is not null),0))
 from public.pr_customers c where c.user_id=p_user;
$$;
-- After an actual externally settled payout: record it once; never send money from this RPC.
create function public.pr_record_payout(p_partner bigint,p_charges text[],p_reference text) returns void language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.pr_customers where user_id=p_partner for update;
 if nullif(trim(p_reference),'') is null or coalesce(cardinality(p_charges),0)=0 then raise exception 'invalid_payout';end if;
 if exists(select 1 from unnest(p_charges) c left join public.pr_referral_ledger l on l.charge_id=c where l.charge_id is null or l.partner_id<>p_partner or l.reversed or l.available_at>now() or (l.payout_reference is not null and l.payout_reference<>p_reference)) then raise exception 'payout_not_available';end if;
 if exists(select 1 from public.pr_referral_ledger where partner_id=p_partner and reversed and paid_at is not null) then raise exception 'payout_adjustment_required';end if;
 update public.pr_referral_ledger set payout_reference=p_reference,paid_at=coalesce(paid_at,now()) where charge_id=any(p_charges);
end $$;

do $$ declare t text; f record; begin
 foreach t in array array['pr_billing_settings','pr_customers','pr_invoices','pr_payments','pr_refunds','pr_referral_ledger','pr_usage'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pr_customer','pr_access','pr_create_invoice','pr_checkout','pr_payment','pr_refund','pr_referral_stats','pr_record_payout') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- Paid access is checked before any daily research is scheduled.
create or replace function public.pr_daily_jobs() returns integer language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
 insert into public.pr_jobs(job_key,kind,payload,user_id)
 select 'daily:'||u.chat_id||':'||(now() at time zone u.timezone)::date,'digest',jsonb_build_object('chat_id',u.chat_id,'daily',true),u.chat_id
 from public.pr_users u where subscribed and (now() at time zone u.timezone)::time>=u.digest_time
 and (public.pr_access(u.chat_id)->>'allowed')::boolean
 and exists(select 1 from public.pr_accounts a where a.user_id=u.chat_id and jsonb_array_length(a.positions)>0)
 on conflict(job_key) do nothing;
 get diagnostics n=row_count;return n;
end $$;
create or replace function public.pr_cleanup() returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.pr_outbox set state='uncertain',last_error='delivery_status_unknown' where state='sending' and available_at<now()-interval '5 minutes';
 -- Retain unprocessed payment receipts for reconciliation, even after ordinary jobs expire.
 delete from public.pr_jobs where state in ('done','failed') and created_at<now()-interval '7 days'
 and not coalesce(payload->'message' ? 'successful_payment' or payload->'message' ? 'refunded_payment',false);
 delete from public.pr_outbox where state in ('sent','failed','uncertain') and created_at<now()-interval '7 days';
 delete from public.pr_cache where expires_at<now()-interval '2 days';
 update public.pr_imports set files='[]',status='cancelled',updated_at=now() where status in ('uploading','processing','preview') and created_at<now()-interval '1 day';
end $$;
