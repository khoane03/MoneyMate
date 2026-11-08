-- Explicit opt-in sharing for personal check-ins. Wallet, category and private
-- transaction identifiers never enter the shared feed.
create table public.personal_bill_checkin_shares (
  checkin_id uuid primary key references public.personal_bill_checkins(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.connections(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(checkin_id,connection_id)
);
create index personal_bill_checkin_shares_connection_feed_idx
  on public.personal_bill_checkin_shares(connection_id,created_at desc,checkin_id desc);
alter table public.personal_bill_checkin_shares enable row level security;
revoke all on public.personal_bill_checkin_shares from public,anon,authenticated;

create policy "owner and active group read checkin share" on public.personal_bill_checkin_shares
  for select to authenticated using (
    owner_id=(select auth.uid()) or public.is_active_connection_member(connection_id)
  );

create or replace function public.can_read_shared_personal_checkin_image(p_storage_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.personal_bill_checkins c
    join public.personal_bill_checkin_shares s on s.checkin_id=c.id
    where c.storage_path=p_storage_path
      and public.is_active_connection_member(s.connection_id)
  );
$$;
revoke all on function public.can_read_shared_personal_checkin_image(text) from public,anon;
grant execute on function public.can_read_shared_personal_checkin_image(text) to authenticated;

create policy "active group reads shared checkin image" on storage.objects
  for select to authenticated using (
    bucket_id='receipt-files' and public.can_read_shared_personal_checkin_image(name)
  );

create or replace function public.create_shared_personal_bill_checkin(
  p_checkin_id uuid,p_wallet_id uuid,p_amount_bigint bigint,p_occurred_at timestamptz,
  p_accounting_date date,p_category_id uuid,p_caption text,p_storage_path text,
  p_idempotency_key uuid,p_connection_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_result jsonb;
  v_existing_connection uuid;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_connection_id is null or not public.is_active_connection_member(p_connection_id) then
    raise exception 'active connection unavailable' using errcode='42501';
  end if;

  v_result := public.create_personal_bill_checkin(
    p_checkin_id,p_wallet_id,p_amount_bigint,p_occurred_at,p_accounting_date,
    p_category_id,p_caption,p_storage_path,p_idempotency_key
  );

  select connection_id into v_existing_connection
  from public.personal_bill_checkin_shares where checkin_id=p_checkin_id for update;
  if found and v_existing_connection<>p_connection_id then
    raise exception 'idempotency key reused with a different shared group' using errcode='23505';
  end if;

  insert into public.personal_bill_checkin_shares(checkin_id,owner_id,connection_id)
    values(p_checkin_id,v_actor,p_connection_id)
    on conflict(checkin_id) do nothing;
  if found then
    insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
      values(v_actor,p_connection_id,'personal_bill_checkin',p_checkin_id,'shared',
        encode(extensions.digest(convert_to(p_checkin_id::text||':'||p_connection_id::text,'UTF8'),'sha256'),'hex'));
  end if;
  return v_result||jsonb_build_object('connection_id',p_connection_id);
end;
$$;
revoke all on function public.create_shared_personal_bill_checkin(uuid,uuid,bigint,timestamptz,date,uuid,text,text,uuid,uuid) from public,anon;
grant execute on function public.create_shared_personal_bill_checkin(uuid,uuid,bigint,timestamptz,date,uuid,text,text,uuid,uuid) to authenticated;

create or replace function public.get_shared_personal_bill_checkins(
  p_connection_id uuid,p_limit integer default 50
) returns table(
  id uuid,owner_id uuid,owner_display_name text,caption text,storage_path text,
  created_at timestamptz,amount_bigint bigint,accounting_date date
) language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_connection_id is null or not public.is_active_connection_member(p_connection_id) then
    raise exception 'active connection unavailable' using errcode='42501';
  end if;
  return query
    select c.id,c.owner_id,coalesce(m.display_name,'Thành viên'),c.caption,c.storage_path,
      c.created_at,t.amount_bigint,t.accounting_date
    from public.personal_bill_checkin_shares s
    join public.personal_bill_checkins c on c.id=s.checkin_id and c.owner_id=s.owner_id
    join public.transactions t on t.id=c.transaction_id and t.owner_id=c.owner_id
    left join public.connection_members m on m.connection_id=s.connection_id and m.user_id=c.owner_id
    where s.connection_id=p_connection_id
    order by c.created_at desc,c.id desc
    limit least(greatest(coalesce(p_limit,50),1),100);
end;
$$;
revoke all on function public.get_shared_personal_bill_checkins(uuid,integer) from public,anon;
grant execute on function public.get_shared_personal_bill_checkins(uuid,integer) to authenticated;
