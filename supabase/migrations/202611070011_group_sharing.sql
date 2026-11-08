-- Existing pair connections become groups with two seeded members; new invites can add up to 20.
create table public.connection_members (
  connection_id uuid not null references public.connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Thành viên' check(char_length(display_name) between 1 and 80),
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (connection_id,user_id)
);
create index connection_members_user_idx on public.connection_members(user_id,connection_id);
insert into public.connection_members(connection_id,user_id,role,joined_at)
select id,member_a_id,'owner',created_at from public.connections
union all
select id,member_b_id,'member',created_at from public.connections
on conflict do nothing;
update public.connection_members m set display_name=coalesce(nullif(trim(p.display_name),''),'Thành viên')
from public.profiles p where p.user_id=m.user_id;

create or replace function public.seed_connection_members()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.connection_members(connection_id,user_id,display_name,role)
  select new.id,x.user_id,coalesce(nullif(trim(p.display_name),''),'Thành viên'),x.role
  from (values(new.member_a_id,'owner'),(new.member_b_id,'member')) x(user_id,role)
  left join public.profiles p on p.user_id=x.user_id on conflict do nothing;
  return new;
end;
$$;

create or replace function public.leave_connection(p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_role text; v_remaining integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  perform 1 from public.connections where id=p_connection_id and status='active' for update;
  if not found then raise exception 'active connection unavailable' using errcode='42501'; end if;
  select role into v_role from public.connection_members where connection_id=p_connection_id and user_id=v_actor for update;
  if not found then raise exception 'active connection unavailable' using errcode='42501'; end if;
  if v_role='owner' then raise exception 'group owner must close the group before leaving' using errcode='42501'; end if;
  delete from public.connection_members where connection_id=p_connection_id and user_id=v_actor;
  update public.shared_expenses set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending';
  update public.settlements set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending' and (payer_id=v_actor or receiver_id=v_actor);
  update public.payment_requests set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending' and (requester_id=v_actor or payer_id=v_actor);
  update public.direct_debts set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending' and (created_by=v_actor or creditor_id=v_actor or debtor_id=v_actor);
  select count(*) into v_remaining from public.connection_members where connection_id=p_connection_id;
  if v_remaining<2 then update public.connections set status='revoked',revoked_at=now() where id=p_connection_id; end if;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,p_connection_id,'connection',p_connection_id,'member_left',encode(extensions.digest(convert_to(v_actor::text||':'||p_connection_id::text,'UTF8'),'sha256'),'hex'));
  return jsonb_build_object('connection_id',p_connection_id,'status',case when v_remaining<2 then 'revoked' else 'active' end);
end;
$$;
revoke all on function public.leave_connection(uuid) from public,anon;
grant execute on function public.leave_connection(uuid) to authenticated;
create or replace function public.revoke_connection(p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_connection public.connections%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  update public.connections set status='revoked',revoked_at=now() where id=p_connection_id and status='active'
    and exists(select 1 from public.connection_members where connection_id=p_connection_id and user_id=v_actor and role='owner') returning * into v_connection;
  if not found then raise exception 'only the group owner can close this space' using errcode='42501'; end if;
  update public.shared_expenses set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending';
  update public.settlements set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending';
  update public.payment_requests set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending';
  update public.direct_debts set status='cancelled',version=version+1 where connection_id=p_connection_id and status='pending';
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,p_connection_id,'connection',p_connection_id,'revoked',encode(extensions.digest(convert_to(p_connection_id::text,'UTF8'),'sha256'),'hex'));
  return jsonb_build_object('connection_id',p_connection_id,'status','revoked');
end;
$$;
revoke all on function public.revoke_connection(uuid) from public,anon;
grant execute on function public.revoke_connection(uuid) to authenticated;
create trigger connections_seed_members after insert on public.connections
for each row execute function public.seed_connection_members();

alter table public.connection_members enable row level security;
revoke all on public.connection_members from anon,authenticated;
grant select on public.connection_members to authenticated;
create or replace function public.is_active_connection_member(p_connection_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.connections c join public.connection_members m on m.connection_id=c.id
    where c.id=p_connection_id and c.status='active' and m.user_id=(select auth.uid()));
$$;
revoke all on function public.is_active_connection_member(uuid) from public,anon;
grant execute on function public.is_active_connection_member(uuid) to authenticated;
create policy "members read own shared space roster" on public.connection_members for select to authenticated
  using (public.is_active_connection_member(connection_id));
drop policy if exists "connection member read" on public.connections;
create policy "connection member read" on public.connections for select to authenticated
  using (public.is_active_connection_member(id));

alter table public.connection_invites add column target_connection_id uuid references public.connections(id) on delete cascade;

