alter table public.transactions
  add column loan_share_opt_in boolean not null default false,
  add constraint transactions_loan_share_kind_check
    check (kind in ('borrowed_funds','loan_principal_payment') or not loan_share_opt_in);

create table public.shared_personal_loans (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  borrower_user_id uuid not null references auth.users(id) on delete restrict,
  counterparty_user_id uuid not null references auth.users(id) on delete restrict,
  lender_name text not null check (char_length(lender_name) between 1 and 120),
  purpose text not null check (char_length(purpose) between 1 and 240),
  principal_bigint bigint not null check (principal_bigint > 0),
  accounting_date date not null,
  created_at timestamptz not null default now(),
  constraint shared_personal_loans_distinct_participants check (borrower_user_id<>counterparty_user_id)
);
create index shared_personal_loans_connection_idx on public.shared_personal_loans(connection_id,created_at desc,id desc);
create index shared_personal_loans_borrower_idx on public.shared_personal_loans(borrower_user_id,created_at desc,id desc);
create index shared_personal_loans_counterparty_idx on public.shared_personal_loans(counterparty_user_id,created_at desc,id desc);

create table public.shared_personal_loan_payments (
  id uuid primary key default gen_random_uuid(),
  shared_loan_id uuid not null references public.shared_personal_loans(id) on delete restrict,
  amount_bigint bigint not null check (amount_bigint > 0),
  accounting_date date not null,
  reduces_balance boolean not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index shared_personal_loan_payments_history_idx on public.shared_personal_loan_payments(shared_loan_id,accounting_date desc,id desc);

-- Private mapping lets server RPCs correlate shared entries with the borrower's
-- private transactions without exposing wallet/transaction IDs to the counterparty.
create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create table private.shared_personal_loan_sources (
  source_transaction_id uuid primary key references public.transactions(id) on delete restrict,
  shared_loan_id uuid not null unique references public.shared_personal_loans(id) on delete restrict
);
create table private.shared_personal_loan_payment_sources (
  source_transaction_id uuid primary key references public.transactions(id) on delete restrict,
  shared_payment_id uuid not null unique references public.shared_personal_loan_payments(id) on delete restrict
);
revoke all on private.shared_personal_loan_sources,private.shared_personal_loan_payment_sources from public,anon,authenticated;

alter table public.shared_personal_loans enable row level security;
alter table public.shared_personal_loan_payments enable row level security;
revoke all on public.shared_personal_loans,public.shared_personal_loan_payments from public,anon,authenticated;
grant select on public.shared_personal_loans,public.shared_personal_loan_payments to authenticated;

create policy "loan participants read explicitly shared loans" on public.shared_personal_loans
  for select to authenticated using (
    (select auth.uid()) in (borrower_user_id,counterparty_user_id)
    and public.is_active_connection_member(connection_id)
    and exists(select 1 from public.connection_members m where m.connection_id=shared_personal_loans.connection_id and m.user_id=shared_personal_loans.borrower_user_id)
    and exists(select 1 from public.connection_members m where m.connection_id=shared_personal_loans.connection_id and m.user_id=shared_personal_loans.counterparty_user_id)
  );
create policy "loan participants read shared repayments" on public.shared_personal_loan_payments
  for select to authenticated using (
    exists(select 1 from public.shared_personal_loans l where l.id=shared_loan_id)
  );

-- The 16-argument overload preserves the private cash ledger RPC and appends
-- a separate, opt-in record visible only to the borrower and named counterparty.
create or replace function public.create_personal_transaction(
  p_wallet_id uuid,p_kind text,p_amount_bigint bigint,p_occurred_at timestamptz,p_accounting_date date,
  p_category_id uuid,p_note text,p_idempotency_key uuid,p_affects_outstanding boolean,
  p_loan_connection_id uuid,p_loan_counterparty_id uuid,p_loan_lender_name text,p_loan_purpose text,
  p_affects_wallet boolean,p_loan_origin_transaction_id uuid,p_share_with_counterparty boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_result jsonb;
  v_transaction_id uuid;
  v_preexisting boolean;
  v_saved_share_opt_in boolean;
  v_shared_loan_id uuid;
  v_shared_payment_id uuid;
  v_shared_loan public.shared_personal_loans%rowtype;
  v_shared_payment public.shared_personal_loan_payments%rowtype;
  v_source_is_shared boolean := false;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_share_with_counterparty is null then raise exception 'sharing choice must be explicit' using errcode = '22023'; end if;
  if p_kind not in ('borrowed_funds','loan_principal_payment') and p_share_with_counterparty then
    raise exception 'only personal loan entries can be shared' using errcode = '22023';
  end if;
  if p_kind='borrowed_funds' then
    if p_share_with_counterparty is distinct from (p_loan_connection_id is not null and p_loan_counterparty_id is not null) then
      raise exception 'choose a connected counterparty to share this loan' using errcode = '22023';
    end if;
    if p_share_with_counterparty and not coalesce(p_affects_outstanding,false) then
      raise exception 'a shared loan must be included in tracked outstanding debt' using errcode = '22023';
    end if;
  elsif p_kind='loan_principal_payment' then
    select s.shared_loan_id into v_shared_loan_id
      from private.shared_personal_loan_sources s where s.source_transaction_id=p_loan_origin_transaction_id;
    v_source_is_shared := found;
    if p_share_with_counterparty is distinct from v_source_is_shared then
      raise exception 'repayment sharing must match the selected loan' using errcode = '22023';
    end if;
    if v_source_is_shared then
      select * into v_shared_loan from public.shared_personal_loans where id=v_shared_loan_id;
      if p_loan_connection_id is distinct from v_shared_loan.connection_id
        or p_loan_counterparty_id is distinct from v_shared_loan.counterparty_user_id then
        raise exception 'repayment must stay linked to the same loan participants' using errcode = '22023';
      end if;
    elsif p_loan_connection_id is not null or p_loan_counterparty_id is not null then
      raise exception 'a private loan repayment cannot be newly linked to another member' using errcode = '22023';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text || p_idempotency_key::text,0));
  select exists(select 1 from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key)
    into v_preexisting;
  v_result := public.create_personal_transaction(p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,
    p_category_id,p_note,p_idempotency_key,p_affects_outstanding,p_loan_connection_id,p_loan_counterparty_id,
    p_loan_lender_name,p_loan_purpose,p_affects_wallet,p_loan_origin_transaction_id);
  v_transaction_id := (v_result->>'id')::uuid;

  if v_preexisting then
    select loan_share_opt_in into v_saved_share_opt_in from public.transactions
      where id=v_transaction_id and owner_id=v_actor;
    if v_saved_share_opt_in is distinct from p_share_with_counterparty then
      raise exception 'idempotency key reused with a different sharing choice' using errcode = '23505';
    end if;
  else
    update public.transactions set loan_share_opt_in=p_share_with_counterparty
      where id=v_transaction_id and owner_id=v_actor;
  end if;

  if p_kind='borrowed_funds' and p_share_with_counterparty then
    select s.shared_loan_id into v_shared_loan_id from private.shared_personal_loan_sources s
      where s.source_transaction_id=v_transaction_id;
    if found then
      select * into v_shared_loan from public.shared_personal_loans where id=v_shared_loan_id;
      if v_shared_loan.connection_id is distinct from p_loan_connection_id
        or v_shared_loan.borrower_user_id is distinct from v_actor
        or v_shared_loan.counterparty_user_id is distinct from p_loan_counterparty_id
        or v_shared_loan.principal_bigint is distinct from p_amount_bigint
        or v_shared_loan.accounting_date is distinct from p_accounting_date
        or v_shared_loan.lender_name is distinct from btrim(p_loan_lender_name)
        or v_shared_loan.purpose is distinct from btrim(p_loan_purpose) then
        raise exception 'idempotency key reused with different shared loan values' using errcode = '23505';
      end if;
    else
      insert into public.shared_personal_loans(connection_id,borrower_user_id,counterparty_user_id,lender_name,purpose,principal_bigint,accounting_date)
      values(p_loan_connection_id,v_actor,p_loan_counterparty_id,btrim(p_loan_lender_name),btrim(p_loan_purpose),p_amount_bigint,p_accounting_date)
      returning id into v_shared_loan_id;
      insert into private.shared_personal_loan_sources(source_transaction_id,shared_loan_id)
        values(v_transaction_id,v_shared_loan_id);
    end if;
  elsif p_kind='loan_principal_payment' and p_share_with_counterparty then
    select s.shared_payment_id into v_shared_payment_id from private.shared_personal_loan_payment_sources s
      where s.source_transaction_id=v_transaction_id;
    if found then
      select * into v_shared_payment from public.shared_personal_loan_payments where id=v_shared_payment_id;
      if v_shared_payment.shared_loan_id is distinct from v_shared_loan_id
        or v_shared_payment.amount_bigint is distinct from p_amount_bigint
        or v_shared_payment.accounting_date is distinct from p_accounting_date
        or v_shared_payment.reduces_balance is distinct from coalesce(p_affects_outstanding,false) then
        raise exception 'idempotency key reused with different shared repayment values' using errcode = '23505';
      end if;
    else
      insert into public.shared_personal_loan_payments(shared_loan_id,amount_bigint,accounting_date,reduces_balance,created_by)
      values(v_shared_loan_id,p_amount_bigint,p_accounting_date,coalesce(p_affects_outstanding,false),v_actor)
      returning id into v_shared_payment_id;
      insert into private.shared_personal_loan_payment_sources(source_transaction_id,shared_payment_id)
        values(v_transaction_id,v_shared_payment_id);
    end if;
  end if;

  return v_result || jsonb_build_object('loan_share_opt_in',p_share_with_counterparty,
    'shared_loan_id',case when p_kind='borrowed_funds' and p_share_with_counterparty then v_shared_loan_id else null end);
end;
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid,boolean) from public,anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid,boolean) to authenticated;
