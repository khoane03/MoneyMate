-- Transfers create two balanced, auditable wallet movements without income/expense classification.
alter table public.transactions drop constraint transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('income','expense','loan_disbursement','loan_repayment','adjustment','transfer_out','transfer_in'));
alter table public.transactions add column transfer_id uuid references public.transfers(id) on delete restrict;

create or replace function public.create_wallet_transfer(
  p_from_wallet_id uuid,
  p_to_wallet_id uuid,
  p_amount_bigint bigint,
  p_occurred_at timestamptz,
  p_idempotency_key uuid
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_transfer public.transfers%rowtype;
  v_created boolean := false;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_amount_bigint is null or p_amount_bigint <= 0 or p_idempotency_key is null or p_occurred_at is null then
    raise exception 'invalid transfer values' using errcode = '22023';
  end if;
  if p_from_wallet_id = p_to_wallet_id then raise exception 'wallets must differ' using errcode = '22023'; end if;
  if not exists (select 1 from public.wallets where id = p_from_wallet_id and owner_id = v_actor and status = 'active')
     or not exists (select 1 from public.wallets where id = p_to_wallet_id and owner_id = v_actor and status = 'active') then
    raise exception 'wallet unavailable' using errcode = '42501';
  end if;

  insert into public.transfers(owner_id,from_wallet_id,to_wallet_id,amount_bigint,occurred_at,idempotency_key)
  values (v_actor,p_from_wallet_id,p_to_wallet_id,p_amount_bigint,p_occurred_at,p_idempotency_key)
  on conflict (owner_id,idempotency_key) do nothing
  returning * into v_transfer;
  v_created := v_transfer.id is not null;
  if not v_created then
    select * into v_transfer from public.transfers where owner_id = v_actor and idempotency_key = p_idempotency_key;
    if v_transfer.from_wallet_id <> p_from_wallet_id or v_transfer.to_wallet_id <> p_to_wallet_id
      or v_transfer.amount_bigint <> p_amount_bigint or v_transfer.occurred_at <> p_occurred_at then
      raise exception 'idempotency key reused with different transfer values' using errcode = '23505';
    end if;
  else
    insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,note,idempotency_key,transfer_id)
    values
      (v_actor,p_from_wallet_id,'transfer_out',p_amount_bigint,p_occurred_at,(p_occurred_at at time zone 'Asia/Ho_Chi_Minh')::date,'Chuyển tiền',gen_random_uuid(),v_transfer.id),
      (v_actor,p_to_wallet_id,'transfer_in',p_amount_bigint,p_occurred_at,(p_occurred_at at time zone 'Asia/Ho_Chi_Minh')::date,'Nhận chuyển tiền',gen_random_uuid(),v_transfer.id);
  end if;
  return jsonb_build_object('transfer_id',v_transfer.id,'amount',p_amount_bigint::text,'created',v_created);
end;
$$;

revoke all on function public.create_wallet_transfer(uuid,uuid,bigint,timestamptz,uuid) from public, anon;
grant execute on function public.create_wallet_transfer(uuid,uuid,bigint,timestamptz,uuid) to authenticated;
