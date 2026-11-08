alter table public.wallets add column idempotency_key uuid not null default gen_random_uuid();
alter table public.wallets add constraint wallets_owner_idempotency_unique unique(owner_id,idempotency_key);

create or replace function public.create_wallet(
  p_id uuid,
  p_kind text,
  p_display_name text,
  p_opening_balance bigint,
  p_idempotency_key uuid
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_wallet public.wallets%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_id is null or p_idempotency_key is null or p_kind not in ('cash','bank','ewallet','credit')
     or p_opening_balance < 0 or p_opening_balance > 9223372036854775807
     or char_length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'invalid wallet values' using errcode = '22023';
  end if;

  insert into public.wallets(id,owner_id,kind,display_name,opening_balance_bigint,idempotency_key)
  values(p_id,v_actor,p_kind,trim(p_display_name),p_opening_balance,p_idempotency_key)
  on conflict(owner_id,idempotency_key) do nothing;
  select * into v_wallet from public.wallets where owner_id = v_actor and idempotency_key = p_idempotency_key;
  if v_wallet.kind <> p_kind or v_wallet.display_name <> trim(p_display_name) or v_wallet.opening_balance_bigint <> p_opening_balance then
    raise exception 'idempotency key reused with different wallet values' using errcode = '23505';
  end if;
  return jsonb_build_object('id',v_wallet.id,'kind',v_wallet.kind,'display_name',v_wallet.display_name,
    'opening_balance',v_wallet.opening_balance_bigint::text,'status',v_wallet.status,'version',v_wallet.version);
end;
$$;

revoke all on function public.create_wallet(uuid,text,text,bigint,uuid) from public, anon;
grant execute on function public.create_wallet(uuid,text,text,bigint,uuid) to authenticated;
