-- Shared purchases are proposals until the other member approves them. Only the payer's
-- private wallet receives one expense transaction; counterpart shares become obligations.
create table public.shared_expenses (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  payer_user_id uuid not null references auth.users(id) on delete restrict,
  description text not null check (char_length(trim(description)) between 1 and 200),
  total_bigint bigint not null check (total_bigint > 0),
  status text not null default 'pending' check (status in ('pending','approved','disputed','cancelled')),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid references auth.users(id) on delete set null,
  dispute_note text not null default '' check (char_length(dispute_note) <= 500),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by,idempotency_key),
  check (payer_user_id = created_by),
  check ((status = 'approved') = (approved_by is not null))
);
create index shared_expenses_connection_state_idx on public.shared_expenses(connection_id,status,created_at desc);
create trigger shared_expenses_updated_at before update on public.shared_expenses
  for each row execute function public.set_updated_at();

create table public.shared_expense_items (
  id uuid primary key default gen_random_uuid(),
  shared_expense_id uuid not null references public.shared_expenses(id) on delete restrict,
  position integer not null check (position between 0 and 49),
  name text not null check (char_length(trim(name)) between 1 and 120),
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price_bigint bigint not null check (unit_price_bigint > 0),
  final_total_bigint bigint not null check (final_total_bigint > 0),
  created_at timestamptz not null default now(),
  unique (shared_expense_id,position)
);
create index shared_expense_items_expense_idx on public.shared_expense_items(shared_expense_id,position);

create table public.expense_allocations (
  id uuid primary key default gen_random_uuid(),
  shared_expense_id uuid not null references public.shared_expenses(id) on delete restrict,
  expense_item_id uuid not null references public.shared_expense_items(id) on delete restrict,
  participant_id uuid not null references auth.users(id) on delete restrict,
  split_mode text not null check (split_mode in ('equal','payer','partner','custom')),
  amount_bigint bigint not null check (amount_bigint > 0),
  created_at timestamptz not null default now(),
  unique (expense_item_id,participant_id)
);
create index expense_allocations_expense_idx on public.expense_allocations(shared_expense_id,participant_id);

create table public.obligation_ledger (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  source_type text not null check (source_type in ('shared_expense','settlement','direct_loan','reversal')),
  source_id uuid not null,
  debtor_id uuid not null references auth.users(id) on delete restrict,
  creditor_id uuid not null references auth.users(id) on delete restrict,
  amount_bigint bigint not null check (amount_bigint > 0),
  reversal_of uuid references public.obligation_ledger(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (debtor_id <> creditor_id),
  unique (source_type,source_id)
);
create index obligation_ledger_connection_idx on public.obligation_ledger(connection_id,created_at);
create index obligation_ledger_debtor_idx on public.obligation_ledger(connection_id,debtor_id);
create index obligation_ledger_creditor_idx on public.obligation_ledger(connection_id,creditor_id);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  payer_id uuid not null references auth.users(id) on delete restrict,
  receiver_id uuid not null references auth.users(id) on delete restrict,
  amount_bigint bigint not null check (amount_bigint > 0),
  cash_transaction_id uuid unique references public.transactions(id) on delete restrict,
  payer_wallet_id uuid not null references public.wallets(id) on delete restrict,
  occurred_at timestamptz not null,
  accounting_date date not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','cancelled')),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  version integer not null default 1 check (version > 0),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payer_id,idempotency_key),
  check (payer_id <> receiver_id),
  check ((status = 'confirmed') = (confirmed_at is not null))
);
create index settlements_connection_state_idx on public.settlements(connection_id,status,created_at desc);
create trigger settlements_updated_at before update on public.settlements
  for each row execute function public.set_updated_at();

alter table public.transactions add column shared_expense_id uuid references public.shared_expenses(id) on delete restrict;
create index transactions_shared_expense_idx on public.transactions(shared_expense_id) where shared_expense_id is not null;
alter table public.transactions drop constraint transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('income','expense','loan_disbursement','loan_repayment','adjustment','transfer_out','transfer_in','settlement_payment'));

create or replace view public.wallet_balances with (security_invoker = true) as
select w.id, w.owner_id, w.kind, w.display_name, w.opening_balance_bigint, w.status,
  w.opening_balance_bigint::numeric + coalesce(sum(case
    when t.kind in ('income','loan_repayment','transfer_in') then t.amount_bigint::numeric
    when t.kind in ('expense','loan_disbursement','transfer_out','settlement_payment') then -t.amount_bigint::numeric
    else 0::numeric end),0::numeric) as current_balance_bigint
