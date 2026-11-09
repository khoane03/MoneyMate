-- Cloudinary stores private image bytes. Supabase stores authorization metadata
-- and provider identifiers only. Existing Supabase Storage image references are
-- intentionally cleared because legacy image objects are deleted during rollout.
create table public.media_assets (
  public_id text primary key,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('receipt','transaction-evidence','loan-evidence','bill-checkin','avatar')),
  provider text not null default 'cloudinary' check (provider='cloudinary'),
  asset_id text unique,
  resource_type text not null default 'image' check (resource_type='image'),
  delivery_type text not null default 'authenticated' check (delivery_type='authenticated'),
  format text check (format is null or format in ('jpg','jpeg','png','webp')),
  version bigint check (version is null or version>0),
  checksum text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 15728640),
  state text not null check (state in ('pending','ready','deleted')),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  deleted_at timestamptz,
  check (public_id ~ ('^moneymate/'||uploaded_by::text||'/(receipt|transaction-evidence|loan-evidence|bill-checkin|avatar)/[0-9a-f-]{36}$')),
  check ((state='pending' and asset_id is null and version is null and format is null and ready_at is null)
    or (state='ready' and asset_id is not null and version is not null and format is not null and ready_at is not null)
    or state='deleted'),
  check ((state='deleted')=(deleted_at is not null))
);
create index media_assets_owner_created_idx on public.media_assets(uploaded_by,created_at desc);
create index media_assets_pending_created_idx on public.media_assets(created_at) where state='pending';
alter table public.media_assets enable row level security;
create policy "media owner reads metadata" on public.media_assets for select to authenticated
  using (uploaded_by=(select auth.uid()));
revoke all on public.media_assets from public,anon,authenticated;
grant select on public.media_assets to authenticated;

-- Clear legacy Supabase Storage references before applying Cloudinary-only checks.
alter table public.receipts alter column storage_path drop not null;
update public.receipts set storage_path=null where storage_path is not null and storage_path !~ '^moneymate/';
delete from public.transaction_evidence where storage_path !~ '^moneymate/';
delete from public.shared_loan_payment_evidence where storage_path !~ '^moneymate/';
update public.personal_bill_checkins set storage_path=null where storage_path is not null and storage_path !~ '^moneymate/';
delete from public.bill_checkins where coalesce(caption,'')='' and storage_path is not null and storage_path !~ '^moneymate/';
update public.bill_checkins set storage_path=null where storage_path is not null and storage_path !~ '^moneymate/';
update public.profiles set avatar_storage_path=null where avatar_storage_path is not null and avatar_storage_path !~ '^moneymate/';
update public.connection_members set avatar_storage_path=null where avatar_storage_path is not null and avatar_storage_path !~ '^moneymate/';

alter table public.receipts drop constraint if exists receipts_storage_path_key;
alter table public.receipts add constraint receipts_storage_path_key unique(storage_path);
alter table public.receipts add constraint receipts_cloudinary_media_fk foreign key(storage_path) references public.media_assets(public_id) on delete restrict;

alter table public.transaction_evidence drop constraint if exists transaction_evidence_storage_path_check;
alter table public.transaction_evidence add constraint transaction_evidence_cloudinary_path_check
  check (storage_path ~ ('^moneymate/'||owner_id::text||'/(transaction-evidence|bill-checkin)/[0-9a-f-]{36}$'));
alter table public.transaction_evidence add constraint transaction_evidence_cloudinary_media_fk foreign key(storage_path) references public.media_assets(public_id) on delete restrict;

alter table public.shared_loan_payment_evidence drop constraint if exists shared_loan_payment_evidence_storage_path_check;
alter table public.shared_loan_payment_evidence add constraint shared_loan_payment_evidence_cloudinary_path_check
  check (storage_path ~ ('^moneymate/'||owner_id::text||'/loan-evidence/[0-9a-f-]{36}$'));
alter table public.shared_loan_payment_evidence add constraint shared_loan_payment_evidence_cloudinary_media_fk foreign key(storage_path) references public.media_assets(public_id) on delete restrict;

alter table public.personal_bill_checkins drop constraint if exists personal_bill_checkins_storage_path_check;
alter table public.personal_bill_checkins add constraint personal_bill_checkins_cloudinary_path_check
  check (storage_path is null or storage_path ~ ('^moneymate/'||owner_id::text||'/bill-checkin/[0-9a-f-]{36}$'));
alter table public.personal_bill_checkins add constraint personal_bill_checkins_cloudinary_media_fk foreign key(storage_path) references public.media_assets(public_id) on delete restrict;

alter table public.bill_checkins drop constraint if exists bill_checkins_storage_path_check;
alter table public.bill_checkins add constraint bill_checkins_cloudinary_path_check
  check (storage_path is null or storage_path ~ ('^moneymate/'||created_by::text||'/bill-checkin/[0-9a-f-]{36}$'));
alter table public.bill_checkins add constraint bill_checkins_cloudinary_media_fk foreign key(storage_path) references public.media_assets(public_id) on delete restrict;

alter table public.profiles drop constraint if exists profiles_avatar_path_owner_folder;
alter table public.profiles add constraint profiles_avatar_cloudinary_owner_check
  check (avatar_storage_path is null or avatar_storage_path ~ ('^moneymate/'||user_id::text||'/avatar/[0-9a-f-]{36}$'));
