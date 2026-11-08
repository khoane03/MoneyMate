-- Two-person connections and single-use invitation tokens. Raw invitation tokens are never stored.
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  member_a_id uuid not null references auth.users(id) on delete cascade,
  member_b_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (member_a_id <> member_b_id),
  check (member_a_id < member_b_id),
  unique (member_a_id, member_b_id)
);
create index connections_member_a_idx on public.connections(member_a_id,status,created_at desc);
create index connections_member_b_idx on public.connections(member_b_id,status,created_at desc);

create table public.connection_invites (
  id uuid primary key default gen_random_uuid(),
  issuer_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open','redeemed','revoked')),
  expires_at timestamptz not null,
  redeemed_by uuid references auth.users(id) on delete set null,
  connection_id uuid references public.connections(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  check ((status = 'redeemed') = (redeemed_at is not null))
);
create index connection_invites_issuer_idx on public.connection_invites(issuer_id,created_at desc);
alter table public.connection_invites enable row level security;
alter table public.connections enable row level security;
create policy "connection member read" on public.connections for select to authenticated
  using (member_a_id = (select auth.uid()) or member_b_id = (select auth.uid()));
revoke all on public.connections, public.connection_invites from anon, authenticated;
grant select on public.connections to authenticated;

create or replace function public.is_active_connection_member(p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.connections c
    where c.id = p_connection_id and c.status = 'active'
      and (c.member_a_id = (select auth.uid()) or c.member_b_id = (select auth.uid()))
  );
$$;
revoke all on function public.is_active_connection_member(uuid) from public, anon;
grant execute on function public.is_active_connection_member(uuid) to authenticated;

create or replace function public.create_connection_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_invite public.connection_invites%rowtype;
  v_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_token is null or length(p_token) < 40 or length(p_token) > 128 then
    raise exception 'invalid invite token' using errcode = '22023';
  end if;
  if (select count(*) from public.connection_invites i
      where i.issuer_id = v_actor and i.created_at > now() - interval '24 hours') >= 5 then
    raise exception 'invite rate limit reached' using errcode = 'P0001';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  insert into public.connection_invites(issuer_id, token_hash, expires_at)
  values (v_actor, v_hash, now() + interval '48 hours')
  returning * into v_invite;
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
  values (v_actor,'connection_invite',v_invite.id,'created',v_hash);
  return jsonb_build_object('invite_id',v_invite.id,'expires_at',v_invite.expires_at);
end;
$$;

create or replace function public.redeem_connection_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_invite public.connection_invites%rowtype;
  v_hash text;
  v_member_a uuid;
  v_member_b uuid;
  v_connection public.connections%rowtype;
  v_created boolean := false;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_token is null or length(p_token) < 40 or length(p_token) > 128 then
    raise exception 'invalid invite token' using errcode = '22023';
  end if;
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  select * into v_invite from public.connection_invites where token_hash = v_hash for update;
  if not found or v_invite.status <> 'open' or v_invite.expires_at <= now() then
    raise exception 'invite is invalid or expired' using errcode = '22023';
  end if;
  if v_invite.issuer_id = v_actor then raise exception 'cannot redeem your own invite' using errcode = '42501'; end if;
  v_member_a := least(v_invite.issuer_id, v_actor);
  v_member_b := greatest(v_invite.issuer_id, v_actor);
  insert into public.connections(member_a_id,member_b_id)
  values (v_member_a,v_member_b)
  on conflict (member_a_id,member_b_id) do nothing
  returning * into v_connection;
  v_created := v_connection.id is not null;
  if not v_created then
    select * into v_connection from public.connections
      where member_a_id = v_member_a and member_b_id = v_member_b;
    if v_connection.status <> 'active' then
      update public.connections set status = 'active', revoked_at = null where id = v_connection.id returning * into v_connection;
    end if;
  end if;
  update public.connection_invites set status = 'redeemed', redeemed_by = v_actor,
    connection_id = v_connection.id, redeemed_at = now() where id = v_invite.id;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
  values (v_actor,v_connection.id,'connection',v_connection.id,case when v_created then 'created' else 'reconnected' end,v_hash);
  return jsonb_build_object('connection_id',v_connection.id,'partner_id',case when v_actor = v_member_a then v_member_b else v_member_a end,'created',v_created);
end;
$$;

create or replace function public.revoke_connection(p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_connection public.connections%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  update public.connections set status = 'revoked', revoked_at = now()
  where id = p_connection_id and status = 'active'
    and (member_a_id = v_actor or member_b_id = v_actor)
  returning * into v_connection;
  if not found then raise exception 'active connection unavailable' using errcode = '42501'; end if;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
  values (v_actor,v_connection.id,'connection',v_connection.id,'revoked',encode(extensions.digest(convert_to(v_connection.id::text,'UTF8'),'sha256'),'hex'));
  return jsonb_build_object('connection_id',v_connection.id,'status',v_connection.status);
end;
$$;

revoke all on function public.create_connection_invite(text) from public, anon;
revoke all on function public.redeem_connection_invite(text) from public, anon;
revoke all on function public.revoke_connection(uuid) from public, anon;
grant execute on function public.create_connection_invite(text) to authenticated;
grant execute on function public.redeem_connection_invite(text) to authenticated;
grant execute on function public.revoke_connection(uuid) to authenticated;