from public.wallets w
left join public.transactions t on t.wallet_id = w.id and t.owner_id = w.owner_id
group by w.id;
revoke all on public.wallet_balances from anon;
grant select on public.wallet_balances to authenticated;

alter table public.shared_expenses enable row level security;
alter table public.shared_expense_items enable row level security;
alter table public.expense_allocations enable row level security;
alter table public.obligation_ledger enable row level security;
alter table public.settlements enable row level security;

create or replace function public.is_shared_expense_member(p_expense_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shared_expenses e
    where e.id = p_expense_id and public.is_active_connection_member(e.connection_id)
  );
$$;
revoke all on function public.is_shared_expense_member(uuid) from public, anon;
grant execute on function public.is_shared_expense_member(uuid) to authenticated;

create policy "active connection members read shared expenses" on public.shared_expenses for select to authenticated
  using (public.is_active_connection_member(connection_id));
create policy "active connection members read shared items" on public.shared_expense_items for select to authenticated
  using (public.is_shared_expense_member(shared_expense_id));
create policy "active connection members read allocations" on public.expense_allocations for select to authenticated
  using (public.is_shared_expense_member(shared_expense_id));
create policy "active connection members read obligations" on public.obligation_ledger for select to authenticated
  using (public.is_active_connection_member(connection_id));
create policy "active connection members read settlements" on public.settlements for select to authenticated
  using (public.is_active_connection_member(connection_id));

revoke all on public.shared_expenses,public.shared_expense_items,public.expense_allocations,
  public.obligation_ledger,public.settlements from anon,authenticated;
grant select on public.shared_expenses,public.shared_expense_items,public.expense_allocations,
  public.obligation_ledger to authenticated;
grant select (id,connection_id,payer_id,receiver_id,amount_bigint,status,version,confirmed_at,created_at,updated_at)
  on public.settlements to authenticated;

create view public.connection_balances with (security_invoker = true) as
select c.id as connection_id,
  case when (select auth.uid()) = c.member_a_id then c.member_b_id else c.member_a_id end as partner_id,
  coalesce(sum(case
    when l.debtor_id = (select auth.uid()) then l.amount_bigint::numeric
    when l.creditor_id = (select auth.uid()) then -l.amount_bigint::numeric
    else 0::numeric end),0::numeric) as amount_owed_by_me_bigint
from public.connections c
left join public.obligation_ledger l on l.connection_id = c.id
where c.status = 'active'
group by c.id,c.member_a_id,c.member_b_id;
revoke all on public.connection_balances from anon;
grant select on public.connection_balances to authenticated;