create or replace function public.create_connection_member_invite(p_token text,p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_hash text; v_invite public.connection_invites%rowtype; v_count integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_token is null or length(p_token)<40 or length(p_token)>128 then raise exception 'invalid invite token' using errcode='22023'; end if;
  perform 1 from public.connections where id=p_connection_id and status='active' and public.is_active_connection_member(id) for update;
  if not found then raise exception 'active connection unavailable' using errcode='42501'; end if;
  select count(*) into v_count from public.connection_members where connection_id=p_connection_id;
  if v_count>=20 then raise exception 'shared space member limit reached' using errcode='22023'; end if;
  if (select count(*) from public.connection_invites where issuer_id=v_actor and created_at>now()-interval '24 hours')>=5 then raise exception 'invite rate limit reached' using errcode='P0001'; end if;
  v_hash:=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  insert into public.connection_invites(issuer_id,token_hash,expires_at,target_connection_id)
    values(v_actor,v_hash,now()+interval '48 hours',p_connection_id) returning * into v_invite;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,p_connection_id,'connection_invite',v_invite.id,'member_invite_created',v_hash);
  return jsonb_build_object('invite_id',v_invite.id,'expires_at',v_invite.expires_at,'connection_id',p_connection_id);
end;
$$;
revoke all on function public.create_connection_member_invite(text,uuid) from public,anon;
grant execute on function public.create_connection_member_invite(text,uuid) to authenticated;

create or replace function public.redeem_connection_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_invite public.connection_invites%rowtype; v_hash text;
  v_a uuid; v_b uuid; v_connection public.connections%rowtype; v_created boolean:=false; v_count integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_token is null or length(p_token)<40 or length(p_token)>128 then raise exception 'invalid invite token' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex');
  select * into v_invite from public.connection_invites where token_hash=v_hash for update;
  if not found or v_invite.status<>'open' or v_invite.expires_at<=now() then raise exception 'invite is invalid or expired' using errcode='22023'; end if;
  if v_invite.issuer_id=v_actor then raise exception 'cannot redeem your own invite' using errcode='42501'; end if;
  if v_invite.target_connection_id is not null then
    select * into v_connection from public.connections where id=v_invite.target_connection_id and status='active' for update;
    if not found then raise exception 'active connection unavailable' using errcode='42501'; end if;
    if not exists(select 1 from public.connection_members where connection_id=v_connection.id and user_id=v_invite.issuer_id) then raise exception 'invite is invalid or expired' using errcode='42501'; end if;
    select count(*) into v_count from public.connection_members where connection_id=v_connection.id;
    if v_count>=20 then raise exception 'shared space member limit reached' using errcode='22023'; end if;
    insert into public.connection_members(connection_id,user_id,display_name)
      select v_connection.id,v_actor,coalesce(nullif(trim(p.display_name),''),'Thành viên') from public.profiles p where p.user_id=v_actor
      on conflict do nothing;
    if not found then raise exception 'already a member of this shared space' using errcode='23505'; end if;
  else
    v_a:=least(v_invite.issuer_id,v_actor); v_b:=greatest(v_invite.issuer_id,v_actor);
    insert into public.connections(member_a_id,member_b_id) values(v_a,v_b)
      on conflict(member_a_id,member_b_id) do nothing returning * into v_connection;
    v_created:=v_connection.id is not null;
    if not v_created then
      select * into v_connection from public.connections where member_a_id=v_a and member_b_id=v_b;
      if v_connection.status<>'active' then update public.connections set status='active',revoked_at=null where id=v_connection.id returning * into v_connection; end if;
    end if;
    if v_created then update public.connection_members set role=case when user_id=v_invite.issuer_id then 'owner' else 'member' end where connection_id=v_connection.id; end if;
  end if;
  update public.connection_invites set status='redeemed',redeemed_by=v_actor,connection_id=v_connection.id,redeemed_at=now() where id=v_invite.id;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_connection.id,'connection',v_connection.id,case when v_invite.target_connection_id is not null then 'member_joined' when v_created then 'created' else 'reconnected' end,v_hash);
  return jsonb_build_object('connection_id',v_connection.id,'created',v_created);
end;
$$;

alter table public.obligation_ledger drop constraint if exists obligation_ledger_source_type_source_id_key;
alter table public.obligation_ledger add constraint obligation_ledger_source_parties_key
  unique(source_type,source_id,debtor_id,creditor_id);

create table public.shared_expense_approvals (
  expense_id uuid not null references public.shared_expenses(id) on delete restrict,
  participant_id uuid not null references auth.users(id) on delete restrict,
  approved_at timestamptz not null default now(),
  primary key(expense_id,participant_id)
);
alter table public.shared_expense_approvals enable row level security;
revoke all on public.shared_expense_approvals from anon,authenticated;
grant select on public.shared_expense_approvals to authenticated;
create policy "members read expense approvals" on public.shared_expense_approvals for select to authenticated
  using(exists(select 1 from public.shared_expenses e where e.id=expense_id and public.is_active_connection_member(e.connection_id)));

