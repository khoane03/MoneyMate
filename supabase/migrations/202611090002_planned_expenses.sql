-- Planned expenses are owner-private forecasts. They do not affect wallets,
-- actual spending, budgets or the ledger until explicitly converted.
create table public.planned_expenses (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  amount_bigint bigint not null check (amount_bigint > 0),
  expected_date date not null,
  category_id uuid references public.categories(id) on delete restrict,
  wallet_id uuid,
  note text not null check (char_length(btrim(note)) between 1 and 240),
  reminder_days integer not null default 1 check (reminder_days between 0 and 30),
  status text not null default 'planned' check (status in ('planned','converted','skipped','cancelled')),
  converted_transaction_id uuid unique references public.transactions(id) on delete restrict,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(owner_id,wallet_id) references public.wallets(owner_id,id) on delete restrict,
  unique(owner_id,idempotency_key),
  check ((status='converted')=(converted_transaction_id is not null))
);
create index planned_expenses_owner_date_idx on public.planned_expenses(owner_id,expected_date,id);
create index planned_expenses_due_idx on public.planned_expenses(owner_id,status,expected_date)
  where status='planned';
create trigger planned_expenses_updated_at before update on public.planned_expenses
  for each row execute function public.set_updated_at();

alter table public.planned_expenses enable row level security;
create policy "planned expense owner reads own" on public.planned_expenses for select to authenticated
  using(owner_id=(select auth.uid()));
revoke all on public.planned_expenses from public,anon,authenticated;
grant select on public.planned_expenses to authenticated;

create or replace function public.create_planned_expense(
  p_id uuid,p_amount_bigint bigint,p_expected_date date,p_category_id uuid,p_wallet_id uuid,
  p_note text,p_reminder_days integer,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=(select auth.uid());
  v_hash text;
  v_existing public.planned_expenses%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_id is null or p_amount_bigint is null or p_amount_bigint<=0 or p_expected_date is null
    or p_idempotency_key is null or p_reminder_days is null or p_reminder_days not between 0 and 30
    or char_length(btrim(coalesce(p_note,''))) not between 1 and 240 then
    raise exception 'invalid planned expense values' using errcode='22023';
  end if;
  if p_category_id is not null and not exists(select 1 from public.categories c
    where c.id=p_category_id and c.kind='expense' and (c.owner_id is null or c.owner_id=v_actor)) then
    raise exception 'expense category unavailable' using errcode='42501';
  end if;
  if p_wallet_id is not null and not exists(select 1 from public.wallets w
    where w.id=p_wallet_id and w.owner_id=v_actor and w.status='active') then
    raise exception 'wallet unavailable' using errcode='42501';
  end if;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
    'id',p_id,'amount',p_amount_bigint::text,'date',p_expected_date,'category',p_category_id,
    'wallet',p_wallet_id,'note',btrim(p_note),'reminder_days',p_reminder_days)::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text||p_idempotency_key::text,0));
  select * into v_existing from public.planned_expenses where owner_id=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash<>v_hash or v_existing.id<>p_id then
      raise exception 'idempotency key reused with different planned expense values' using errcode='23505';
    end if;
    return jsonb_build_object('id',v_existing.id,'version',v_existing.version,'created',false);
  end if;
  insert into public.planned_expenses(id,owner_id,amount_bigint,expected_date,category_id,wallet_id,note,reminder_days,idempotency_key,request_hash)
    values(p_id,v_actor,p_amount_bigint,p_expected_date,p_category_id,p_wallet_id,btrim(p_note),p_reminder_days,p_idempotency_key,v_hash)
    returning * into v_existing;
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
    values(v_actor,'planned_expense',v_existing.id,'created',v_hash);
  return jsonb_build_object('id',v_existing.id,'version',v_existing.version,'created',true);
end;
$$;
revoke all on function public.create_planned_expense(uuid,bigint,date,uuid,uuid,text,integer,uuid) from public,anon;
grant execute on function public.create_planned_expense(uuid,bigint,date,uuid,uuid,text,integer,uuid) to authenticated;

