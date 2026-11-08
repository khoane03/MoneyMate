-- Shared repayments are proposals. Neither wallet moves until the lender confirms.
alter table public.shared_personal_loan_payments
  add column status text not null default 'confirmed'
    check (status in ('pending','confirmed','rejected','cancelled')),
  add column resolved_by uuid references auth.users(id) on delete restrict,
  add column resolved_at timestamptz;

create table private.shared_loan_repayment_drafts (
  shared_payment_id uuid primary key references public.shared_personal_loan_payments(id) on delete restrict,
  source_transaction_id uuid not null references public.transactions(id) on delete restrict,
  payer_wallet_id uuid not null references public.wallets(id) on delete restrict,
  payer_occurred_at timestamptz not null,
  payer_note text not null,
  payer_idempotency_key uuid not null,
  receiver_wallet_id uuid references public.wallets(id) on delete restrict,
  receiver_transaction_id uuid references public.transactions(id) on delete restrict,
  payer_transaction_id uuid references public.transactions(id) on delete restrict,
  unique (source_transaction_id,payer_idempotency_key)
);
revoke all on private.shared_loan_repayment_drafts from public,anon,authenticated;

alter table public.transactions drop constraint transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check check (kind in (
  'income','expense','loan_disbursement','loan_repayment','borrowed_funds','loan_principal_payment','adjustment',
  'transfer_out','transfer_in','settlement_payment','loan_repayment_received'
));

create or replace view public.wallet_balances with (security_invoker = true) as
select w.id,w.owner_id,w.kind,w.display_name,w.opening_balance_bigint,w.status,
  w.opening_balance_bigint::numeric + coalesce(sum(case
    when t.kind in ('income','loan_repayment','transfer_in','loan_repayment_received') then t.amount_bigint::numeric
    when t.kind='borrowed_funds' and t.affects_wallet then t.amount_bigint::numeric
    when t.kind in ('expense','loan_disbursement','transfer_out') then -t.amount_bigint::numeric
    when t.kind='loan_principal_payment' and t.affects_wallet then -t.amount_bigint::numeric
    else 0::numeric end),0::numeric) as current_balance_bigint
from public.wallets w left join public.transactions t on t.wallet_id=w.id and t.owner_id=w.owner_id group by w.id;
revoke all on public.wallet_balances from anon;
grant select on public.wallet_balances to authenticated;