create or replace function public.create_shared_group_expense(
  p_connection_id uuid,p_wallet_id uuid,p_description text,p_occurred_at timestamptz,p_accounting_date date,
  p_category_id uuid,p_items jsonb,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_expense public.shared_expenses%rowtype; v_existing public.shared_expenses%rowtype;
  v_item jsonb; v_alloc jsonb; v_item_id uuid; v_name text; v_qty numeric; v_price bigint; v_total bigint; v_alloc_total numeric;
  v_bill numeric:=0; v_position integer:=0; v_hash text; v_payload jsonb; v_alloc_count integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_connection_id is null or p_wallet_id is null or p_idempotency_key is null or p_occurred_at is null or p_accounting_date is null
    or char_length(trim(coalesce(p_description,''))) not between 1 and 200 or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'invalid shared expense values' using errcode='22023'; end if;
  perform 1 from public.connections where id=p_connection_id and status='active' and public.is_active_connection_member(id) for key share;
  if not found then raise exception 'active connection unavailable' using errcode='42501'; end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then raise exception 'payer wallet unavailable' using errcode='42501'; end if;
  if p_category_id is not null and not exists(select 1 from public.categories where id=p_category_id and kind='expense' and (owner_id is null or owner_id=v_actor)) then raise exception 'expense category unavailable' using errcode='42501'; end if;
  v_payload:=jsonb_build_object('connection_id',p_connection_id,'wallet_id',p_wallet_id,'description',trim(p_description),'occurred_at',p_occurred_at,'accounting_date',p_accounting_date,'category_id',p_category_id,'items',p_items);
  v_hash:=encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.shared_expenses where created_by=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode='23505'; end if;
    return jsonb_build_object('id',v_existing.id,'total',v_existing.total_bigint::text,'status',v_existing.status,'created',false);
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_name:=trim(coalesce(v_item->>'name','')); v_qty:=coalesce(nullif(v_item->>'quantity','')::numeric,1); v_price:=(v_item->>'unit_price')::bigint;
    v_total:=round(v_qty*v_price)::bigint;
    if char_length(v_name) not between 1 and 120 or v_qty<=0 or v_qty>1000000 or v_qty<>round(v_qty,3) or v_price<=0 or v_total<=0
      or jsonb_typeof(v_item->'allocations')<>'array' or jsonb_array_length(v_item->'allocations') not between 1 and 20 then raise exception 'invalid shared expense item' using errcode='22023'; end if;
    select sum((x->>'amount')::numeric),count(*) into v_alloc_total,v_alloc_count from jsonb_array_elements(v_item->'allocations') x;
    if v_alloc_total<>v_total or v_alloc_count<>(select count(distinct x->>'participant_id') from jsonb_array_elements(v_item->'allocations') x) then raise exception 'item allocations must exactly match total and have unique members' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(v_item->'allocations') x where nullif(x->>'amount','') is null
      or (x->>'amount')::numeric<>trunc((x->>'amount')::numeric) or (x->>'amount')::numeric<0 or (x->>'amount')::numeric>v_total
      or nullif(x->>'participant_id','') is null or ((x->>'amount')::numeric>0 and not exists(select 1 from public.connection_members m where m.connection_id=p_connection_id and m.user_id=(x->>'participant_id')::uuid))) then raise exception 'allocation member or amount unavailable' using errcode='42501'; end if;
    v_bill:=v_bill+v_total;
  end loop;
  insert into public.shared_expenses(connection_id,created_by,payer_user_id,description,total_bigint,idempotency_key,request_hash)
    values(p_connection_id,v_actor,v_actor,trim(p_description),v_bill,p_idempotency_key,v_hash)
    on conflict(created_by,idempotency_key) do nothing returning * into v_expense;
  if v_expense.id is null then
    select * into v_existing from public.shared_expenses where created_by=v_actor and idempotency_key=p_idempotency_key for update;
    if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode='23505'; end if;
    return jsonb_build_object('id',v_existing.id,'total',v_existing.total_bigint::text,'status',v_existing.status,'created',false);
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_name:=trim(v_item->>'name'); v_qty:=coalesce(nullif(v_item->>'quantity','')::numeric,1); v_price:=(v_item->>'unit_price')::bigint; v_total:=round(v_qty*v_price)::bigint;
    insert into public.shared_expense_items(shared_expense_id,position,name,quantity,unit_price_bigint,final_total_bigint)
      values(v_expense.id,v_position,v_name,v_qty,v_price,v_total) returning id into v_item_id;
    for v_alloc in select value from jsonb_array_elements(v_item->'allocations') loop
      if (v_alloc->>'amount')::bigint>0 then insert into public.expense_allocations(shared_expense_id,expense_item_id,participant_id,split_mode,amount_bigint)
        values(v_expense.id,v_item_id,(v_alloc->>'participant_id')::uuid,'custom',(v_alloc->>'amount')::bigint); end if;
    end loop;
    v_position:=v_position+1;
  end loop;
  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,idempotency_key,shared_expense_id)
    values(v_actor,p_wallet_id,'expense',v_bill,p_occurred_at,p_accounting_date,p_category_id,trim(p_description),v_expense.id,v_expense.id);
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,p_connection_id,'shared_expense',v_expense.id,'proposed',v_hash);
  return jsonb_build_object('id',v_expense.id,'total',v_bill::text,'status','pending','created',true);