create or replace function public.update_planned_expense(
  p_id uuid,p_expected_version integer,p_amount_bigint bigint,p_expected_date date,p_category_id uuid,
  p_wallet_id uuid,p_note text,p_reminder_days integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=(select auth.uid());
  v_plan public.planned_expenses%rowtype;
  v_old_hash text;
  v_new_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_id is null or p_expected_version is null or p_amount_bigint is null or p_amount_bigint<=0 or p_expected_date is null
    or p_reminder_days is null or p_reminder_days not between 0 and 30
    or char_length(btrim(coalesce(p_note,''))) not between 1 and 240 then
    raise exception 'invalid planned expense values' using errcode='22023';
  end if;
  select * into v_plan from public.planned_expenses where id=p_id and owner_id=v_actor for update;
  if not found then raise exception 'planned expense unavailable' using errcode='42501'; end if;
  if v_plan.status<>'planned' then raise exception 'only an active planned expense can be edited' using errcode='23514'; end if;
  if v_plan.version<>p_expected_version then raise exception 'planned expense version conflict' using errcode='40001'; end if;
  if p_category_id is not null and not exists(select 1 from public.categories c
    where c.id=p_category_id and c.kind='expense' and (c.owner_id is null or c.owner_id=v_actor)) then
    raise exception 'expense category unavailable' using errcode='42501';
  end if;
  if p_wallet_id is not null and not exists(select 1 from public.wallets w
    where w.id=p_wallet_id and w.owner_id=v_actor and w.status='active') then
    raise exception 'wallet unavailable' using errcode='42501';
  end if;
  v_old_hash:=encode(extensions.digest(convert_to(row_to_json(v_plan)::text,'UTF8'),'sha256'),'hex');
  update public.planned_expenses set amount_bigint=p_amount_bigint,expected_date=p_expected_date,
    category_id=p_category_id,wallet_id=p_wallet_id,note=btrim(p_note),reminder_days=p_reminder_days,version=version+1
    where id=p_id returning * into v_plan;
  v_new_hash:=encode(extensions.digest(convert_to(row_to_json(v_plan)::text,'UTF8'),'sha256'),'hex');
  insert into public.audit_events(actor_id,entity,entity_id,action,previous_hash,new_hash)
    values(v_actor,'planned_expense',v_plan.id,'updated',v_old_hash,v_new_hash);
  return jsonb_build_object('id',v_plan.id,'version',v_plan.version);
end;
$$;
revoke all on function public.update_planned_expense(uuid,integer,bigint,date,uuid,uuid,text,integer) from public,anon;
grant execute on function public.update_planned_expense(uuid,integer,bigint,date,uuid,uuid,text,integer) to authenticated;

create or replace function public.set_planned_expense_status(
  p_id uuid,p_expected_version integer,p_status text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=(select auth.uid());
  v_plan public.planned_expenses%rowtype;
  v_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_status not in ('planned','skipped','cancelled') then raise exception 'invalid planned expense status' using errcode='22023'; end if;
  select * into v_plan from public.planned_expenses where id=p_id and owner_id=v_actor for update;
  if not found then raise exception 'planned expense unavailable' using errcode='42501'; end if;
  if v_plan.version<>p_expected_version then raise exception 'planned expense version conflict' using errcode='40001'; end if;
  if v_plan.status='converted' or (p_status='planned' and v_plan.status not in ('skipped','cancelled'))
    or (p_status<>'planned' and v_plan.status<>'planned') then
    raise exception 'invalid planned expense transition' using errcode='23514';
  end if;
  update public.planned_expenses set status=p_status,version=version+1 where id=p_id returning * into v_plan;
  v_hash:=encode(extensions.digest(convert_to(v_plan.id::text||':'||v_plan.status||':'||v_plan.version::text,'UTF8'),'sha256'),'hex');
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
    values(v_actor,'planned_expense',v_plan.id,'status_'||v_plan.status,v_hash);
  return jsonb_build_object('id',v_plan.id,'status',v_plan.status,'version',v_plan.version);
end;
$$;
revoke all on function public.set_planned_expense_status(uuid,integer,text) from public,anon;
grant execute on function public.set_planned_expense_status(uuid,integer,text) to authenticated;

create or replace function public.convert_planned_expense(
  p_id uuid,p_expected_version integer,p_wallet_id uuid,p_amount_bigint bigint,p_occurred_at timestamptz,
  p_accounting_date date,p_category_id uuid,p_note text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=(select auth.uid());
  v_plan public.planned_expenses%rowtype;
  v_transaction public.transactions%rowtype;
  v_hash text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_id is null or p_expected_version is null or p_wallet_id is null or p_amount_bigint is null or p_amount_bigint<=0
    or p_occurred_at is null or p_accounting_date is null or p_idempotency_key is null
    or char_length(coalesce(p_note,''))>1000 then
    raise exception 'invalid actual expense values' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text||p_idempotency_key::text,0));
  select * into v_plan from public.planned_expenses where id=p_id and owner_id=v_actor for update;
  if not found then raise exception 'planned expense unavailable' using errcode='42501'; end if;
  if v_plan.status='converted' then
    select * into v_transaction from public.transactions where id=v_plan.converted_transaction_id and owner_id=v_actor;
    if v_transaction.idempotency_key<>p_idempotency_key
      or v_transaction.wallet_id<>p_wallet_id or v_transaction.amount_bigint<>p_amount_bigint
      or v_transaction.occurred_at<>p_occurred_at or v_transaction.accounting_date<>p_accounting_date
      or v_transaction.category_id is distinct from p_category_id or v_transaction.note<>coalesce(p_note,'') then
      raise exception 'planned expense already converted with different values' using errcode='23505';
    end if;
    return jsonb_build_object('planned_expense_id',v_plan.id,'transaction_id',v_transaction.id,'created',false);
  end if;
  if v_plan.status<>'planned' then raise exception 'planned expense is not active' using errcode='23514'; end if;
  if v_plan.version<>p_expected_version then raise exception 'planned expense version conflict' using errcode='40001'; end if;
  if not exists(select 1 from public.wallets w where w.id=p_wallet_id and w.owner_id=v_actor and w.status='active') then
    raise exception 'wallet unavailable' using errcode='42501';
  end if;
  if p_category_id is not null and not exists(select 1 from public.categories c
    where c.id=p_category_id and c.kind='expense' and (c.owner_id is null or c.owner_id=v_actor)) then
    raise exception 'expense category unavailable' using errcode='42501';
  end if;
  if exists(select 1 from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key) then
    raise exception 'idempotency key already used by another transaction' using errcode='23505';
  end if;
  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,idempotency_key)
    values(v_actor,p_wallet_id,'expense',p_amount_bigint,p_occurred_at,p_accounting_date,p_category_id,coalesce(p_note,''),p_idempotency_key)
    returning * into v_transaction;
  update public.planned_expenses set status='converted',converted_transaction_id=v_transaction.id,version=version+1
    where id=v_plan.id returning * into v_plan;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan.id,'transaction',v_transaction.id,
    'planned_amount',v_plan.amount_bigint::text,'actual_amount',v_transaction.amount_bigint::text)::text,'UTF8'),'sha256'),'hex');
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
    values(v_actor,'planned_expense',v_plan.id,'converted',v_hash);
  return jsonb_build_object('planned_expense_id',v_plan.id,'transaction_id',v_transaction.id,'created',true);