create or replace function public.create_shared_expense(
  p_connection_id uuid,
  p_wallet_id uuid,
  p_description text,
  p_occurred_at timestamptz,
  p_accounting_date date,
  p_category_id uuid,
  p_items jsonb,
  p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_partner uuid;
  v_expense public.shared_expenses%rowtype;
  v_existing public.shared_expenses%rowtype;
  v_item jsonb;
  v_name text;
  v_quantity numeric;
  v_unit_price bigint;
  v_final_total bigint;
  v_partner_share bigint;
  v_actor_share bigint;
  v_total bigint := 0;
  v_position integer := 0;
  v_item_id uuid;
  v_mode text;
  v_hash text;
  v_payload jsonb;
  v_category_owner uuid;
  v_category_kind text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_connection_id is null or p_wallet_id is null or p_idempotency_key is null
    or p_occurred_at is null or p_accounting_date is null
    or char_length(trim(coalesce(p_description,''))) not between 1 and 200
    or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'invalid shared expense values' using errcode = '22023';
  end if;
    select case when c.member_a_id = v_actor then c.member_b_id else c.member_a_id end
    into v_partner from public.connections c
    where c.id = p_connection_id and c.status = 'active'
      and v_actor in (c.member_a_id,c.member_b_id) for key share;
  if not found then raise exception 'active connection unavailable' using errcode = '42501'; end if;
  if not exists (select 1 from public.wallets w where w.id=p_wallet_id and w.owner_id=v_actor and w.status='active') then
    raise exception 'payer wallet unavailable' using errcode = '42501';
  end if;
  if p_category_id is not null then
    select owner_id,kind into v_category_owner,v_category_kind from public.categories
      where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found or v_category_kind <> 'expense' then raise exception 'expense category unavailable' using errcode = '42501'; end if;
  end if;

  v_payload := jsonb_build_object('connection_id',p_connection_id,'wallet_id',p_wallet_id,
    'description',trim(p_description),'occurred_at',p_occurred_at,'accounting_date',p_accounting_date,
    'category_id',p_category_id,'items',p_items);
  v_hash := encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.shared_expenses
    where created_by=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash <> v_hash then raise exception 'idempotency key reused with different values' using errcode = '23505'; end if;
    return jsonb_build_object('id',v_existing.id,'total',v_existing.total_bigint::text,'status',v_existing.status,'created',false);
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_name := trim(coalesce(v_item->>'name',''));
    v_quantity := coalesce(nullif(v_item->>'quantity','')::numeric,1);
    v_unit_price := (v_item->>'unit_price')::bigint;
    v_final_total := round(v_quantity * v_unit_price)::bigint;
    v_mode := coalesce(v_item->>'split_mode','equal');
    if char_length(v_name) not between 1 and 120 or v_quantity is null or v_quantity <= 0 or v_quantity > 1000000
      or v_quantity <> round(v_quantity,3)
      or v_unit_price is null or v_unit_price <= 0 or v_final_total is null or v_final_total <= 0
      or v_mode not in ('equal','payer','partner','custom') then
      raise exception 'invalid shared expense item' using errcode = '22023';
    end if;
    if v_mode = 'equal' then
      v_partner_share := v_final_total / 2;
      if v_final_total % 2 = 1 and v_partner > v_actor then v_partner_share := v_partner_share + 1; end if;
    elsif v_mode = 'payer' then v_partner_share := 0;
    elsif v_mode = 'partner' then v_partner_share := v_final_total;
    else
      v_partner_share := (v_item->>'partner_share')::bigint;
      if v_partner_share is null or v_partner_share < 0 or v_partner_share > v_final_total then raise exception 'custom item split is out of range' using errcode = '22023'; end if;
    end if;
    v_total := v_total + v_final_total;
  end loop;
  if v_total <= 0 then raise exception 'shared expense total must be positive' using errcode = '22023'; end if;

  insert into public.shared_expenses(connection_id,created_by,payer_user_id,description,total_bigint,idempotency_key,request_hash)
  values(p_connection_id,v_actor,v_actor,trim(p_description),v_total,p_idempotency_key,v_hash)
  on conflict(created_by,idempotency_key) do nothing returning * into v_expense;
  if v_expense.id is null then
    select * into v_existing from public.shared_expenses
      where created_by=v_actor and idempotency_key=p_idempotency_key for update;
    if v_existing.request_hash <> v_hash then raise exception 'idempotency key reused with different values' using errcode = '23505'; end if;
    return jsonb_build_object('id',v_existing.id,'total',v_existing.total_bigint::text,'status',v_existing.status,'created',false);
  end if;

  v_position := 0;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_name := trim(v_item->>'name');
    v_quantity := coalesce(nullif(v_item->>'quantity','')::numeric,1);
    v_unit_price := (v_item->>'unit_price')::bigint;
    v_final_total := round(v_quantity * v_unit_price)::bigint;
    v_mode := coalesce(v_item->>'split_mode','equal');
    if v_mode = 'equal' then
      v_partner_share := v_final_total / 2;
      if v_final_total % 2 = 1 and v_partner > v_actor then v_partner_share := v_partner_share + 1; end if;
    elsif v_mode = 'payer' then v_partner_share := 0;
    elsif v_mode = 'partner' then v_partner_share := v_final_total;
    else v_partner_share := (v_item->>'partner_share')::bigint;
    end if;
    v_actor_share := v_final_total - v_partner_share;
    insert into public.shared_expense_items(shared_expense_id,position,name,quantity,unit_price_bigint,final_total_bigint)
      values(v_expense.id,v_position,v_name,v_quantity,v_unit_price,v_final_total) returning id into v_item_id;
    if v_actor_share > 0 then
      insert into public.expense_allocations(shared_expense_id,expense_item_id,participant_id,split_mode,amount_bigint)
        values(v_expense.id,v_item_id,v_actor,v_mode,v_actor_share);
    end if;
    if v_partner_share > 0 then
      insert into public.expense_allocations(shared_expense_id,expense_item_id,participant_id,split_mode,amount_bigint)
        values(v_expense.id,v_item_id,v_partner, v_mode,v_partner_share);
    end if;
    v_position := v_position + 1;
  end loop;

  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,
    category_id,note,idempotency_key,shared_expense_id)
  values(v_actor,p_wallet_id,'expense',v_total,p_occurred_at,p_accounting_date,p_category_id,
    trim(p_description),v_expense.id,v_expense.id);
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
  values(v_actor,p_connection_id,'shared_expense',v_expense.id,'proposed',v_hash);
  return jsonb_build_object('id',v_expense.id,'total',v_total::text,'status','pending','created',true);