end;
$$;
revoke all on function public.create_shared_group_expense(uuid,uuid,text,timestamptz,date,uuid,jsonb,uuid) from public,anon;
grant execute on function public.create_shared_group_expense(uuid,uuid,text,timestamptz,date,uuid,jsonb,uuid) to authenticated;

create or replace function public.approve_shared_expense(p_expense_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=(select auth.uid()); v_expense public.shared_expenses%rowtype; v_missing integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_expense from public.shared_expenses where id=p_expense_id for update;
  if not found or not public.is_active_connection_member(v_expense.connection_id) then raise exception 'shared expense unavailable' using errcode='42501'; end if;
  if v_expense.status='approved' then return jsonb_build_object('id',v_expense.id,'status','approved','version',v_expense.version,'created',false); end if;
  if v_actor=v_expense.payer_user_id or v_expense.status<>'pending' or p_expected_version is distinct from v_expense.version then raise exception 'proposal changed or actor cannot approve' using errcode='40001'; end if;
  if not exists(select 1 from public.expense_allocations where shared_expense_id=v_expense.id and participant_id=v_actor and amount_bigint>0) then raise exception 'no amount is allocated to this member' using errcode='42501'; end if;
  insert into public.shared_expense_approvals(expense_id,participant_id) values(v_expense.id,v_actor) on conflict do nothing;
  select count(*) into v_missing from (select distinct participant_id from public.expense_allocations where shared_expense_id=v_expense.id and participant_id<>v_expense.payer_user_id and amount_bigint>0
    except select participant_id from public.shared_expense_approvals where expense_id=v_expense.id) pending;
  if v_missing>0 then return jsonb_build_object('id',v_expense.id,'status','pending','approved_by_me',true,'awaiting_members',v_missing,'version',v_expense.version,'created',true); end if;
  insert into public.obligation_ledger(connection_id,source_type,source_id,debtor_id,creditor_id,amount_bigint)
    select v_expense.connection_id,'shared_expense',v_expense.id,a.participant_id,v_expense.payer_user_id,sum(a.amount_bigint)
    from public.expense_allocations a where a.shared_expense_id=v_expense.id and a.participant_id<>v_expense.payer_user_id group by a.participant_id having sum(a.amount_bigint)>0;
  update public.shared_expenses set status='approved',approved_by=v_actor,version=version+1 where id=v_expense.id returning * into v_expense;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,v_expense.connection_id,'shared_expense',v_expense.id,'approved',v_expense.request_hash);
  return jsonb_build_object('id',v_expense.id,'status',v_expense.status,'version',v_expense.version,'created',true);
end;
$$;

create table public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  requester_id uuid not null references auth.users(id) on delete restrict,
  payer_id uuid not null references auth.users(id) on delete restrict,
  amount_bigint bigint not null check(amount_bigint>0),
  note text not null check(char_length(trim(note)) between 1 and 240),
  due_date date,
  status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled')),
  idempotency_key uuid not null,
  request_hash text not null check(request_hash~'^[0-9a-f]{64}$'),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(requester_id,idempotency_key),
  check(requester_id<>payer_id)
);
create index payment_requests_connection_created_idx on public.payment_requests(connection_id,created_at desc,id desc);
create trigger payment_requests_updated_at before update on public.payment_requests for each row execute function public.set_updated_at();
alter table public.payment_requests enable row level security;
revoke all on public.payment_requests from anon,authenticated;
grant select on public.payment_requests to authenticated;
create policy "active members read payment requests" on public.payment_requests for select to authenticated using(public.is_active_connection_member(connection_id));

alter table public.notifications drop constraint notifications_event_type_check;
alter table public.notifications add constraint notifications_event_type_check check(event_type in (
  'shared_expense_created','shared_expense_approved','shared_expense_disputed','shared_expense_cancelled',
  'settlement_created','settlement_confirmed','settlement_rejected','settlement_cancelled','admin_notice',
  'direct_debt_created','direct_debt_approved','direct_debt_disputed','direct_debt_cancelled','direct_debt_reminder',
  'payment_request_created','payment_request_accepted','payment_request_declined','group_expense_approval_needed'
));
alter table public.notifications drop constraint notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check check(entity_type in ('shared_expense','settlement','admin_notice','direct_debt','payment_request'));