-- Replace the shared wrapper. A shared repayment is stored as pending and does
-- not call the private transaction creator until the lender approves it.
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
  v_draft private.shared_loan_repayment_drafts%rowtype;
  v_source_is_shared boolean := false;
  v_origin public.transactions%rowtype;
  v_remaining numeric;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_share_with_counterparty is null then raise exception 'sharing choice must be explicit' using errcode = '22023'; end if;
  if p_kind not in ('borrowed_funds','loan_principal_payment') and p_share_with_counterparty then
    raise exception 'only personal loan entries can be shared' using errcode = '22023';
  end if;
  if p_kind='loan_principal_payment' then
    select s.shared_loan_id into v_shared_loan_id from private.shared_personal_loan_sources s
      where s.source_transaction_id=p_loan_origin_transaction_id;
    v_source_is_shared := found;
    if p_share_with_counterparty is distinct from v_source_is_shared then
      raise exception 'repayment sharing must match the selected loan' using errcode = '22023';
    end if;
    if v_source_is_shared then
      if p_wallet_id is null or not exists(select 1 from public.wallets w where w.id=p_wallet_id and w.owner_id=v_actor and w.status='active') then
        raise exception 'wallet unavailable' using errcode = '42501';
      end if;
      select * into v_shared_loan from public.shared_personal_loans where id=v_shared_loan_id;
      if v_shared_loan.borrower_user_id<>v_actor or v_shared_loan.connection_id is distinct from p_loan_connection_id
        or v_shared_loan.counterparty_user_id is distinct from p_loan_counterparty_id then
        raise exception 'repayment must stay linked to the same loan participants' using errcode = '22023';
      end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text || p_idempotency_key::text,0));
      select * into v_origin from public.transactions where id=p_loan_origin_transaction_id and owner_id=v_actor
        and kind='borrowed_funds' and affects_outstanding for update;
      if not found then raise exception 'loan unavailable for repayment' using errcode = '42501'; end if;
      select p.id into v_shared_payment_id from public.shared_personal_loan_payments p
        join private.shared_loan_repayment_drafts d on d.shared_payment_id=p.id
        where d.source_transaction_id=v_origin.id and d.payer_idempotency_key=p_idempotency_key;
      if found then
        select * into v_shared_payment from public.shared_personal_loan_payments where id=v_shared_payment_id;
        select * into v_draft from private.shared_loan_repayment_drafts where shared_payment_id=v_shared_payment_id;
        if v_shared_payment.amount_bigint<>p_amount_bigint or v_shared_payment.accounting_date<>p_accounting_date
          or v_shared_payment.reduces_balance<>coalesce(p_affects_outstanding,false)
          or v_draft.payer_wallet_id<>p_wallet_id or v_draft.payer_occurred_at<>p_occurred_at
          or v_draft.payer_note<>coalesce(p_note,'') then
          raise exception 'idempotency key reused with different shared repayment values' using errcode = '23505';
        end if;
        return jsonb_build_object('id',v_shared_payment.id,'status',v_shared_payment.status,'shared_payment_id',v_shared_payment.id);
      end if;
      select v_origin.amount_bigint::numeric
        - coalesce((select sum(t.amount_bigint::numeric) from public.transactions t where t.owner_id=v_actor
          and t.kind='loan_principal_payment' and t.loan_origin_transaction_id=v_origin.id and t.affects_outstanding),0::numeric)
        - coalesce((select sum(p.amount_bigint::numeric) from public.shared_personal_loan_payments p
          join private.shared_loan_repayment_drafts d on d.shared_payment_id=p.id
          where d.source_transaction_id=v_origin.id and p.status='pending' and p.reduces_balance),0::numeric)
        into v_remaining;
      if p_amount_bigint is null or p_amount_bigint<=0 or (coalesce(p_affects_outstanding,false) and p_amount_bigint::numeric>v_remaining) then
        raise exception 'repayment exceeds remaining loan balance' using errcode = '23514';
      end if;
      insert into public.shared_personal_loan_payments(shared_loan_id,amount_bigint,accounting_date,reduces_balance,created_by,status)
        values(v_shared_loan_id,p_amount_bigint,p_accounting_date,coalesce(p_affects_outstanding,false),v_actor,'pending') returning id into v_shared_payment_id;
      insert into private.shared_loan_repayment_drafts(shared_payment_id,source_transaction_id,payer_wallet_id,payer_occurred_at,
        payer_note,payer_idempotency_key)
        values(v_shared_payment_id,v_origin.id,p_wallet_id,p_occurred_at,coalesce(p_note,''),p_idempotency_key);
      return jsonb_build_object('id',v_shared_payment_id,'status','pending','shared_payment_id',v_shared_payment_id);
    end if;
    if p_loan_connection_id is not null or p_loan_counterparty_id is not null then
      raise exception 'a private loan repayment cannot be newly linked to another member' using errcode = '22023';
    end if;
  elsif p_kind='borrowed_funds' then
    if p_share_with_counterparty is distinct from (p_loan_connection_id is not null and p_loan_counterparty_id is not null) then
      raise exception 'choose a connected counterparty to share this loan' using errcode = '22023';
    end if;
    if p_share_with_counterparty and not coalesce(p_affects_outstanding,false) then
      raise exception 'a shared loan must be included in tracked outstanding debt' using errcode = '22023';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text || p_idempotency_key::text,0));
  select exists(select 1 from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key) into v_preexisting;
  v_result := public.create_personal_transaction(p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,
    p_category_id,p_note,p_idempotency_key,p_affects_outstanding,p_loan_connection_id,p_loan_counterparty_id,
    p_loan_lender_name,p_loan_purpose,p_affects_wallet,p_loan_origin_transaction_id);
  v_transaction_id := (v_result->>'id')::uuid;
  if v_preexisting then
    select loan_share_opt_in into v_saved_share_opt_in from public.transactions where id=v_transaction_id and owner_id=v_actor;
    if v_saved_share_opt_in is distinct from p_share_with_counterparty then raise exception 'idempotency key reused with a different sharing choice' using errcode = '23505'; end if;
  else
    update public.transactions set loan_share_opt_in=p_share_with_counterparty where id=v_transaction_id and owner_id=v_actor;
  end if;
  if p_kind='borrowed_funds' and p_share_with_counterparty then
    select s.shared_loan_id into v_shared_loan_id from private.shared_personal_loan_sources s where s.source_transaction_id=v_transaction_id;
    if not found then
      insert into public.shared_personal_loans(connection_id,borrower_user_id,counterparty_user_id,lender_name,purpose,principal_bigint,accounting_date)
        values(p_loan_connection_id,v_actor,p_loan_counterparty_id,btrim(p_loan_lender_name),btrim(p_loan_purpose),p_amount_bigint,p_accounting_date) returning id into v_shared_loan_id;
      insert into private.shared_personal_loan_sources(source_transaction_id,shared_loan_id) values(v_transaction_id,v_shared_loan_id);
    end if;
  end if;
  return v_result || jsonb_build_object('loan_share_opt_in',p_share_with_counterparty,
    'shared_loan_id',case when p_kind='borrowed_funds' and p_share_with_counterparty then v_shared_loan_id else null end);
end;
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid,boolean) from public,anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid,boolean) to authenticated;