end;
$$;

create or replace function public.approve_shared_expense(p_expense_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_connection_id uuid;
  v_expense public.shared_expenses%rowtype;
  v_partner_share bigint;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select connection_id into v_connection_id from public.shared_expenses where id=p_expense_id;
  if not found then raise exception 'shared expense unavailable' using errcode = '42501'; end if;
  perform 1 from public.connections where id=v_connection_id and status='active'
    and (member_a_id=v_actor or member_b_id=v_actor) for update;
  if not found then raise exception 'shared expense unavailable' using errcode = '42501'; end if;
  select * into v_expense from public.shared_expenses where id=p_expense_id for update;
  if v_expense.status='approved' and v_expense.approved_by=v_actor then
    return jsonb_build_object('id',v_expense.id,'status',v_expense.status,'version',v_expense.version,'created',false);
  end if;
  if v_actor=v_expense.payer_user_id then raise exception 'payer cannot approve own proposal' using errcode = '42501'; end if;
  if v_expense.status <> 'pending' then raise exception 'proposal is no longer pending' using errcode = 'P0001'; end if;
  if p_expected_version is distinct from v_expense.version then raise exception 'proposal changed; refresh before approving' using errcode = '40001'; end if;
  select coalesce(sum(a.amount_bigint),0) into v_partner_share from public.expense_allocations a
    where a.shared_expense_id=v_expense.id and a.participant_id=v_actor;
  if v_partner_share > 0 then
    insert into public.obligation_ledger(connection_id,source_type,source_id,debtor_id,creditor_id,amount_bigint)
      values(v_expense.connection_id,'shared_expense',v_expense.id,v_actor,v_expense.payer_user_id,v_partner_share);
  end if;
  update public.shared_expenses set status='approved',approved_by=v_actor,version=version+1
    where id=v_expense.id returning * into v_expense;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_expense.connection_id,'shared_expense',v_expense.id,'approved',v_expense.request_hash);
  return jsonb_build_object('id',v_expense.id,'status',v_expense.status,'version',v_expense.version,'partner_share',v_partner_share::text,'created',true);
end;
$$;

create or replace function public.dispute_shared_expense(p_expense_id uuid,p_expected_version integer,p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_connection_id uuid;
  v_expense public.shared_expenses%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select connection_id into v_connection_id from public.shared_expenses where id=p_expense_id;
  if not found then raise exception 'shared expense unavailable' using errcode = '42501'; end if;
  perform 1 from public.connections where id=v_connection_id and status='active'
    and (member_a_id=v_actor or member_b_id=v_actor) for update;
  if not found then raise exception 'shared expense unavailable' using errcode = '42501'; end if;
  select * into v_expense from public.shared_expenses where id=p_expense_id for update;
  if v_actor=v_expense.payer_user_id then raise exception 'payer cannot dispute own proposal' using errcode = '42501'; end if;
  if v_expense.status <> 'pending' or p_expected_version is distinct from v_expense.version then raise exception 'proposal changed; refresh before disputing' using errcode = '40001'; end if;
  if char_length(coalesce(p_note,'')) > 500 then raise exception 'dispute note is too long' using errcode = '22023'; end if;
  update public.shared_expenses set status='disputed',dispute_note=trim(coalesce(p_note,'')),version=version+1
    where id=v_expense.id returning * into v_expense;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_expense.connection_id,'shared_expense',v_expense.id,'disputed',v_expense.request_hash);
  return jsonb_build_object('id',v_expense.id,'status',v_expense.status,'version',v_expense.version);
end;
$$;