create or replace function public.create_payment_request(p_connection_id uuid,p_payer_id uuid,p_amount bigint,p_note text,p_due_date date,p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_request public.payment_requests%rowtype; v_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_amount is null or p_amount<=0 or p_idempotency_key is null or char_length(trim(coalesce(p_note,''))) not between 1 and 240 then raise exception 'invalid payment request' using errcode='22023'; end if;
  perform 1 from public.connections where id=p_connection_id and status='active' and public.is_active_connection_member(id) for update;
  if not found or not exists(select 1 from public.connection_members where connection_id=p_connection_id and user_id=p_payer_id) or p_payer_id=v_actor then raise exception 'payment request member unavailable' using errcode='42501'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('connection_id',p_connection_id,'payer_id',p_payer_id,'amount',p_amount::text,'note',trim(p_note),'due_date',p_due_date)::text,'UTF8'),'sha256'),'hex');
  select * into v_request from public.payment_requests where requester_id=v_actor and idempotency_key=p_idempotency_key for update;
  if found then if v_request.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode='23505'; end if; return jsonb_build_object('id',v_request.id,'status',v_request.status,'created',false); end if;
  insert into public.payment_requests(connection_id,requester_id,payer_id,amount_bigint,note,due_date,idempotency_key,request_hash)
    values(p_connection_id,v_actor,p_payer_id,p_amount,trim(p_note),p_due_date,p_idempotency_key,v_hash)
    on conflict(requester_id,idempotency_key) do nothing returning * into v_request;
  if v_request.id is null then
    select * into v_request from public.payment_requests where requester_id=v_actor and idempotency_key=p_idempotency_key for update;
    if v_request.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode='23505'; end if;
    return jsonb_build_object('id',v_request.id,'status',v_request.status,'created',false);
  end if;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,p_connection_id,'payment_request',v_request.id,'proposed',encode(extensions.digest(convert_to(v_request.amount_bigint::text||':'||v_request.note,'UTF8'),'sha256'),'hex'));
  return jsonb_build_object('id',v_request.id,'status',v_request.status,'created',true);
end;
$$;
create or replace function public.resolve_payment_request(p_request_id uuid,p_expected_version integer,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_request public.payment_requests%rowtype; v_next text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_request from public.payment_requests where id=p_request_id for update;
  if not found or not public.is_active_connection_member(v_request.connection_id) then raise exception 'payment request unavailable' using errcode='42501'; end if;
  if p_expected_version is distinct from v_request.version or v_request.status<>'pending' then raise exception 'payment request changed' using errcode='40001'; end if;
  if p_action='cancel' and v_actor=v_request.requester_id then v_next:='cancelled';
  elsif p_action in ('accept','decline') and v_actor=v_request.payer_id then v_next:=case when p_action='accept' then 'accepted' else 'declined' end;
  else raise exception 'payment request action unavailable' using errcode='42501'; end if;
  update public.payment_requests set status=v_next,version=version+1 where id=v_request.id returning * into v_request;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_request.connection_id,'payment_request',v_request.id,v_next,encode(extensions.digest(convert_to(v_request.amount_bigint::text||':'||v_request.note,'UTF8'),'sha256'),'hex'));
  return jsonb_build_object('id',v_request.id,'status',v_request.status,'version',v_request.version);
end;
$$;
revoke all on function public.create_payment_request(uuid,uuid,bigint,text,date,uuid) from public,anon;
revoke all on function public.resolve_payment_request(uuid,integer,text) from public,anon;
grant execute on function public.create_payment_request(uuid,uuid,bigint,text,date,uuid) to authenticated;
grant execute on function public.resolve_payment_request(uuid,integer,text) to authenticated;

