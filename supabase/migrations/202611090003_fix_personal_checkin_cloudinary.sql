-- Keep Check-in uploads private and validate the reserved Cloudinary asset
-- before writing the canonical expense and evidence rows.
alter table public.personal_bill_checkins
  drop constraint if exists personal_bill_checkins_check;
alter table public.personal_bill_checkins
  drop constraint if exists personal_bill_checkins_cloudinary_path_check;
alter table public.personal_bill_checkins
  add constraint personal_bill_checkins_cloudinary_path_check check (
    storage_path is null or storage_path ~ (
      '^moneymate/'||owner_id::text||'/bill-checkin/[0-9a-f-]{36}$'
    )
  );

create or replace function public.create_personal_bill_checkin(
  p_checkin_id uuid,p_wallet_id uuid,p_amount_bigint bigint,p_occurred_at timestamptz,
  p_accounting_date date,p_category_id uuid,p_caption text,p_storage_path text,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_category_kind text; v_transaction_id uuid; v_payload jsonb;
  v_hash text; v_existing public.personal_bill_checkins%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_checkin_id is null or p_wallet_id is null or p_amount_bigint is null or p_amount_bigint<=0
    or p_occurred_at is null or p_accounting_date is null or p_idempotency_key is null
    or char_length(trim(coalesce(p_caption,''))) not between 1 and 240
    or (p_storage_path is not null and p_storage_path !~ ('^moneymate/'||v_actor::text||'/bill-checkin/[0-9a-f-]{36}$')) then
    raise exception 'invalid bill check-in values' using errcode='22023';
  end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'wallet unavailable' using errcode='42501';
  end if;
  if p_category_id is not null then
    select kind into v_category_kind from public.categories where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found or v_category_kind<>'expense' then raise exception 'expense category unavailable' using errcode='42501'; end if;
  end if;
  if p_storage_path is not null and not exists(select 1 from public.media_assets where public_id=p_storage_path
    and uploaded_by=v_actor and purpose='bill-checkin' and state='ready') then
    raise exception 'bill image is not a verified private Cloudinary asset' using errcode='42501';
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
    insert into public.transaction_evidence(transaction_id,owner_id,storage_path) values(v_transaction_id,v_actor,p_storage_path);
  end if;
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
    values(v_actor,'personal_bill_checkin',p_checkin_id,'created',v_hash);
  return jsonb_build_object('id',p_checkin_id,'transaction_id',v_transaction_id,'created',true);
end;
$$;
revoke all on function public.create_personal_bill_checkin(uuid,uuid,bigint,timestamptz,date,uuid,text,text,uuid) from public,anon;
grant execute on function public.create_personal_bill_checkin(uuid,uuid,bigint,timestamptz,date,uuid,text,text,uuid) to authenticated;