create or replace function public.cancel_shared_expense(p_expense_id uuid,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_connection_id uuid;
  v_expense public.shared_expenses%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select connection_id into v_connection_id from public.shared_expenses where id=p_expense_id;
  if not found then raise exception 'shared expense unavailable' using errcode = '42501'; end if;
  perform 1 from public.connections where id=v_connection_id and status='active'
    and (member_a_id=v_actor or member_b_id=v_actor) for update;
  if not found then raise exception 'shared expense unavailable' using errcode = '42501'; end if;
  select * into v_expense from public.shared_expenses where id=p_expense_id for update;
  if v_actor <> v_expense.created_by then raise exception 'only the payer may cancel a proposal' using errcode = '42501'; end if;
  if v_expense.status <> 'pending' or p_expected_version is distinct from v_expense.version then raise exception 'proposal changed; refresh before cancelling' using errcode = '40001'; end if;
  update public.shared_expenses set status='cancelled',version=version+1 where id=v_expense.id returning * into v_expense;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_expense.connection_id,'shared_expense',v_expense.id,'cancelled',v_expense.request_hash);
  return jsonb_build_object('id',v_expense.id,'status',v_expense.status,'version',v_expense.version);
end;
$$;

create or replace function public.create_settlement(
  p_connection_id uuid,p_wallet_id uuid,p_amount_bigint bigint,
  p_occurred_at timestamptz,p_accounting_date date,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_partner uuid;
  v_outstanding numeric;
  v_settlement public.settlements%rowtype;
  v_existing public.settlements%rowtype;
  v_cash_transaction_id uuid;
  v_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_wallet_id is null or p_amount_bigint is null or p_amount_bigint <= 0 or p_occurred_at is null
    or p_accounting_date is null or p_idempotency_key is null then raise exception 'invalid settlement values' using errcode = '22023'; end if;
  select case when c.member_a_id=v_actor then c.member_b_id else c.member_a_id end into v_partner
    from public.connections c where c.id=p_connection_id and c.status='active' and v_actor in (c.member_a_id,c.member_b_id) for update;
  if not found then raise exception 'active connection unavailable' using errcode = '42501'; end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object('connection_id',p_connection_id,'wallet_id',p_wallet_id,
    'amount',p_amount_bigint::text,'occurred_at',p_occurred_at,'accounting_date',p_accounting_date)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.settlements where payer_id=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode = '23505'; end if;
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'amount',v_existing.amount_bigint::text,'created',false);
  end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'payer wallet unavailable' using errcode = '42501';
  end if;
  select coalesce(sum(case when l.debtor_id=v_actor then l.amount_bigint::numeric when l.creditor_id=v_actor then -l.amount_bigint::numeric else 0::numeric end),0::numeric)
    into v_outstanding from public.obligation_ledger l where l.connection_id=p_connection_id;
  select v_outstanding - coalesce(sum(s.amount_bigint),0)::numeric into v_outstanding
    from public.settlements s where s.connection_id=p_connection_id and s.payer_id=v_actor and s.status='pending';
  if v_outstanding <= 0 or p_amount_bigint::numeric > v_outstanding then raise exception 'settlement exceeds confirmed outstanding debt' using errcode = '22023'; end if;
  insert into public.settlements(connection_id,payer_id,receiver_id,amount_bigint,idempotency_key,request_hash,payer_wallet_id,occurred_at,accounting_date)
    values(p_connection_id,v_actor,v_partner,p_amount_bigint,p_idempotency_key,v_hash,p_wallet_id,p_occurred_at,p_accounting_date) returning * into v_settlement;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,p_connection_id,'settlement',v_settlement.id,'proposed',v_hash);
  return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'amount',v_settlement.amount_bigint::text,'version',v_settlement.version,'created',true);
end;
$$;

