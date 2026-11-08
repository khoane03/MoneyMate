-- Private receipt metadata is owned by one account unless a future explicit sharing
-- workflow grants access. Receipt confirmation creates exactly one expense transaction.
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null unique references public.transactions(id) on delete restrict,
  storage_path text not null,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  original_name text not null check (char_length(original_name) between 1 and 255),
  merchant text not null default '' check (char_length(merchant) <= 160),
  occurred_at timestamptz not null,
  accounting_date date not null,
  total_bigint bigint not null check (total_bigint > 0),
  ocr_confidence numeric(5,2) check (ocr_confidence between 0 and 100),
  verified_at timestamptz not null default now(),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (owner_id,idempotency_key),
  unique (storage_path)
);
create index receipts_owner_date_idx on public.receipts(owner_id,accounting_date desc);

create table public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete restrict,
  position integer not null check (position between 0 and 99),
  name text not null check (char_length(trim(name)) between 1 and 120),
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price_bigint bigint not null check (unit_price_bigint > 0),
  line_total_bigint bigint not null check (line_total_bigint > 0),
  confidence numeric(5,2) check (confidence between 0 and 100),
  unique (receipt_id,position)
);
create index receipt_items_receipt_idx on public.receipt_items(receipt_id,position);

alter table public.receipts enable row level security;
alter table public.receipt_items enable row level security;
create policy "receipt owner reads receipt" on public.receipts for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "receipt owner reads items" on public.receipt_items for select to authenticated
  using (exists (select 1 from public.receipts r where r.id=receipt_id and r.owner_id=(select auth.uid())));