create or replace function public.enqueue_partner_notification(p_recipient uuid,p_connection uuid,p_event_type text,p_entity_type text,p_entity_id uuid,p_title text,p_body text,p_event_key text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_recipient is null or p_connection is null or p_entity_id is null or not exists(
    select 1 from public.connection_members where connection_id=p_connection and user_id=p_recipient
  ) then return; end if;
  insert into public.notifications(recipient_id,connection_id,event_type,entity_type,entity_id,title,body,event_key)
  values(p_recipient,p_connection,p_event_type,p_entity_type,p_entity_id,p_title,p_body,p_event_key) on conflict(event_key) do nothing;
end;
$$;
revoke all on function public.enqueue_partner_notification(uuid,uuid,text,text,uuid,text,text,text) from public,anon,authenticated;

create or replace function public.notify_shared_expense_created()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_member record;
begin
  for v_member in select user_id from public.connection_members where connection_id=new.connection_id and user_id<>new.created_by loop
    perform public.enqueue_partner_notification(v_member.user_id,new.connection_id,'shared_expense_created','shared_expense',new.id,
      'Có đề nghị chia tiền mới','Một thành viên vừa gửi khoản chi cần bạn xem phần được chia.',
      'shared_expense:'||new.id::text||':created:'||v_member.user_id::text);
  end loop;
  return new;
end;
$$;

create or replace function public.notify_shared_expense_status()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_member record; v_event text; v_title text; v_body text;
begin
  if old.status is not distinct from new.status or old.status<>'pending' or new.status not in ('approved','disputed','cancelled') then return new; end if;
  v_event:=case new.status when 'approved' then 'shared_expense_approved' when 'disputed' then 'shared_expense_disputed' else 'shared_expense_cancelled' end;
  v_title:=case new.status when 'approved' then 'Khoản chia đã được xác nhận' when 'disputed' then 'Khoản chia cần trao đổi' else 'Khoản chia đã được hủy' end;
  v_body:=case new.status when 'approved' then 'Các thành viên đã xác nhận phần được chia; công nợ đã được ghi nhận.' when 'disputed' then 'Một thành viên muốn trao đổi về khoản chia.' else 'Đề nghị chia tiền đã được hủy.' end;
  for v_member in select user_id from public.connection_members where connection_id=new.connection_id and user_id<>coalesce(v_actor,new.created_by) loop
    perform public.enqueue_partner_notification(v_member.user_id,new.connection_id,v_event,'shared_expense',new.id,v_title,v_body,
      'shared_expense:'||new.id::text||':'||v_event||':'||v_member.user_id::text);
  end loop;
  return new;
end;
$$;

create or replace function public.notify_settlement_created()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform public.enqueue_partner_notification(new.receiver_id,new.connection_id,'settlement_created','settlement',new.id,
    'Có đề nghị thanh toán mới','Một thành viên gửi đề nghị đối soát công nợ cho bạn.',
    'settlement:'||new.id::text||':created:'||new.receiver_id::text);
  return new;
end;
$$;
create or replace function public.notify_settlement_status()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_event text; v_title text; v_body text;
begin
  if old.status is not distinct from new.status then return new; end if;
  if new.status='confirmed' then v_event:='settlement_confirmed';v_title:='Thanh toán đã được xác nhận';v_body:='Người nhận đã xác nhận khoản thanh toán.';
  elsif new.status='rejected' then v_event:='settlement_rejected';v_title:='Đề nghị thanh toán bị từ chối';v_body:='Người nhận chưa xác nhận khoản thanh toán.';
  elsif new.status='cancelled' then v_event:='settlement_cancelled';v_title:='Đề nghị thanh toán đã hủy';v_body:='Đề nghị thanh toán đã được hủy.';
  else return new; end if;
  perform public.enqueue_partner_notification(new.payer_id,new.connection_id,v_event,'settlement',new.id,v_title,v_body,
    'settlement:'||new.id::text||':'||v_event||':'||new.payer_id::text);
  return new;
end;
$$;

create or replace function public.notify_payment_request()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_recipient uuid; v_event text; v_title text; v_body text;
begin
  if tg_op='INSERT' then
    v_recipient:=new.payer_id; v_event:='payment_request_created'; v_title:='Có đề nghị thanh toán mới'; v_body:='Một thành viên gửi đề nghị thanh toán cho bạn.';
  else
    if old.status is not distinct from new.status then return new; end if;
    v_recipient:=case when new.status in ('accepted','declined') then new.requester_id else new.payer_id end;
    v_event:=case when new.status='accepted' then 'payment_request_accepted' when new.status='declined' then 'payment_request_declined' else 'payment_request_declined' end;
    v_title:=case when new.status='accepted' then 'Đề nghị thanh toán đã được chấp nhận' else 'Đề nghị thanh toán đã bị từ chối hoặc hủy' end;
    v_body:='Mở mục Chia tiền để xem trạng thái đề nghị.';
  end if;
  perform public.enqueue_partner_notification(v_recipient,new.connection_id,v_event,'payment_request',new.id,v_title,v_body,
    'payment_request:'||new.id::text||':'||new.status||':'||v_recipient::text);
  return new;
end;
$$;
create trigger payment_request_notify_created after insert on public.payment_requests for each row execute function public.notify_payment_request();
create trigger payment_request_notify_status after update of status on public.payment_requests for each row execute function public.notify_payment_request();
revoke all on function public.notify_payment_request() from public,anon,authenticated;

create or replace view public.connection_balances with (security_invoker=true) as
select c.id as connection_id,m.user_id as partner_id,
  coalesce(sum(case when l.debtor_id=(select auth.uid()) and l.creditor_id=m.user_id then l.amount_bigint::numeric
    when l.debtor_id=m.user_id and l.creditor_id=(select auth.uid()) then -l.amount_bigint::numeric else 0::numeric end),0::numeric) as amount_owed_by_me_bigint
from public.connections c join public.connection_members me on me.connection_id=c.id and me.user_id=(select auth.uid())
join public.connection_members m on m.connection_id=c.id and m.user_id<>(select auth.uid())
left join public.obligation_ledger l on l.connection_id=c.id and ((l.debtor_id=(select auth.uid()) and l.creditor_id=m.user_id) or (l.debtor_id=m.user_id and l.creditor_id=(select auth.uid())))
where c.status='active'
group by c.id,m.user_id;
revoke all on public.connection_balances from anon;
grant select on public.connection_balances to authenticated;

create or replace function public.create_group_settlement(
  p_connection_id uuid,p_receiver_id uuid,p_wallet_id uuid,p_amount_bigint bigint,
  p_occurred_at timestamptz,p_accounting_date date,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_outstanding numeric; v_settlement public.settlements%rowtype; v_existing public.settlements%rowtype; v_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_amount_bigint is null or p_amount_bigint<=0 or p_idempotency_key is null or p_wallet_id is null then raise exception 'invalid settlement values' using errcode='22023'; end if;
  perform 1 from public.connections where id=p_connection_id and status='active' and public.is_active_connection_member(id) for update;
  if not found or p_receiver_id=v_actor or not exists(select 1 from public.connection_members where connection_id=p_connection_id and user_id=p_receiver_id) then raise exception 'settlement member unavailable' using errcode='42501'; end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then raise exception 'payer wallet unavailable' using errcode='42501'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('connection_id',p_connection_id,'receiver_id',p_receiver_id,'wallet_id',p_wallet_id,'amount',p_amount_bigint::text,'occurred_at',p_occurred_at,'accounting_date',p_accounting_date)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.settlements where payer_id=v_actor and idempotency_key=p_idempotency_key for update;
  if found then if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode='23505'; end if; return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'amount',v_existing.amount_bigint::text,'created',false); end if;
  select coalesce(sum(case when debtor_id=v_actor and creditor_id=p_receiver_id then amount_bigint::numeric when debtor_id=p_receiver_id and creditor_id=v_actor then -amount_bigint::numeric else 0 end),0) into v_outstanding from public.obligation_ledger where connection_id=p_connection_id;
  select v_outstanding-coalesce(sum(amount_bigint),0)::numeric into v_outstanding from public.settlements where connection_id=p_connection_id and payer_id=v_actor and receiver_id=p_receiver_id and status='pending';
  if v_outstanding<=0 or p_amount_bigint::numeric>v_outstanding then raise exception 'settlement exceeds confirmed outstanding debt' using errcode='22023'; end if;
  insert into public.settlements(connection_id,payer_id,receiver_id,amount_bigint,idempotency_key,request_hash,payer_wallet_id,occurred_at,accounting_date)
    values(p_connection_id,v_actor,p_receiver_id,p_amount_bigint,p_idempotency_key,v_hash,p_wallet_id,p_occurred_at,p_accounting_date) returning * into v_settlement;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,p_connection_id,'settlement',v_settlement.id,'proposed',v_hash);
  return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'amount',v_settlement.amount_bigint::text,'version',v_settlement.version,'created',true);
