create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists private.loan_security_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  pin_verifier text,
  failed_pin_attempts integer not null default 0 check (failed_pin_attempts between 0 and 5),
  pin_locked_until timestamptz,
  updated_at timestamptz not null default now(),
  check ((failed_pin_attempts < 5) or pin_locked_until is not null)
);

create table if not exists private.loan_step_up_grants (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  method text not null check (method in ('password','pin','passkey')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
create index if not exists loan_step_up_grants_expiry_idx on private.loan_step_up_grants(expires_at);

create table if not exists private.loan_webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  purpose text not null check (purpose in ('register','authenticate')),
  challenge text not null check (char_length(challenge) between 32 and 256),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  consumed_at timestamptz
);
create index if not exists loan_webauthn_challenges_owner_idx on private.loan_webauthn_challenges(user_id,created_at desc);
revoke all on private.loan_security_settings,private.loan_step_up_grants,private.loan_webauthn_challenges from public,anon,authenticated;

create table if not exists public.loan_webauthn_credentials (
  credential_id text primary key check (char_length(credential_id) between 16 and 1024),
  owner_id uuid not null references auth.users(id) on delete cascade,
  public_key text not null check (char_length(public_key) between 32 and 4096),
  sign_count bigint not null default 0 check (sign_count >= 0),
  transports text[] not null default '{}',
  display_name text not null default 'Passkey' check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique(owner_id,credential_id)
);
create index if not exists loan_webauthn_credentials_owner_idx on public.loan_webauthn_credentials(owner_id,created_at);
alter table public.loan_webauthn_credentials enable row level security;
revoke all on public.loan_webauthn_credentials from public,anon,authenticated;
grant select,insert,update,delete on public.loan_webauthn_credentials to service_role;

create or replace function private.loan_step_up_is_valid(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.loan_step_up_grants g
    where g.user_id=p_user_id and g.session_id=p_session_id and g.expires_at>pg_catalog.now()
  );
$$;
revoke all on function private.loan_step_up_is_valid(uuid,uuid) from public,anon,authenticated;

create or replace function public.loan_security_access_granted()
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when (select auth.uid()) is null then false
    when not coalesce((select s.enabled from private.loan_security_settings s where s.user_id=(select auth.uid())),false) then true
    else private.loan_step_up_is_valid(
      (select auth.uid()),
      nullif((select auth.jwt()->>'session_id'),'')::uuid
    )
  end;
$$;
revoke all on function public.loan_security_access_granted() from public,anon;
grant execute on function public.loan_security_access_granted() to authenticated;

create or replace function public.loan_security_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_settings private.loan_security_settings%rowtype;
  v_passkey_count integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_settings from private.loan_security_settings where user_id=v_actor;
  select count(*)::integer into v_passkey_count from public.loan_webauthn_credentials where owner_id=v_actor;
  return jsonb_build_object(
    'enabled',coalesce(v_settings.enabled,false),
    'pinConfigured',v_settings.pin_verifier is not null,
    'passkeyCount',coalesce(v_passkey_count,0),
    'pinLocked',v_settings.pin_locked_until is not null and v_settings.pin_locked_until>pg_catalog.now()
  );
end;
$$;
revoke all on function public.loan_security_status() from public,anon;
grant execute on function public.loan_security_status() to authenticated;

create or replace function private.loan_require_recent_auth()
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_auth_time bigint := coalesce(
    nullif((select auth.jwt()->>'auth_time'),'')::bigint,
    nullif((select auth.jwt()->'amr'->-1->>'timestamp'),'')::bigint,
    nullif((select auth.jwt()->>'iat'),'')::bigint
  );
begin
  if v_auth_time is null or v_auth_time > pg_catalog.date_part('epoch',pg_catalog.now())::bigint + 30
    or v_auth_time < pg_catalog.date_part('epoch',pg_catalog.now())::bigint - 300 then
    raise exception 'recent password authentication required' using errcode='42501';
  end if;
end;
$$;
revoke all on function private.loan_require_recent_auth() from public,anon,authenticated;

create or replace function private.loan_grant_current_session(p_method text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_session uuid := nullif((select auth.jwt()->>'session_id'),'')::uuid;
begin
  if v_actor is null or v_session is null then raise exception 'authenticated session required' using errcode='28000'; end if;
  delete from private.loan_step_up_grants where expires_at<=pg_catalog.now();
  insert into private.loan_step_up_grants(user_id,session_id,method,expires_at)
  values(v_actor,v_session,p_method,pg_catalog.now()+interval '2 minutes')
  on conflict(user_id,session_id) do update set method=excluded.method,expires_at=excluded.expires_at,created_at=pg_catalog.now();
end;
$$;
revoke all on function private.loan_grant_current_session(text) from public,anon,authenticated;

create or replace function public.set_loan_security_pin(p_pin text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid());
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  perform private.loan_require_recent_auth();
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN must contain exactly six digits' using errcode='22023';
  end if;
  insert into private.loan_security_settings(user_id,enabled,pin_verifier,failed_pin_attempts,pin_locked_until,updated_at)
  values(v_actor,true,extensions.crypt(p_pin,extensions.gen_salt('bf',12)),0,null,pg_catalog.now())
  on conflict(user_id) do update set enabled=true,pin_verifier=excluded.pin_verifier,
    failed_pin_attempts=0,pin_locked_until=null,updated_at=pg_catalog.now();
  delete from private.loan_step_up_grants where user_id=v_actor;
  perform private.loan_grant_current_session('password');
end;
$$;
revoke all on function public.set_loan_security_pin(text) from public,anon;
grant execute on function public.set_loan_security_pin(text) to authenticated;

create or replace function public.unlock_loans_with_pin(p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_settings private.loan_security_settings%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    return jsonb_build_object('unlocked',false,'locked',false);
  end if;
  select * into v_settings from private.loan_security_settings where user_id=v_actor for update;
  if not found or not v_settings.enabled or v_settings.pin_verifier is null then
    raise exception 'PIN is not configured' using errcode='42501';
  end if;
  if v_settings.pin_locked_until is not null and v_settings.pin_locked_until>pg_catalog.now() then
    return jsonb_build_object('unlocked',false,'locked',true);
  end if;
  if extensions.crypt(p_pin,v_settings.pin_verifier) is distinct from v_settings.pin_verifier then
    declare
      v_is_locked boolean := (
        (v_settings.pin_locked_until is not null and v_settings.pin_locked_until > pg_catalog.now())
        or v_settings.failed_pin_attempts >= 4
      );
    begin
      update private.loan_security_settings
        set failed_pin_attempts=case
              when pin_locked_until is not null and pin_locked_until<=pg_catalog.now() then 1
              when failed_pin_attempts>=4 then 5
              else failed_pin_attempts+1 end,
            pin_locked_until=case
              when pin_locked_until is not null and pin_locked_until<=pg_catalog.now() then null
              when failed_pin_attempts>=4 then pg_catalog.now()+interval '5 minutes'
              else null end,
            updated_at=pg_catalog.now()
        where user_id=v_actor;
      return jsonb_build_object(
        'unlocked',false,
        'locked',v_is_locked
      );
    end;
  end if;
  update private.loan_security_settings set failed_pin_attempts=0,pin_locked_until=null,updated_at=pg_catalog.now()
    where user_id=v_actor;
  perform private.loan_grant_current_session('pin');
  return jsonb_build_object('unlocked',true,'locked',false);
end;
$$;
revoke all on function public.unlock_loans_with_pin(text) from public,anon;
grant execute on function public.unlock_loans_with_pin(text) to authenticated;

create or replace function public.unlock_loans_with_password()
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid());
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  perform private.loan_require_recent_auth();
  if not coalesce((select enabled from private.loan_security_settings where user_id=v_actor),false) then
    raise exception 'loan security is not enabled' using errcode='42501';
  end if;
  perform private.loan_grant_current_session('password');
end;
$$;
revoke all on function public.unlock_loans_with_password() from public,anon;
grant execute on function public.unlock_loans_with_password() to authenticated;

create or replace function public.disable_loan_security()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  perform private.loan_require_recent_auth();
  update private.loan_security_settings set enabled=false,failed_pin_attempts=0,pin_locked_until=null,updated_at=pg_catalog.now()
    where user_id=v_actor;
  delete from private.loan_step_up_grants where user_id=v_actor;
end;
$$;
revoke all on function public.disable_loan_security() from public,anon;
grant execute on function public.disable_loan_security() to authenticated;

create or replace function public.lock_loans_now()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_session uuid := nullif((select auth.jwt()->>'session_id'),'')::uuid;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  delete from private.loan_step_up_grants where user_id=v_actor and session_id=v_session;
end;
$$;
revoke all on function public.lock_loans_now() from public,anon;
grant execute on function public.lock_loans_now() to authenticated;

create or replace function public.extend_loan_step_up()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_session uuid := nullif((select auth.jwt()->>'session_id'),'')::uuid;
begin
  if v_actor is null or v_session is null then return false; end if;
  update private.loan_step_up_grants set expires_at=pg_catalog.now()+interval '2 minutes'
    where user_id=v_actor and session_id=v_session and expires_at>pg_catalog.now()
      and coalesce((select enabled from private.loan_security_settings where user_id=v_actor),false);
  return found;
end;
$$;
revoke all on function public.extend_loan_step_up() from public,anon;
grant execute on function public.extend_loan_step_up() to authenticated;

create or replace function public.create_loan_webauthn_challenge(p_challenge text,p_purpose text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_session uuid := nullif((select auth.jwt()->>'session_id'),'')::uuid;
  v_auth_time bigint := coalesce(
    nullif((select auth.jwt()->>'auth_time'),'')::bigint,
    nullif((select auth.jwt()->'amr'->-1->>'timestamp'),'')::bigint,
    nullif((select auth.jwt()->>'iat'),'')::bigint
  );
  v_id uuid;
begin
  if v_actor is null or v_session is null then raise exception 'authenticated session required' using errcode='28000'; end if;
  if p_challenge is null or char_length(p_challenge)<32 or char_length(p_challenge)>256
    or p_purpose not in ('register','authenticate') then raise exception 'invalid challenge' using errcode='22023'; end if;
  if p_purpose='register' and (v_auth_time is null or v_auth_time<pg_catalog.date_part('epoch',pg_catalog.now())::bigint-300) then
    raise exception 'recent password authentication required' using errcode='42501';
  end if;
  if p_purpose='authenticate' and not coalesce((select enabled from private.loan_security_settings where user_id=v_actor),false) then
    raise exception 'loan security is not enabled' using errcode='42501';
  end if;
  delete from private.loan_webauthn_challenges where user_id=v_actor and (expires_at<pg_catalog.now() or consumed_at is not null);
  if (select count(*) from private.loan_webauthn_challenges where user_id=v_actor and created_at>pg_catalog.now()-interval '1 minute')>=10 then
    raise exception 'challenge rate limit exceeded' using errcode='42900';
  end if;
  insert into private.loan_webauthn_challenges(user_id,session_id,purpose,challenge)
    values(v_actor,v_session,p_purpose,p_challenge) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_loan_webauthn_challenge(text,text) from public,anon;
grant execute on function public.create_loan_webauthn_challenge(text,text) to authenticated;

create or replace function public.consume_loan_webauthn_challenge(p_challenge_id uuid,p_purpose text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_session uuid := nullif((select auth.jwt()->>'session_id'),'')::uuid;
  v_challenge text;
begin
  if v_actor is null or v_session is null then raise exception 'authenticated session required' using errcode='28000'; end if;
  update private.loan_webauthn_challenges set consumed_at=pg_catalog.now()
    where id=p_challenge_id and user_id=v_actor and session_id=v_session and purpose=p_purpose
      and consumed_at is null and expires_at>pg_catalog.now()
    returning challenge into v_challenge;
  if v_challenge is null then raise exception 'challenge expired or already used' using errcode='42501'; end if;
  return v_challenge;
end;
$$;
revoke all on function public.consume_loan_webauthn_challenge(uuid,text) from public,anon;
grant execute on function public.consume_loan_webauthn_challenge(uuid,text) to authenticated;

create or replace function public.grant_loan_step_up_internal(p_actor uuid,p_session_id uuid,p_method text,p_enable boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role())<>'service_role' then raise exception 'service role required' using errcode='42501'; end if;
  if p_actor is null or p_session_id is null or p_method not in ('passkey') then
    raise exception 'invalid step-up grant' using errcode='22023';
  end if;
  if p_enable then
    insert into private.loan_security_settings(user_id,enabled,updated_at) values(p_actor,true,pg_catalog.now())
      on conflict(user_id) do update set enabled=true,updated_at=pg_catalog.now();
    delete from private.loan_step_up_grants where user_id=p_actor;
  elsif not coalesce((select enabled from private.loan_security_settings where user_id=p_actor),false) then
    raise exception 'loan security is not enabled' using errcode='42501';
  end if;
  insert into private.loan_step_up_grants(user_id,session_id,method,expires_at)
    values(p_actor,p_session_id,p_method,pg_catalog.now()+interval '2 minutes')
    on conflict(user_id,session_id) do update set method=excluded.method,expires_at=excluded.expires_at,created_at=pg_catalog.now();
end;
$$;
revoke all on function public.grant_loan_step_up_internal(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.grant_loan_step_up_internal(uuid,uuid,text,boolean) to service_role;

create or replace function public.loan_security_is_recently_authenticated()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    coalesce(
      nullif((select auth.jwt()->>'auth_time'),'')::bigint,
      nullif((select auth.jwt()->'amr'->-1->>'timestamp'),'')::bigint,
      nullif((select auth.jwt()->>'iat'),'')::bigint
    ) >= pg_catalog.date_part('epoch',pg_catalog.now())::bigint-300,
    false
  );
$$;
revoke all on function public.loan_security_is_recently_authenticated() from public,anon,authenticated;
grant execute on function public.loan_security_is_recently_authenticated() to service_role;

create or replace function private.loan_data_access_allowed()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.loan_security_access_granted();
$$;
revoke all on function private.loan_data_access_allowed() from public,anon;
grant execute on function private.loan_data_access_allowed() to authenticated;

drop policy if exists "transaction owner all" on public.transactions;
drop policy if exists "transaction owner reads with loan step-up" on public.transactions;
create policy "transaction owner reads with loan step-up" on public.transactions
  for select to authenticated using (
    owner_id=(select auth.uid())
    and (kind not in ('borrowed_funds','loan_principal_payment') or private.loan_data_access_allowed())
  );

drop policy if exists "transaction owner inserts own" on public.transactions;
create policy "transaction owner inserts own" on public.transactions
  for insert to authenticated with check (owner_id=(select auth.uid()));

drop policy if exists "transaction owner updates own" on public.transactions;
create policy "transaction owner updates own" on public.transactions
  for update to authenticated using (
    owner_id=(select auth.uid())
    and (kind not in ('borrowed_funds','loan_principal_payment') or private.loan_data_access_allowed())
  ) with check (
    owner_id=(select auth.uid())
    and (kind not in ('borrowed_funds','loan_principal_payment') or private.loan_data_access_allowed())
  );

drop policy if exists "transaction owner deletes own" on public.transactions;
create policy "transaction owner deletes own" on public.transactions
  for delete to authenticated using (
    owner_id=(select auth.uid())
    and (kind not in ('borrowed_funds','loan_principal_payment') or private.loan_data_access_allowed())
  );

drop policy if exists "loan participants read explicitly shared loans" on public.shared_personal_loans;
create policy "loan participants read explicitly shared loans" on public.shared_personal_loans
  for select to authenticated using (
    (select auth.uid()) in (borrower_user_id,counterparty_user_id)
    and private.loan_data_access_allowed()
    and public.is_active_connection_member(connection_id)
    and exists(select 1 from public.connection_members m where m.connection_id=shared_personal_loans.connection_id and m.user_id=shared_personal_loans.borrower_user_id)
    and exists(select 1 from public.connection_members m where m.connection_id=shared_personal_loans.connection_id and m.user_id=shared_personal_loans.counterparty_user_id)
  );

drop policy if exists "loan participants read shared repayments" on public.shared_personal_loan_payments;
create policy "loan participants read shared repayments" on public.shared_personal_loan_payments
  for select to authenticated using (
    private.loan_data_access_allowed()
    and exists(select 1 from public.shared_personal_loans l where l.id=shared_loan_id)
  );

drop policy if exists "shared loan participants read repayment evidence" on public.shared_loan_payment_evidence;
drop policy if exists "shared loan participants read repayment evidence with loan step-up" on public.shared_loan_payment_evidence;
create policy "shared loan participants read repayment evidence with loan step-up" on public.shared_loan_payment_evidence
  for select to authenticated using (
    private.loan_data_access_allowed()
    and exists(select 1 from public.shared_personal_loan_payments p join public.shared_personal_loans l on l.id=p.shared_loan_id
      where p.id=shared_payment_id and public.is_active_connection_member(l.connection_id))
  );

drop policy if exists "transaction owner reads evidence" on public.transaction_evidence;
drop policy if exists "transaction owner reads evidence with loan step-up" on public.transaction_evidence;
create policy "transaction owner reads evidence with loan step-up" on public.transaction_evidence
  for select to authenticated using (
    owner_id=(select auth.uid())
    and exists(select 1 from public.transactions t where t.id=transaction_id and t.owner_id=(select auth.uid())
      and (t.kind not in ('borrowed_funds','loan_principal_payment') or private.loan_data_access_allowed()))
  );

comment on table private.loan_security_settings is 'Private app-level step-up configuration; never contains raw PINs or passwords.';
comment on table private.loan_step_up_grants is 'Short-lived grants scoped to a verified Supabase Auth session.';
comment on table public.loan_webauthn_credentials is 'Passkey public credentials; private keys and biometric templates remain on the authenticator.';