revoke all on public.receipts,public.receipt_items from anon,authenticated;
grant select on public.receipts,public.receipt_items to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('receipt-files','receipt-files',false,15728640,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false,file_size_limit=15728640,allowed_mime_types=array['image/jpeg','image/png','image/webp'];

create policy "receipt owner uploads private image" on storage.objects for insert to authenticated
  with check (bucket_id='receipt-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "receipt owner reads private image" on storage.objects for select to authenticated
  using (bucket_id='receipt-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "receipt owner retries private image upload" on storage.objects for update to authenticated
  using (bucket_id='receipt-files' and (storage.foldername(name))[1]=(select auth.uid())::text)
  with check (bucket_id='receipt-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "receipt owner removes private image" on storage.objects for delete to authenticated
  using (bucket_id='receipt-files' and (storage.foldername(name))[1]=(select auth.uid())::text);

create or replace function public.create_receipt_expense(
  p_receipt_id uuid,p_wallet_id uuid,p_category_id uuid,p_merchant text,
  p_occurred_at timestamptz,p_accounting_date date,p_total_bigint bigint,
  p_storage_path text,p_checksum text,p_original_name text,p_ocr_confidence numeric,
  p_items jsonb,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_item jsonb;
  v_position integer := 0;
  v_quantity numeric;
  v_unit_price bigint;
  v_line_total bigint;
  v_calculated_total bigint := 0;
  v_kind text;
  v_hash text;
  v_payload jsonb;
  v_existing public.receipts%rowtype;
  v_transaction_id uuid;
  v_receipt public.receipts%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_receipt_id is null or p_wallet_id is null or p_occurred_at is null or p_accounting_date is null
    or p_total_bigint is null or p_total_bigint<=0 or p_idempotency_key is null
    or p_storage_path is null or p_storage_path !~ ('^'||v_actor::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$')
    or p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_original_name,'')) not between 1 and 255
    or char_length(coalesce(p_merchant,''))>160
    or (p_ocr_confidence is not null and p_ocr_confidence not between 0 and 100)
    or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'invalid receipt values' using errcode='22023';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='receipt-files' and name=p_storage_path) then
    raise exception 'receipt image is not stored in the private account folder' using errcode='42501';
  end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'receipt wallet unavailable' using errcode='42501';
  end if;
  if p_category_id is not null then
    select kind into v_kind from public.categories where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found or v_kind<>'expense' then raise exception 'expense category unavailable' using errcode='42501'; end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_quantity := coalesce(nullif(v_item->>'quantity','')::numeric,1);
    v_unit_price := (v_item->>'unit_price')::bigint;
    v_line_total := round(v_quantity*v_unit_price)::bigint;
    if char_length(trim(coalesce(v_item->>'name',''))) not between 1 and 120
      or v_quantity<=0 or v_quantity>1000000 or v_quantity<>round(v_quantity,3)
      or v_unit_price<=0 or v_line_total<=0
      or (nullif(v_item->>'confidence','') is not null and (v_item->>'confidence')::numeric not between 0 and 100) then
      raise exception 'invalid receipt item' using errcode='22023';
    end if;
    v_calculated_total := v_calculated_total+v_line_total;
  end loop;
  if v_calculated_total<>p_total_bigint then raise exception 'receipt items must equal confirmed total' using errcode='23514'; end if;

  v_payload := jsonb_build_object('wallet',p_wallet_id,'category',p_category_id,'merchant',trim(coalesce(p_merchant,'')),
    'occurred_at',p_occurred_at,'date',p_accounting_date,'total',p_total_bigint::text,'path',p_storage_path,
    'checksum',p_checksum,'name',p_original_name,'confidence',p_ocr_confidence,'items',p_items);
  v_hash := encode(extensions.digest(convert_to(v_payload::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.receipts where owner_id=v_actor and idempotency_key=p_idempotency_key for update;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different receipt data' using errcode='23505'; end if;
    return jsonb_build_object('receipt_id',v_existing.id,'transaction_id',v_existing.transaction_id,'created',false);
  end if;

  insert into public.transactions(owner_id,wallet_id,kind,amount_bigint,occurred_at,accounting_date,category_id,note,idempotency_key)
  values(v_actor,p_wallet_id,'expense',p_total_bigint,p_occurred_at,p_accounting_date,p_category_id,
    case when trim(coalesce(p_merchant,''))='' then 'Hóa đơn' else 'Hóa đơn · '||trim(p_merchant) end,p_idempotency_key)
  returning id into v_transaction_id;
  insert into public.receipts(id,owner_id,transaction_id,storage_path,checksum,original_name,merchant,occurred_at,
    accounting_date,total_bigint,ocr_confidence,idempotency_key,request_hash)
  values(p_receipt_id,v_actor,v_transaction_id,p_storage_path,p_checksum,p_original_name,trim(coalesce(p_merchant,'')),
    p_occurred_at,p_accounting_date,p_total_bigint,p_ocr_confidence,p_idempotency_key,v_hash)
  returning * into v_receipt;
  v_position := 0;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_quantity := coalesce(nullif(v_item->>'quantity','')::numeric,1);
    v_unit_price := (v_item->>'unit_price')::bigint;
    v_line_total := round(v_quantity*v_unit_price)::bigint;
    insert into public.receipt_items(receipt_id,position,name,quantity,unit_price_bigint,line_total_bigint,confidence)
    values(v_receipt.id,v_position,trim(v_item->>'name'),v_quantity,v_unit_price,v_line_total,nullif(v_item->>'confidence','')::numeric);
    v_position := v_position+1;
  end loop;
  insert into public.audit_events(actor_id,entity,entity_id,action,new_hash)
    values(v_actor,'receipt',v_receipt.id,'verified_and_expensed',v_hash);
  return jsonb_build_object('receipt_id',v_receipt.id,'transaction_id',v_transaction_id,'created',true);
end;
$$;
revoke all on function public.create_receipt_expense(uuid,uuid,uuid,text,timestamptz,date,bigint,text,text,text,numeric,jsonb,uuid) from public,anon;
grant execute on function public.create_receipt_expense(uuid,uuid,uuid,text,timestamptz,date,bigint,text,text,text,numeric,jsonb,uuid) to authenticated;
