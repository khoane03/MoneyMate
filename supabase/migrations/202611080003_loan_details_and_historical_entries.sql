alter table public.transactions
  alter column wallet_id drop not null,
  add column affects_wallet boolean not null default true,
  add column loan_origin_transaction_id uuid references public.transactions(id) on delete restrict,
  add constraint transactions_wallet_effect_kind_check
    check (kind in ('borrowed_funds','loan_principal_payment') or affects_wallet),
  add constraint transactions_loan_origin_kind_check
    check (loan_origin_transaction_id is null or kind='loan_principal_payment'),
  add constraint transactions_walletless_old_loan_check
    check (wallet_id is not null or (kind='borrowed_funds' and not affects_wallet));

create index transactions_owner_loan_origin_idx
  on public.transactions(owner_id,loan_origin_transaction_id)
  where loan_origin_transaction_id is not null;

-- Imported/old borrowings can create tracked liability without changing wallet cash.
create or replace view public.wallet_balances with (security_invoker = true) as
select w.id,w.owner_id,w.kind,w.display_name,w.opening_balance_bigint,w.status,
  w.opening_balance_bigint::numeric + coalesce(sum(case
    when t.kind in ('income','loan_repayment','transfer_in') then t.amount_bigint::numeric
    when t.kind='borrowed_funds' and t.affects_wallet then t.amount_bigint::numeric
    when t.kind in ('expense','loan_disbursement','transfer_out') then -t.amount_bigint::numeric
    when t.kind='loan_principal_payment' and t.affects_wallet then -t.amount_bigint::numeric
    else 0::numeric end),0::numeric) as current_balance_bigint
from public.wallets w left join public.transactions t on t.wallet_id=w.id and t.owner_id=w.owner_id group by w.id;
revoke all on public.wallet_balances from anon;
grant select on public.wallet_balances to authenticated;

