-- Wallet reconciliation and transaction editing capabilities
create or replace function public.reconcile_wallet_balance(
  p_wallet_id uuid,
  p_target_balance bigint,
  p_accounting_date date default current_date,
  p_note text default 'Điều chỉnh số dư ví',
  p_idempotency_key uuid default gen_random_uuid()
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_wallet public.wallets%rowtype;
  v_current_balance numeric;
  v_diff numeric;
  v_kind text;
  v_tx_id uuid;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_wallet_id is null or p_target_balance is null or p_accounting_date is null then
    raise exception 'invalid reconciliation parameters' using errcode = '22023';
  end if;

  select * into v_wallet from public.wallets where id = p_wallet_id and owner_id = v_actor and status = 'active';
  if not found then raise exception 'wallet unavailable' using errcode = '42501'; end if;

  select current_balance_bigint into v_current_balance from public.wallet_balances where id = p_wallet_id;
  if v_current_balance is null then v_current_balance := v_wallet.opening_balance_bigint::numeric; end if;

  v_diff := p_target_balance::numeric - v_current_balance;

  if v_diff = 0 then
    return jsonb_build_object('success', true, 'difference', '0', 'current_balance', p_target_balance::text);
  end if;

  if v_diff > 0 then
    v_kind := 'income';
  else
    v_kind := 'expense';
    v_diff := -v_diff;
  end if;

  insert into public.transactions (
    owner_id, wallet_id, kind, amount_bigint, occurred_at, accounting_date,
    note, idempotency_key, affects_outstanding, affects_wallet
  )
  values (
    v_actor, p_wallet_id, v_kind, v_diff::bigint, (p_accounting_date::text || 'T12:00:00+07:00')::timestamptz, p_accounting_date,
    coalesce(nullif(trim(p_note), ''), 'Điều chỉnh số dư ví'), p_idempotency_key, false, true
  )
  on conflict (owner_id, idempotency_key) do nothing
  returning id into v_tx_id;

  return jsonb_build_object(
    'success', true,
    'difference', case when v_kind = 'income' then v_diff::text else ('-' || v_diff::text) end,
    'current_balance', p_target_balance::text,
    'transaction_id', v_tx_id
  );
end;
$$;
revoke all on function public.reconcile_wallet_balance(uuid,bigint,date,text,uuid) from public, anon;
grant execute on function public.reconcile_wallet_balance(uuid,bigint,date,text,uuid) to authenticated;

create or replace function public.update_personal_transaction(
  p_id uuid,
  p_wallet_id uuid,
  p_amount_bigint bigint,
  p_accounting_date date,
  p_category_id uuid,
  p_note text,
  p_loan_lender_name text default null,
  p_loan_purpose text default null
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_tx public.transactions%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_id is null or p_amount_bigint is null or p_amount_bigint <= 0 or p_accounting_date is null then
    raise exception 'invalid parameters' using errcode = '22023';
  end if;

  select * into v_tx from public.transactions where id = p_id and owner_id = v_actor for update;
  if not found then raise exception 'transaction not found' using errcode = '42501'; end if;

  -- Validate wallet if specified
  if p_wallet_id is not null and not exists (select 1 from public.wallets where id = p_wallet_id and owner_id = v_actor and status = 'active') then
    raise exception 'wallet unavailable' using errcode = '42501';
  end if;

  -- Validate category if specified
  if p_category_id is not null and not exists (
    select 1 from public.categories where id = p_category_id and (owner_id is null or owner_id = v_actor)
  ) then
    raise exception 'category unavailable' using errcode = '42501';
  end if;

  -- If this transaction belongs to a transfer, update the transfer and the paired transaction too
  if v_tx.transfer_id is not null then
    update public.transfers
      set amount_bigint = p_amount_bigint,
          occurred_at = (p_accounting_date::text || 'T12:00:00+07:00')::timestamptz,
          updated_at = pg_catalog.now()
      where id = v_tx.transfer_id and owner_id = v_actor;

    update public.transactions
      set amount_bigint = p_amount_bigint,
          accounting_date = p_accounting_date,
          occurred_at = (p_accounting_date::text || 'T12:00:00+07:00')::timestamptz,
          note = coalesce(p_note, note),
          updated_at = pg_catalog.now()
      where transfer_id = v_tx.transfer_id and owner_id = v_actor;

    return jsonb_build_object('success', true, 'id', p_id);
  end if;

  -- Update personal transaction
  update public.transactions
    set wallet_id = coalesce(p_wallet_id, wallet_id),
        amount_bigint = p_amount_bigint,
        accounting_date = p_accounting_date,
        occurred_at = (p_accounting_date::text || 'T12:00:00+07:00')::timestamptz,
        category_id = case when v_tx.kind in ('borrowed_funds', 'loan_principal_payment') then null else p_category_id end,
        note = coalesce(p_note, ''),
        loan_lender_name = case when v_tx.kind in ('borrowed_funds', 'loan_principal_payment') then coalesce(p_loan_lender_name, loan_lender_name) else loan_lender_name end,
        loan_purpose = case when v_tx.kind in ('borrowed_funds', 'loan_principal_payment') then coalesce(p_loan_purpose, loan_purpose) else loan_purpose end,
        updated_at = pg_catalog.now()
    where id = p_id and owner_id = v_actor;

  return jsonb_build_object('success', true, 'id', p_id);
end;
$$;
revoke all on function public.update_personal_transaction(uuid,uuid,bigint,date,uuid,text,text,text) from public, anon;
grant execute on function public.update_personal_transaction(uuid,uuid,bigint,date,uuid,text,text,text) to authenticated;

create or replace function public.delete_personal_transaction(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_tx public.transactions%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_tx from public.transactions where id = p_id and owner_id = v_actor for update;
  if not found then raise exception 'transaction not found' using errcode = '42501'; end if;

  -- If it belongs to a transfer, delete both paired transactions and the transfer record
  if v_tx.transfer_id is not null then
    delete from public.transactions where transfer_id = v_tx.transfer_id and owner_id = v_actor;
    delete from public.transfers where id = v_tx.transfer_id and owner_id = v_actor;
    return jsonb_build_object('success', true, 'deleted_transfer', true);
  end if;

  -- Remove transaction evidence reference if exists
  delete from public.transaction_evidence where transaction_id = p_id and owner_id = v_actor;
  delete from public.transactions where id = p_id and owner_id = v_actor;

  return jsonb_build_object('success', true, 'id', p_id);
end;
$$;
revoke all on function public.delete_personal_transaction(uuid) from public, anon;
grant execute on function public.delete_personal_transaction(uuid) to authenticated;