create or replace function public.resolve_settlement(p_settlement_id uuid,p_expected_version integer,p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_connection_id uuid;
  v_settlement public.settlements%rowtype;
  v_outstanding numeric;
  v_next_status text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select connection_id into v_connection_id from public.settlements where id=p_settlement_id;
  if not found then raise exception 'settlement unavailable' using errcode = '42501'; end if;
  perform 1 from public.connections where id=v_connection_id and status='active'
    and (member_a_id=v_actor or member_b_id=v_actor) for update;
  if not found then raise exception 'settlement unavailable' using errcode = '42501'; end if;
  select * into v_settlement from public.settlements where id=p_settlement_id for update;
  if v_settlement.status='confirmed' and v_settlement.receiver_id=v_actor and p_approve then
    return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'version',v_settlement.version,'created',false);
  end if;
  if v_actor<>v_settlement.receiver_id then raise exception 'only the receiver can confirm this settlement' using errcode = '42501'; end if;
  if v_settlement.status<>'pending' or p_expected_version is distinct from v_settlement.version then raise exception 'settlement changed; refresh before resolving' using errcode = '40001'; end if;
  if p_approve then
    select coalesce(sum(case when l.debtor_id=v_settlement.payer_id then l.amount_bigint::numeric when l.creditor_id=v_settlement.payer_id then -l.amount_bigint::numeric else 0::numeric end),0::numeric)
      into v_outstanding from public.obligation_ledger l where l.connection_id=v_settlement.connection_id;
    select v_outstanding - coalesce(sum(s.amount_bigint),0)::numeric into v_outstanding
      from public.settlements s where s.connection_id=v_settlement.connection_id and s.payer_id=v_settlement.payer_id
        and s.status='pending' and s.id<>v_settlement.id;
    if v_settlement.amount_bigint::numeric>v_outstanding then raise exception 'settlement now exceeds confirmed outstanding debt' using errcode = '22023'; end if;
    insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,note,idempotency_key)
      values(v_settlement.payer_id,v_settlement.payer_wallet_id,'settlement_payment',v_settlement.amount_bigint,
        v_settlement.occurred_at,v_settlement.accounting_date,'Thanh toán công nợ',v_settlement.id)
      returning id into v_settlement.cash_transaction_id;
    insert into public.obligation_ledger(connection_id,source_type,source_id,debtor_id,creditor_id,amount_bigint)
      values(v_settlement.connection_id,'settlement',v_settlement.id,v_settlement.receiver_id,v_settlement.payer_id,v_settlement.amount_bigint);
    v_next_status := 'confirmed';
  else v_next_status := 'rejected';
  end if;
  update public.settlements set status=v_next_status,confirmed_at=case when p_approve then now() else null end,
    cash_transaction_id=case when p_approve then v_settlement.cash_transaction_id else null end,version=version+1
    where id=v_settlement.id returning * into v_settlement;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_settlement.connection_id,'settlement',v_settlement.id,v_next_status,v_settlement.request_hash);
  return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'version',v_settlement.version,'created',true);
end;
$$;

create or replace function public.revoke_connection(p_connection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_connection public.connections%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  update public.connections set status='revoked',revoked_at=now()
    where id=p_connection_id and status='active' and (member_a_id=v_actor or member_b_id=v_actor)
    returning * into v_connection;
  if not found then raise exception 'active connection unavailable' using errcode = '42501'; end if;
  update public.shared_expenses set status='cancelled',version=version+1
    where connection_id=v_connection.id and status='pending';
  update public.settlements set status='cancelled',version=version+1
    where connection_id=v_connection.id and status='pending';
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_connection.id,'connection',v_connection.id,'revoked',encode(extensions.digest(convert_to(v_connection.id::text,'UTF8'),'sha256'),'hex'));
  return jsonb_build_object('connection_id',v_connection.id,'status',v_connection.status);
end;
$$;

revoke all on function public.create_shared_expense(uuid,uuid,text,timestamptz,date,uuid,jsonb,uuid) from public,anon;
revoke all on function public.approve_shared_expense(uuid,integer) from public,anon;
revoke all on function public.dispute_shared_expense(uuid,integer,text) from public,anon;
revoke all on function public.cancel_shared_expense(uuid,integer) from public,anon;
revoke all on function public.create_settlement(uuid,uuid,bigint,timestamptz,date,uuid) from public,anon;
revoke all on function public.resolve_settlement(uuid,integer,boolean) from public,anon;
revoke all on function public.revoke_connection(uuid) from public,anon;
grant execute on function public.create_shared_expense(uuid,uuid,text,timestamptz,date,uuid,jsonb,uuid) to authenticated;
grant execute on function public.approve_shared_expense(uuid,integer) to authenticated;
grant execute on function public.dispute_shared_expense(uuid,integer,text) to authenticated;
grant execute on function public.cancel_shared_expense(uuid,integer) to authenticated;
grant execute on function public.create_settlement(uuid,uuid,bigint,timestamptz,date,uuid) to authenticated;
grant execute on function public.resolve_settlement(uuid,integer,boolean) to authenticated;
grant execute on function public.revoke_connection(uuid) to authenticated;
