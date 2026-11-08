create or replace function public.create_personal_transaction(
  p_wallet_id uuid,
  p_kind text,
  p_amount_bigint bigint,
  p_occurred_at timestamptz,
  p_accounting_date date,
  p_category_id uuid,
  p_note text,
  p_idempotency_key uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_transaction public.transactions%rowtype;
  v_category_kind text;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_kind not in ('income','expense','loan_disbursement','loan_repayment')
    or p_amount_bigint is null or p_amount_bigint <= 0
    or p_occurred_at is null or p_accounting_date is null
    or p_idempotency_key is null or char_length(coalesce(p_note,'')) > 1000 then
    raise exception 'invalid transaction values' using errcode = '22023';
  end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'wallet unavailable' using errcode = '42501';
  end if;
  if p_category_id is not null then
    select kind into v_category_kind from public.categories
      where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found then raise exception 'category unavailable' using errcode = '42501'; end if;
    if p_kind in ('income','expense') and v_category_kind <> p_kind then
      raise exception 'category kind mismatch' using errcode = '23514';
    end if;
  end if;
  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,idempotency_key)
  values(v_actor,p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,p_category_id,coalesce(p_note,''),p_idempotency_key)
  on conflict(owner_id,idempotency_key) do nothing;
  select * into v_transaction from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key;
  if v_transaction.wallet_id <> p_wallet_id or v_transaction.kind <> p_kind
    or v_transaction.amount_bigint <> p_amount_bigint or v_transaction.occurred_at <> p_occurred_at
    or v_transaction.accounting_date <> p_accounting_date or v_transaction.category_id is distinct from p_category_id
    or v_transaction.note <> coalesce(p_note,'') then
    raise exception 'idempotency key reused with different transaction values' using errcode = '23505';
  end if;
  return jsonb_build_object('id',v_transaction.id,'wallet_id',v_transaction.wallet_id,'kind',v_transaction.kind,
    'amount',v_transaction.amount_bigint::text,'occurred_at',v_transaction.occurred_at,
    'accounting_date',v_transaction.accounting_date,'category_id',v_transaction.category_id,'note',v_transaction.note,
    'version',v_transaction.version);
end;
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid) from public, anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid) to authenticated;