end;
$$;
revoke all on function public.create_group_settlement(uuid,uuid,uuid,bigint,timestamptz,date,uuid) from public,anon;
grant execute on function public.create_group_settlement(uuid,uuid,uuid,bigint,timestamptz,date,uuid) to authenticated;

create or replace function public.resolve_group_settlement(p_settlement_id uuid,p_expected_version integer,p_approve boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_settlement public.settlements%rowtype; v_outstanding numeric; v_status text; v_cash_transaction_id uuid;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_settlement from public.settlements where id=p_settlement_id for update;
  if not found or not public.is_active_connection_member(v_settlement.connection_id) then raise exception 'settlement unavailable' using errcode='42501'; end if;
  if v_settlement.status='confirmed' and v_settlement.receiver_id=v_actor and p_approve then return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'version',v_settlement.version,'created',false); end if;
  if v_actor<>v_settlement.receiver_id then raise exception 'only the receiver can confirm this settlement' using errcode='42501'; end if;
  if v_settlement.status<>'pending' or p_expected_version is distinct from v_settlement.version then raise exception 'settlement changed; refresh before resolving' using errcode='40001'; end if;
  if p_approve then
    select coalesce(sum(case when debtor_id=v_settlement.payer_id and creditor_id=v_settlement.receiver_id then amount_bigint::numeric when debtor_id=v_settlement.receiver_id and creditor_id=v_settlement.payer_id then -amount_bigint::numeric else 0 end),0)
      into v_outstanding from public.obligation_ledger where connection_id=v_settlement.connection_id;
    select v_outstanding-coalesce(sum(amount_bigint),0)::numeric into v_outstanding from public.settlements where connection_id=v_settlement.connection_id
      and payer_id=v_settlement.payer_id and receiver_id=v_settlement.receiver_id and status='pending' and id<>v_settlement.id;
    if v_settlement.amount_bigint::numeric>v_outstanding then raise exception 'settlement now exceeds confirmed outstanding debt' using errcode='22023'; end if;
    insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,note,idempotency_key)
      values(v_settlement.payer_id,v_settlement.payer_wallet_id,'settlement_payment',v_settlement.amount_bigint,v_settlement.occurred_at,v_settlement.accounting_date,'Thanh toán công nợ',v_settlement.id)
      returning id into v_cash_transaction_id;
    insert into public.obligation_ledger(connection_id,source_type,source_id,debtor_id,creditor_id,amount_bigint)
      values(v_settlement.connection_id,'settlement',v_settlement.id,v_settlement.receiver_id,v_settlement.payer_id,v_settlement.amount_bigint);
    v_status:='confirmed';
  else v_status:='rejected'; end if;
  update public.settlements set status=v_status,confirmed_at=case when p_approve then now() else null end,
    cash_transaction_id=case when p_approve then v_cash_transaction_id else null end,version=version+1
    where id=v_settlement.id returning * into v_settlement;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,v_settlement.connection_id,'settlement',v_settlement.id,v_status,v_settlement.request_hash);
  return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'version',v_settlement.version,'created',true);
end;
$$;
revoke all on function public.resolve_group_settlement(uuid,integer,boolean) from public,anon;
grant execute on function public.resolve_group_settlement(uuid,integer,boolean) to authenticated;