-- Extended command adds a private origin-loan link, independent wallet effect,
-- and server-side outstanding-balance validation. Earlier overloads remain intact.
create or replace function public.create_personal_transaction(
  p_wallet_id uuid,p_kind text,p_amount_bigint bigint,p_occurred_at timestamptz,p_accounting_date date,
  p_category_id uuid,p_note text,p_idempotency_key uuid,p_affects_outstanding boolean,
  p_loan_connection_id uuid,p_loan_counterparty_id uuid,p_loan_lender_name text,p_loan_purpose text,
  p_affects_wallet boolean,p_loan_origin_transaction_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_lender text := nullif(btrim(p_loan_lender_name),'');
  v_purpose text := nullif(btrim(p_loan_purpose),'');
  v_category_kind text;
  v_transaction public.transactions%rowtype;
  v_origin public.transactions%rowtype;
  v_preexisting boolean;
  v_remaining numeric;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_kind not in ('income','expense','loan_disbursement','loan_repayment','borrowed_funds','loan_principal_payment')
    or p_amount_bigint is null or p_amount_bigint<=0 or p_occurred_at is null or p_accounting_date is null
    or p_idempotency_key is null or char_length(coalesce(p_note,''))>1000 or p_affects_wallet is null then
    raise exception 'invalid transaction values' using errcode = '22023';
  end if;
  if p_kind in ('borrowed_funds','loan_principal_payment') and p_affects_outstanding is null then
    raise exception 'outstanding effect must be explicit' using errcode = '22023';
  end if;
  if p_kind not in ('borrowed_funds','loan_principal_payment') and not p_affects_wallet then
    raise exception 'wallet effect is only configurable for personal loan entries' using errcode = '22023';
  end if;
  if p_kind='loan_principal_payment' and not p_affects_wallet then
    raise exception 'repayments must change wallet cash' using errcode = '22023';
  end if;
  if p_kind not in ('borrowed_funds','loan_principal_payment') and coalesce(p_affects_outstanding,false) then
    raise exception 'outstanding flag is only valid for personal loan entries' using errcode = '22023';
  end if;
  if p_kind in ('borrowed_funds','loan_principal_payment') and p_category_id is not null then
    raise exception 'loan entries use the built-in loan category' using errcode = '22023';
  end if;
  if (p_loan_connection_id is null) <> (p_loan_counterparty_id is null)
    or (p_loan_connection_id is not null and p_kind not in ('borrowed_funds','loan_principal_payment')) then
    raise exception 'invalid loan connection' using errcode = '22023';
  end if;
  if p_loan_connection_id is not null and not exists(
    select 1 from public.connections c join public.connection_members m on m.connection_id=c.id
    where c.id=p_loan_connection_id and c.status='active' and m.user_id=p_loan_counterparty_id
      and p_loan_counterparty_id<>v_actor and exists(select 1 from public.connection_members own_member
        where own_member.connection_id=c.id and own_member.user_id=v_actor)
  ) then raise exception 'loan counterparty is not an active connected member' using errcode = '42501'; end if;
  if p_kind='loan_principal_payment' and p_loan_origin_transaction_id is null then
    raise exception 'repayment must reference a loan' using errcode = '22023';
  end if;
  if p_kind<>'loan_principal_payment' and p_loan_origin_transaction_id is not null then
    raise exception 'only repayments can reference a loan' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text || p_idempotency_key::text,0));
  select exists(select 1 from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key) into v_preexisting;

  if p_kind='loan_principal_payment' then
    select * into v_origin from public.transactions
      where id=p_loan_origin_transaction_id and owner_id=v_actor and kind='borrowed_funds' and affects_outstanding
      for update;
    if not found then raise exception 'loan unavailable for repayment' using errcode = '42501'; end if;
    if v_lender is distinct from v_origin.loan_lender_name or v_purpose is distinct from v_origin.loan_purpose then
      raise exception 'repayment details must match the selected loan' using errcode = '22023';
    end if;
    if not v_preexisting and coalesce(p_affects_outstanding,false) then
      select v_origin.amount_bigint::numeric - coalesce(sum(t.amount_bigint::numeric),0::numeric)
        into v_remaining from public.transactions t
        where t.owner_id=v_actor and t.kind='loan_principal_payment'
          and t.loan_origin_transaction_id=p_loan_origin_transaction_id and t.affects_outstanding;
      if p_amount_bigint is null or p_amount_bigint<=0 or p_amount_bigint::numeric>v_remaining then
        raise exception 'repayment exceeds remaining loan balance' using errcode = '23514';
      end if;
    end if;
  elsif p_kind='borrowed_funds' then
    if v_lender is null or char_length(v_lender)>120 or v_purpose is null or char_length(v_purpose)>240 then
      raise exception 'loan lender and purpose are required' using errcode = '22023';
    end if;
  elsif p_loan_lender_name is not null or p_loan_purpose is not null then
    raise exception 'loan details are only valid for personal loan entries' using errcode = '22023';
  end if;

  if p_wallet_id is null then
    if p_kind<>'borrowed_funds' or p_affects_wallet then raise exception 'an active wallet is required' using errcode = '22023'; end if;
  elsif not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'wallet unavailable' using errcode = '42501';
  end if;
  if p_category_id is not null then
    select kind into v_category_kind from public.categories where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found then raise exception 'category unavailable' using errcode = '42501'; end if;
    if p_kind in ('income','expense') and v_category_kind<>p_kind then raise exception 'category kind mismatch' using errcode = '23514'; end if;
  end if;

  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,
    idempotency_key,affects_outstanding,loan_connection_id,loan_counterparty_id,loan_lender_name,loan_purpose,
    affects_wallet,loan_origin_transaction_id)
  values(v_actor,p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,p_category_id,coalesce(p_note,''),
    p_idempotency_key,coalesce(p_affects_outstanding,false),p_loan_connection_id,p_loan_counterparty_id,v_lender,v_purpose,
    p_affects_wallet,p_loan_origin_transaction_id)
  on conflict(owner_id,idempotency_key) do nothing;
  select * into v_transaction from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key;
  if v_transaction.wallet_id is distinct from p_wallet_id or v_transaction.kind<>p_kind or v_transaction.amount_bigint<>p_amount_bigint
    or v_transaction.occurred_at<>p_occurred_at or v_transaction.accounting_date<>p_accounting_date
    or v_transaction.category_id is distinct from p_category_id or v_transaction.note<>coalesce(p_note,'')
    or v_transaction.affects_outstanding<>coalesce(p_affects_outstanding,false)
    or v_transaction.loan_connection_id is distinct from p_loan_connection_id
    or v_transaction.loan_counterparty_id is distinct from p_loan_counterparty_id
    or v_transaction.loan_lender_name is distinct from v_lender or v_transaction.loan_purpose is distinct from v_purpose
    or v_transaction.affects_wallet is distinct from p_affects_wallet
    or v_transaction.loan_origin_transaction_id is distinct from p_loan_origin_transaction_id then
    raise exception 'idempotency key reused with different transaction values' using errcode = '23505';
  end if;
  return jsonb_build_object('id',v_transaction.id,'wallet_id',v_transaction.wallet_id,'kind',v_transaction.kind,
    'amount',v_transaction.amount_bigint::text,'occurred_at',v_transaction.occurred_at,
    'accounting_date',v_transaction.accounting_date,'category_id',v_transaction.category_id,'note',v_transaction.note,
    'affects_outstanding',v_transaction.affects_outstanding,'loan_connection_id',v_transaction.loan_connection_id,
    'loan_counterparty_id',v_transaction.loan_counterparty_id,'loan_lender_name',v_transaction.loan_lender_name,
    'loan_purpose',v_transaction.loan_purpose,'affects_wallet',v_transaction.affects_wallet,
    'loan_origin_transaction_id',v_transaction.loan_origin_transaction_id,'version',v_transaction.version);
end;
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid) from public,anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid) to authenticated;
