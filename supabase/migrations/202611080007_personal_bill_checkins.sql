-- A personal bill check-in is one canonical expense plus optional private proof.
create table public.personal_bill_checkins (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null unique references public.transactions(id) on delete restrict,
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  caption text not null check (char_length(trim(caption)) between 1 and 240),
  storage_path text unique,
  created_at timestamptz not null default now(),
  unique(owner_id,idempotency_key),
  check (storage_path is null or storage_path ~ ('^'||owner_id::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'))
);
create index personal_bill_checkins_owner_feed_idx on public.personal_bill_checkins(owner_id,created_at desc,id desc);
alter table public.personal_bill_checkins enable row level security;
create policy "bill checkin owner reads own checkins" on public.personal_bill_checkins for select to authenticated
  using (owner_id=(select auth.uid()) and exists(select 1 from public.transactions t where t.id=transaction_id and t.owner_id=(select auth.uid())));
revoke all on public.personal_bill_checkins from public,anon;
grant select on public.personal_bill_checkins to authenticated;

create or replace function public.create_personal_bill_checkin(
  p_checkin_id uuid,p_wallet_id uuid,p_amount_bigint bigint,p_occurred_at timestamptz,
  p_accounting_date date,p_category_id uuid,p_caption text,p_storage_path text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_category_kind text;
  v_transaction_id uuid;
  v_payload jsonb;
  v_hash text;
  v_existing public.personal_bill_checkins%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_checkin_id is null or p_wallet_id is null or p_amount_bigint is null or p_amount_bigint<=0
    or p_occurred_at is null or p_accounting_date is null or p_idempotency_key is null
    or char_length(trim(coalesce(p_caption,''))) not between 1 and 240
    or (p_storage_path is not null and p_storage_path !~ ('^'||v_actor::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$')) then
    raise exception 'invalid bill check-in values' using errcode='22023';
  end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'wallet unavailable' using errcode='42501';
  end if;
  if p_category_id is not null then
    select kind into v_category_kind from public.categories where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found or v_category_kind<>'expense' then raise exception 'expense category unavailable' using errcode='42501'; end if;
  end if;
  if p_storage_path is not null and not exists(select 1 from storage.objects where bucket_id='receipt-files' and name=p_storage_path) then
    raise exception 'bill image is not stored in the private account folder' using errcode='42501';
  end if;

  v_payload := jsonb_build_object('wallet',p_wallet_id,'amount',p_amount_bigint::text,'occurred_at',p_occurred_at,
    'date',p_accounting_date,'category',p_category_id,'caption',trim(p_caption),'path',p_storage_path);
  v_hash := encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text||p_idempotency_key::text,0));
  select * into v_existing from public.personal_bill_checkins where owner_id=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash<>v_hash or v_existing.id<>p_checkin_id then
      raise exception 'idempotency key reused with different bill check-in values' using errcode='23505';
    end if;
    return jsonb_build_object('id',v_existing.id,'transaction_id',v_existing.transaction_id,'created',false);
  end if;
  if exists(select 1 from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key) then
    raise exception 'idempotency key already used by another transaction' using errcode='23505';
  end if;

  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,idempotency_key)
    values(v_actor,p_wallet_id,'expense',p_amount_bigint,p_occurred_at,p_accounting_date,p_category_id,trim(p_caption),p_idempotency_key)
    returning id into v_transaction_id;
  insert into public.personal_bill_checkins(id,owner_id,transaction_id,idempotency_key,request_hash,caption,storage_path)
    values(p_checkin_id,v_actor,v_transaction_id,p_idempotency_key,v_hash,trim(p_caption),p_storage_path);
  if p_storage_path is not null then
    insert into public.transaction_evidence(transaction_id,owner_id,storage_path)
      values(v_transaction_id,v_actor,p_storage_path);
  end if;
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
    values(v_actor,'personal_bill_checkin',p_checkin_id,'created',v_hash);
  return jsonb_build_object('id',p_checkin_id,'transaction_id',v_transaction_id,'created',true);
end;
$$;
revoke all on function public.create_personal_bill_checkin(uuid,uuid,bigint,timestamptz,date,uuid,text,text,uuid) from public,anon;
grant execute on function public.create_personal_bill_checkin(uuid,uuid,bigint,timestamptz,date,uuid,text,text,uuid) to authenticated;