create or replace function public.create_direct_debt(
  p_connection_id uuid,p_creditor_id uuid,p_debtor_id uuid,p_description text,p_details text,p_amount_bigint bigint,
  p_due_date date,p_reminder_enabled boolean,p_reminder_frequency text,p_reminder_date date,p_reminder_day integer,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_hash text; v_debt public.direct_debts%rowtype; v_existing public.direct_debts%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_description is null or char_length(trim(p_description)) not between 1 and 160 or p_details is null or char_length(p_details)>1000
    or p_amount_bigint is null or p_amount_bigint<=0 or p_creditor_id is null or p_debtor_id is null or p_creditor_id=p_debtor_id
    or v_actor not in(p_creditor_id,p_debtor_id) or p_idempotency_key is null then raise exception 'invalid direct debt values' using errcode='22023'; end if;
  if not public.is_active_connection_member(p_connection_id) or not exists(select 1 from public.connection_members where connection_id=p_connection_id and user_id=p_creditor_id)
    or not exists(select 1 from public.connection_members where connection_id=p_connection_id and user_id=p_debtor_id) then raise exception 'active connection unavailable' using errcode='42501'; end if;
  if p_reminder_enabled and not ((p_reminder_frequency='once' and p_reminder_date is not null and p_reminder_day is null) or (p_reminder_frequency='monthly' and p_reminder_date is null and p_reminder_day between 1 and 31)) then raise exception 'invalid reminder schedule' using errcode='22023'; end if;
  if not p_reminder_enabled and (p_reminder_date is not null or p_reminder_day is not null) then raise exception 'disabled reminder cannot have a schedule' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('connection_id',p_connection_id,'creditor_id',p_creditor_id,'debtor_id',p_debtor_id,'description',trim(p_description),'details',p_details,'amount',p_amount_bigint::text,'due_date',p_due_date,'reminder_enabled',p_reminder_enabled,'reminder_frequency',p_reminder_frequency,'reminder_date',p_reminder_date,'reminder_day',p_reminder_day)::text,'UTF8'),'sha256'),'hex');
  insert into public.direct_debts(connection_id,created_by,creditor_id,debtor_id,description,details,amount_bigint,due_date,reminder_enabled,reminder_frequency,reminder_date,reminder_day,idempotency_key,request_hash)
    values(p_connection_id,v_actor,p_creditor_id,p_debtor_id,trim(p_description),p_details,p_amount_bigint,p_due_date,p_reminder_enabled,case when p_reminder_enabled then p_reminder_frequency else 'once' end,p_reminder_date,p_reminder_day,p_idempotency_key,v_hash)
    on conflict(created_by,idempotency_key) do nothing returning * into v_debt;
  if v_debt.id is null then
    select * into v_existing from public.direct_debts where created_by=v_actor and idempotency_key=p_idempotency_key for update;
    if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode='23505'; end if;
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'created',false);
  end if;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,p_connection_id,'direct_debt',v_debt.id,'proposed',v_hash);
  return jsonb_build_object('id',v_debt.id,'status',v_debt.status,'created',true);
end;
$$;

create or replace function public.resolve_direct_debt(p_debt_id uuid,p_expected_version integer,p_action text,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid()); v_debt public.direct_debts%rowtype; v_status text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_debt from public.direct_debts where id=p_debt_id for update;
  if not found or not public.is_active_connection_member(v_debt.connection_id) then raise exception 'direct debt unavailable' using errcode='42501'; end if;
  if v_debt.status<>'pending' or p_expected_version is distinct from v_debt.version then raise exception 'proposal changed; refresh before resolving' using errcode='40001'; end if;
  if p_action='cancel' then
    if v_actor<>v_debt.created_by then raise exception 'only creator can cancel proposal' using errcode='42501'; end if;
    v_status:='cancelled';
  elsif p_action in('approve','dispute') then
    if v_actor=v_debt.created_by or v_actor not in(v_debt.creditor_id,v_debt.debtor_id) then raise exception 'only the other named party can resolve this debt' using errcode='42501'; end if;
    if p_action='approve' then
      v_status:='approved';
      insert into public.obligation_ledger(connection_id,source_type,source_id,debtor_id,creditor_id,amount_bigint) values(v_debt.connection_id,'direct_loan',v_debt.id,v_debt.debtor_id,v_debt.creditor_id,v_debt.amount_bigint);
    else
      if char_length(coalesce(p_note,''))>500 then raise exception 'dispute note too long' using errcode='22023'; end if;
      v_status:='disputed';
    end if;
  else raise exception 'invalid resolution action' using errcode='22023'; end if;
  update public.direct_debts set status=v_status,approved_by=case when v_status='approved' then v_actor else null end,dispute_note=case when v_status='disputed' then coalesce(p_note,'') else dispute_note end,version=version+1 where id=v_debt.id returning * into v_debt;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash) values(v_actor,v_debt.connection_id,'direct_debt',v_debt.id,v_status,v_debt.request_hash);
  return jsonb_build_object('id',v_debt.id,'status',v_debt.status,'version',v_debt.version,'created',true);
end;
$$;