end;
$$;
revoke all on function public.convert_planned_expense(uuid,integer,uuid,bigint,timestamptz,date,uuid,text,uuid) from public,anon;
grant execute on function public.convert_planned_expense(uuid,integer,uuid,bigint,timestamptz,date,uuid,text,uuid) to authenticated;

alter table public.notifications drop constraint notifications_event_type_check;
alter table public.notifications add constraint notifications_event_type_check check(event_type in (
  'shared_expense_created','shared_expense_approved','shared_expense_disputed','shared_expense_cancelled',
  'settlement_created','settlement_confirmed','settlement_rejected','settlement_cancelled','admin_notice',
  'direct_debt_created','direct_debt_approved','direct_debt_disputed','direct_debt_cancelled','direct_debt_reminder',
  'payment_request_created','payment_request_accepted','payment_request_declined','group_expense_approval_needed',
  'planned_expense_due'
));
alter table public.notifications drop constraint notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check
  check(entity_type in ('shared_expense','settlement','admin_notice','direct_debt','payment_request','planned_expense'));

create or replace function public.process_due_planned_expense_reminders()
returns integer language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=(select auth.uid());
  v_today date:=(pg_catalog.timezone('Asia/Ho_Chi_Minh',now()))::date;
  v_count integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  insert into public.notifications(recipient_id,connection_id,event_type,entity_type,entity_id,title,body,event_key)
  select p.owner_id,null,'planned_expense_due','planned_expense',p.id,
    case when p.expected_date<v_today then 'Khoản dự kiến đã quá hạn' when p.expected_date=v_today then 'Khoản dự kiến đến hạn hôm nay' else 'Khoản dự kiến sắp đến hạn' end,
    left('“'||p.note||'” · dự kiến ngày '||to_char(p.expected_date,'DD/MM/YYYY'),240),
    'planned_expense:'||p.id::text||':due:'||p.expected_date::text
  from public.planned_expenses p
  where p.owner_id=v_actor and p.status='planned'
    and v_today>=p.expected_date-p.reminder_days
  on conflict(event_key) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;
revoke all on function public.process_due_planned_expense_reminders() from public,anon;
grant execute on function public.process_due_planned_expense_reminders() to authenticated;