create or replace function public.resolve_shared_loan_repayment(
  p_shared_payment_id uuid,p_receiver_wallet_id uuid,p_approve boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_payment public.shared_personal_loan_payments%rowtype;
  v_loan public.shared_personal_loans%rowtype; v_draft private.shared_loan_repayment_drafts%rowtype;
  v_origin public.transactions%rowtype; v_payer_result jsonb; v_receiver_result jsonb;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_payment from public.shared_personal_loan_payments where id=p_shared_payment_id for update;
  if not found or v_payment.status<>'pending' then raise exception 'repayment is no longer pending' using errcode='23514'; end if;
  select * into v_loan from public.shared_personal_loans where id=v_payment.shared_loan_id for update;
  if v_loan.counterparty_user_id<>v_actor or not public.is_active_connection_member(v_loan.connection_id)
    or not exists(select 1 from public.connection_members m where m.connection_id=v_loan.connection_id and m.user_id=v_loan.borrower_user_id) then
    raise exception 'only the connected lender can resolve this repayment' using errcode='42501'; end if;
  if p_approve then
    if p_receiver_wallet_id is null or not exists(select 1 from public.wallets w where w.id=p_receiver_wallet_id and w.owner_id=v_actor and w.status='active') then
      raise exception 'choose one of your active wallets' using errcode='42501'; end if;
    select * into v_draft from private.shared_loan_repayment_drafts where shared_payment_id=v_payment.id for update;
    select * into v_origin from public.transactions where id=v_draft.source_transaction_id and owner_id=v_loan.borrower_user_id and kind='borrowed_funds' for update;
    if not found then raise exception 'source loan unavailable' using errcode='42501'; end if;
    insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,
      idempotency_key,affects_outstanding,loan_connection_id,loan_counterparty_id,loan_lender_name,loan_purpose,affects_wallet,loan_origin_transaction_id,loan_share_opt_in)
      values(v_loan.borrower_user_id,v_draft.payer_wallet_id,'loan_principal_payment',v_payment.amount_bigint,
        v_draft.payer_occurred_at,v_payment.accounting_date,null,v_draft.payer_note,v_draft.payer_idempotency_key,
        v_payment.reduces_balance,v_loan.connection_id,v_loan.counterparty_user_id,v_origin.loan_lender_name,v_origin.loan_purpose,true,v_origin.id,true)
      on conflict(owner_id,idempotency_key) do nothing;
    select jsonb_build_object('id',t.id) into v_payer_result from public.transactions t
      where t.owner_id=v_loan.borrower_user_id and t.idempotency_key=v_draft.payer_idempotency_key;
    insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,
      idempotency_key,affects_outstanding,loan_connection_id,loan_counterparty_id,loan_lender_name,loan_purpose,affects_wallet,loan_origin_transaction_id)
      values(v_actor,p_receiver_wallet_id,'loan_repayment_received',v_payment.amount_bigint,v_draft.payer_occurred_at,
        v_payment.accounting_date,null,'Nhận trả nợ: '||v_loan.purpose,v_payment.id,false,null,null,null,null,true,null)
      on conflict(owner_id,idempotency_key) do nothing;
    select jsonb_build_object('id',t.id) into v_receiver_result from public.transactions t
      where t.owner_id=v_actor and t.idempotency_key=v_payment.id;
    update private.shared_loan_repayment_drafts set receiver_wallet_id=p_receiver_wallet_id,
      payer_transaction_id=(v_payer_result->>'id')::uuid,receiver_transaction_id=(v_receiver_result->>'id')::uuid where shared_payment_id=v_payment.id;
    update public.shared_personal_loan_payments set status='confirmed',resolved_by=v_actor,resolved_at=now() where id=v_payment.id;
    insert into private.shared_personal_loan_payment_sources(source_transaction_id,shared_payment_id)
      values((v_payer_result->>'id')::uuid,v_payment.id) on conflict do nothing;
  else
    update public.shared_personal_loan_payments set status='rejected',resolved_by=v_actor,resolved_at=now() where id=v_payment.id;
  end if;
  return jsonb_build_object('id',v_payment.id,'status',case when p_approve then 'confirmed' else 'rejected' end);
end;
$$;
revoke all on function public.resolve_shared_loan_repayment(uuid,uuid,boolean) from public,anon;
grant execute on function public.resolve_shared_loan_repayment(uuid,uuid,boolean) to authenticated;

create or replace function public.cancel_shared_loan_repayment(p_shared_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_payment public.shared_personal_loan_payments%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  select * into v_payment from public.shared_personal_loan_payments where id=p_shared_payment_id for update;
  if not found or v_payment.status<>'pending' or v_payment.created_by<>v_actor then raise exception 'cannot cancel this repayment' using errcode='42501'; end if;
  update public.shared_personal_loan_payments set status='cancelled',resolved_by=v_actor,resolved_at=now() where id=v_payment.id;
  return jsonb_build_object('id',v_payment.id,'status','cancelled');
end;
$$;
revoke all on function public.cancel_shared_loan_repayment(uuid) from public,anon;
grant execute on function public.cancel_shared_loan_repayment(uuid) to authenticated;

-- Prevent older write overloads from bypassing the shared confirmation step.
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text,boolean,uuid) from public,anon,authenticated;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid) from public,anon,authenticated;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid) from public,anon,authenticated;
