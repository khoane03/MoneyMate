-- Personal borrowing and principal repayments stay out of income/expense reports.
alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check check (kind in (
  'income','expense','loan_disbursement','loan_repayment','borrowed_funds','loan_principal_payment','adjustment',
  'transfer_out','transfer_in','settlement_payment'
));
alter table public.transactions add column affects_outstanding boolean not null default false;
alter table public.transactions add column loan_connection_id uuid references public.connections(id) on delete set null;
alter table public.transactions add column loan_counterparty_id uuid references auth.users(id) on delete set null;
alter table public.transactions add constraint transactions_outstanding_kind_check
  check (kind in ('borrowed_funds','loan_principal_payment') or not affects_outstanding);
create or replace view public.wallet_balances with (security_invoker = true) as
select w.id,w.owner_id,w.kind,w.display_name,w.opening_balance_bigint,w.status,
  w.opening_balance_bigint::numeric + coalesce(sum(case
    when t.kind in ('income','loan_repayment','borrowed_funds','transfer_in') then t.amount_bigint::numeric
    when t.kind in ('expense','loan_disbursement','loan_principal_payment','transfer_out') then -t.amount_bigint::numeric
    else 0::numeric end),0::numeric) as current_balance_bigint
from public.wallets w left join public.transactions t on t.wallet_id=w.id and t.owner_id=w.owner_id group by w.id;
create index transactions_owner_loan_history_idx on public.transactions(owner_id,created_at desc,id desc)
  where kind in ('borrowed_funds','loan_principal_payment');

create or replace function public.create_personal_transaction(
  p_wallet_id uuid,p_kind text,p_amount_bigint bigint,p_occurred_at timestamptz,p_accounting_date date,
  p_category_id uuid,p_note text,p_idempotency_key uuid,p_affects_outstanding boolean,
  p_loan_connection_id uuid,p_loan_counterparty_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_transaction public.transactions%rowtype;
  v_category_kind text;
  v_affects boolean := coalesce(p_affects_outstanding,false);
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_kind not in ('income','expense','loan_disbursement','loan_repayment','borrowed_funds','loan_principal_payment')
    or p_amount_bigint is null or p_amount_bigint<=0 or p_occurred_at is null or p_accounting_date is null
    or p_idempotency_key is null or char_length(coalesce(p_note,''))>1000 then
    raise exception 'invalid transaction values' using errcode = '22023';
  end if;
  if p_kind not in ('borrowed_funds','loan_principal_payment') and v_affects then
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
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'wallet unavailable' using errcode = '42501';
  end if;
  if p_category_id is not null then
    select kind into v_category_kind from public.categories where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found then raise exception 'category unavailable' using errcode = '42501'; end if;
    if p_kind in ('income','expense') and v_category_kind<>p_kind then raise exception 'category kind mismatch' using errcode = '23514'; end if;
  end if;
  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,idempotency_key,affects_outstanding,loan_connection_id,loan_counterparty_id)
  values(v_actor,p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,p_category_id,coalesce(p_note,''),p_idempotency_key,v_affects,p_loan_connection_id,p_loan_counterparty_id)
  on conflict(owner_id,idempotency_key) do nothing;
  select * into v_transaction from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key;
  if v_transaction.wallet_id<>p_wallet_id or v_transaction.kind<>p_kind or v_transaction.amount_bigint<>p_amount_bigint
    or v_transaction.occurred_at<>p_occurred_at or v_transaction.accounting_date<>p_accounting_date
    or v_transaction.category_id is distinct from p_category_id or v_transaction.note<>coalesce(p_note,'')
    or v_transaction.affects_outstanding<>v_affects or v_transaction.loan_connection_id is distinct from p_loan_connection_id
    or v_transaction.loan_counterparty_id is distinct from p_loan_counterparty_id then
    raise exception 'idempotency key reused with different transaction values' using errcode = '23505';
  end if;
  return jsonb_build_object('id',v_transaction.id,'wallet_id',v_transaction.wallet_id,'kind',v_transaction.kind,
    'amount',v_transaction.amount_bigint::text,'occurred_at',v_transaction.occurred_at,
    'accounting_date',v_transaction.accounting_date,'category_id',v_transaction.category_id,'note',v_transaction.note,
    'affects_outstanding',v_transaction.affects_outstanding,'loan_connection_id',v_transaction.loan_connection_id,
    'loan_counterparty_id',v_transaction.loan_counterparty_id,'version',v_transaction.version);
end;
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid) from public,anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid) to authenticated;

-- Keep older clients working with the previous RPC signature.
create or replace function public.create_personal_transaction(
  p_wallet_id uuid,p_kind text,p_amount_bigint bigint,p_occurred_at timestamptz,p_accounting_date date,
  p_category_id uuid,p_note text,p_idempotency_key uuid
) returns jsonb language sql security definer set search_path = '' as $$
  select public.create_personal_transaction(p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,
    p_category_id,p_note,p_idempotency_key,false,null,null);
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid) from public,anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid) to authenticated;