alter table public.profiles add constraint profiles_avatar_cloudinary_media_fk foreign key(avatar_storage_path) references public.media_assets(public_id) on delete restrict;
alter table public.connection_members add constraint connection_members_avatar_cloudinary_media_fk foreign key(avatar_storage_path) references public.media_assets(public_id) on delete restrict;

drop policy if exists "transaction owner attaches evidence" on public.transaction_evidence;
create policy "transaction owner attaches evidence" on public.transaction_evidence for insert to authenticated
  with check (owner_id=(select auth.uid())
    and exists(select 1 from public.transactions t where t.id=transaction_id and t.owner_id=(select auth.uid()))
    and exists(select 1 from public.media_assets m where m.public_id=storage_path and m.uploaded_by=(select auth.uid())
      and m.state='ready' and m.purpose in ('transaction-evidence','bill-checkin')));

drop policy if exists "borrower attaches repayment evidence" on public.shared_loan_payment_evidence;
create policy "borrower attaches repayment evidence" on public.shared_loan_payment_evidence for insert to authenticated
  with check (owner_id=(select auth.uid()) and exists(select 1 from public.shared_personal_loan_payments p
    where p.id=shared_payment_id and p.created_by=(select auth.uid()) and p.status='pending')
    and exists(select 1 from public.media_assets m where m.public_id=storage_path and m.uploaded_by=(select auth.uid())
      and m.state='ready' and m.purpose='loan-evidence'));

drop policy if exists "active group members create bill checkins" on public.bill_checkins;
create policy "active group members create bill checkins" on public.bill_checkins for insert to authenticated
  with check (created_by=(select auth.uid()) and public.is_active_connection_member(connection_id)
    and (storage_path is null or exists(select 1 from public.media_assets m where m.public_id=storage_path
      and m.uploaded_by=(select auth.uid()) and m.state='ready' and m.purpose='bill-checkin')));

-- Supabase Storage is no longer a media write/read surface.
drop policy if exists "receipt owner uploads private image" on storage.objects;
drop policy if exists "receipt owner reads private image" on storage.objects;
drop policy if exists "receipt owner retries private image upload" on storage.objects;
drop policy if exists "receipt owner removes private image" on storage.objects;
drop policy if exists "active group members read checkin images" on storage.objects;
drop policy if exists "active group members read shared repayment images" on storage.objects;
drop policy if exists "active group reads shared checkin image" on storage.objects;
drop policy if exists "avatar owner uploads own image" on storage.objects;
drop policy if exists "avatar owner or group member reads image" on storage.objects;
drop policy if exists "avatar owner replaces own image" on storage.objects;
drop policy if exists "avatar owner deletes own image" on storage.objects;

create or replace function public.create_receipt_expense(
  p_receipt_id uuid,p_wallet_id uuid,p_category_id uuid,p_merchant text,
  p_occurred_at timestamptz,p_accounting_date date,p_total_bigint bigint,
  p_storage_path text,p_checksum text,p_original_name text,p_ocr_confidence numeric,
  p_items jsonb,p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_item jsonb; v_position integer := 0; v_quantity numeric;
  v_unit_price bigint; v_line_total bigint; v_calculated_total bigint := 0; v_kind text; v_hash text;
  v_payload jsonb; v_existing public.receipts%rowtype; v_transaction_id uuid; v_receipt public.receipts%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_receipt_id is null or p_wallet_id is null or p_occurred_at is null or p_accounting_date is null
    or p_total_bigint is null or p_total_bigint<=0 or p_idempotency_key is null
    or p_storage_path is null or p_storage_path !~ ('^moneymate/'||v_actor::text||'/receipt/[0-9a-f-]{36}$')
    or p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_original_name,'')) not between 1 and 255 or char_length(coalesce(p_merchant,''))>160
    or (p_ocr_confidence is not null and p_ocr_confidence not between 0 and 100)
    or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'invalid receipt values' using errcode='22023';
  end if;
  if not exists(select 1 from public.media_assets where public_id=p_storage_path and uploaded_by=v_actor
    and purpose='receipt' and state='ready' and checksum=p_checksum) then
    raise exception 'receipt image is not a verified private Cloudinary asset' using errcode='42501';
  end if;
  if not exists(select 1 from public.wallets where id=p_wallet_id and owner_id=v_actor and status='active') then
    raise exception 'receipt wallet unavailable' using errcode='42501';
  end if;
  if p_category_id is not null then
    select kind into v_kind from public.categories where id=p_category_id and (owner_id is null or owner_id=v_actor);
    if not found or v_kind<>'expense' then raise exception 'expense category unavailable' using errcode='42501'; end if;
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_quantity := coalesce(nullif(v_item->>'quantity','')::numeric,1); v_unit_price := (v_item->>'unit_price')::bigint;
    v_line_total := round(v_quantity*v_unit_price)::bigint;
    if char_length(trim(coalesce(v_item->>'name',''))) not between 1 and 120 or v_quantity<=0 or v_quantity>1000000
      or v_quantity<>round(v_quantity,3) or v_unit_price<=0 or v_line_total<=0
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
    p_occurred_at,p_accounting_date,p_total_bigint,p_ocr_confidence,p_idempotency_key,v_hash) returning * into v_receipt;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_quantity := coalesce(nullif(v_item->>'quantity','')::numeric,1); v_unit_price := (v_item->>'unit_price')::bigint;
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
