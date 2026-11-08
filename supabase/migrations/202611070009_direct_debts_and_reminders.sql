-- Direct debt records are proposals between two connected members. They never
-- create income or expense; confirmation adds an obligation to the shared ledger.
alter table public.notifications drop constraint notifications_event_type_check;
alter table public.notifications add constraint notifications_event_type_check check (event_type in (
  'shared_expense_created','shared_expense_approved','shared_expense_disputed','shared_expense_cancelled',
  'settlement_created','settlement_confirmed','settlement_rejected','settlement_cancelled',
  'admin_notice','direct_debt_created','direct_debt_approved','direct_debt_disputed','direct_debt_cancelled','direct_debt_reminder'
));
alter table public.notifications drop constraint notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check
  check (entity_type in ('shared_expense','settlement','admin_notice','direct_debt'));

create table public.direct_debts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  creditor_id uuid not null references auth.users(id) on delete restrict,
  debtor_id uuid not null references auth.users(id) on delete restrict,
  description text not null check (char_length(trim(description)) between 1 and 160),
  details text not null default '' check (char_length(details) <= 1000),
  amount_bigint bigint not null check (amount_bigint > 0),
  due_date date,
  reminder_enabled boolean not null default false,
  reminder_frequency text not null default 'once' check (reminder_frequency in ('once','monthly')),
  reminder_date date,
  reminder_day smallint,
  last_reminded_on date,
  status text not null default 'pending' check (status in ('pending','approved','disputed','cancelled')),
  approved_by uuid references auth.users(id) on delete set null,
  dispute_note text not null default '' check (char_length(dispute_note) <= 500),
  version integer not null default 1 check (version > 0),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (created_by,idempotency_key),
  check (creditor_id <> debtor_id),
  check (created_by = creditor_id or created_by = debtor_id),
  check ((status = 'approved') = (approved_by is not null)),
  check (
    (not reminder_enabled and reminder_date is null and reminder_day is null)
    or (reminder_enabled and reminder_frequency = 'once' and reminder_date is not null and reminder_day is null)
    or (reminder_enabled and reminder_frequency = 'monthly' and reminder_date is null and reminder_day is not null and reminder_day between 1 and 31)
  )
);
create index direct_debts_connection_created_idx on public.direct_debts(connection_id,created_at desc,id desc);
create index direct_debts_due_reminder_idx on public.direct_debts(debtor_id,reminder_enabled,status,reminder_day)
  where reminder_enabled and status = 'approved';
create trigger direct_debts_updated_at before update on public.direct_debts
  for each row execute function public.set_updated_at();

alter table public.direct_debts enable row level security;
create policy "active connection members read direct debts" on public.direct_debts
  for select to authenticated using (public.is_active_connection_member(connection_id));
revoke all on public.direct_debts from public,anon,authenticated;
grant select on public.direct_debts to authenticated;

create or replace function public.create_direct_debt(
  p_connection_id uuid,p_creditor_id uuid,p_debtor_id uuid,p_description text,p_details text,
  p_amount_bigint bigint,p_due_date date,p_reminder_enabled boolean,p_reminder_frequency text,
  p_reminder_date date,p_reminder_day smallint,p_idempotency_key uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_hash text;
  v_debt public.direct_debts%rowtype;
  v_existing public.direct_debts%rowtype;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_description is null or char_length(trim(p_description)) not between 1 and 160
    or p_details is null or char_length(p_details)>1000 or p_amount_bigint is null or p_amount_bigint<=0
    or p_creditor_id is null or p_debtor_id is null or p_creditor_id=p_debtor_id
    or v_actor not in (p_creditor_id,p_debtor_id) or p_idempotency_key is null then
    raise exception 'invalid direct debt values' using errcode = '22023';
  end if;
  if not exists(select 1 from public.connections c where c.id=p_connection_id and c.status='active'
    and p_creditor_id in (c.member_a_id,c.member_b_id) and p_debtor_id in (c.member_a_id,c.member_b_id)) then
    raise exception 'active connection unavailable' using errcode = '42501';
  end if;
  if p_reminder_enabled and not (
    (p_reminder_frequency='once' and p_reminder_date is not null and p_reminder_day is null)
    or (p_reminder_frequency='monthly' and p_reminder_date is null and p_reminder_day is not null and p_reminder_day between 1 and 31)
  ) then raise exception 'invalid reminder schedule' using errcode = '22023'; end if;
  if not p_reminder_enabled and (p_reminder_date is not null or p_reminder_day is not null) then
    raise exception 'disabled reminder cannot have a schedule' using errcode = '22023';
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'connection_id',p_connection_id,'creditor_id',p_creditor_id,'debtor_id',p_debtor_id,
    'description',trim(p_description),'details',p_details,'amount',p_amount_bigint::text,'due_date',p_due_date,
    'reminder_enabled',p_reminder_enabled,'reminder_frequency',p_reminder_frequency,
    'reminder_date',p_reminder_date,'reminder_day',p_reminder_day)::text,'UTF8'),'sha256'),'hex');
  insert into public.direct_debts(connection_id,created_by,creditor_id,debtor_id,description,details,
    amount_bigint,due_date,reminder_enabled,reminder_frequency,reminder_date,reminder_day,idempotency_key,request_hash)
  values(p_connection_id,v_actor,p_creditor_id,p_debtor_id,trim(p_description),p_details,
    p_amount_bigint,p_due_date,p_reminder_enabled,case when p_reminder_enabled then p_reminder_frequency else 'once' end,
    p_reminder_date,p_reminder_day,p_idempotency_key,v_hash)
  on conflict(created_by,idempotency_key) do nothing returning * into v_debt;
  if v_debt.id is null then
    select * into v_existing from public.direct_debts where created_by=v_actor and idempotency_key=p_idempotency_key for update;
    if v_existing.request_hash<>v_hash then raise exception 'idempotency key reused with different values' using errcode = '23505'; end if;
    return jsonb_build_object('id',v_existing.id,'status',v_existing.status,'created',false);
  end if;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,p_connection_id,'direct_debt',v_debt.id,'proposed',v_hash);
  return jsonb_build_object('id',v_debt.id,'status',v_debt.status,'created',true);
end;
$$;

create or replace function public.resolve_direct_debt(p_debt_id uuid,p_expected_version integer,p_action text,p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_debt public.direct_debts%rowtype;
  v_action text := p_action;
  v_status text;
  v_partner uuid;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v_debt from public.direct_debts where id=p_debt_id for update;
  if not found or not public.is_active_connection_member(v_debt.connection_id) then
    raise exception 'direct debt unavailable' using errcode = '42501';
  end if;
  if v_debt.status<>'pending' or p_expected_version is distinct from v_debt.version then
    raise exception 'proposal changed; refresh before resolving' using errcode = '40001';
  end if;
  if v_action='cancel' then
    if v_actor<>v_debt.created_by then raise exception 'only creator can cancel proposal' using errcode = '42501'; end if;
    v_status := 'cancelled';
  elsif v_action in ('approve','dispute') then
    if v_actor=v_debt.created_by then raise exception 'creator cannot resolve own proposal' using errcode = '42501'; end if;
    if v_action='approve' then
      v_status := 'approved';
      insert into public.obligation_ledger(connection_id,source_type,source_id,debtor_id,creditor_id,amount_bigint)
        values(v_debt.connection_id,'direct_loan',v_debt.id,v_debt.debtor_id,v_debt.creditor_id,v_debt.amount_bigint);
    else
      if char_length(coalesce(p_note,''))>500 then raise exception 'dispute note too long' using errcode = '22023'; end if;
      v_status := 'disputed';
    end if;
  else raise exception 'invalid resolution action' using errcode = '22023';
  end if;
  update public.direct_debts set status=v_status,approved_by=case when v_status='approved' then v_actor else null end,
    dispute_note=case when v_status='disputed' then coalesce(p_note,'') else dispute_note end,version=version+1
    where id=v_debt.id returning * into v_debt;
  v_partner := case when v_actor=v_debt.created_by then v_debt.debtor_id when v_actor=v_debt.debtor_id then v_debt.creditor_id else v_debt.created_by end;
  insert into public.audit_events(actor_id,scope_id,entity,entity_id,action,new_hash)
    values(v_actor,v_debt.connection_id,'direct_debt',v_debt.id,v_status,v_debt.request_hash);
  return jsonb_build_object('id',v_debt.id,'status',v_debt.status,'version',v_debt.version,'created',true);
end;
$$;

create or replace function public.notify_direct_debt_created()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_recipient uuid := case when new.created_by=new.creditor_id then new.debtor_id else new.creditor_id end;
begin
  insert into public.notifications(recipient_id,connection_id,event_type,entity_type,entity_id,title,body,event_key)
  values(v_recipient,new.connection_id,'direct_debt_created','direct_debt',new.id,
    'Có đề nghị ghi nhận công nợ mới','Người kết nối với bạn vừa gửi một khoản công nợ để xác nhận.',
    'direct_debt:'||new.id::text||':created:'||v_recipient::text) on conflict(event_key) do nothing;
  return new;
end;
$$;

create or replace function public.notify_direct_debt_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_recipient uuid;
  v_event text;
  v_title text;
  v_body text;
begin
  if old.status is not distinct from new.status or old.status<>'pending' then return new; end if;
  if new.status not in ('approved','disputed','cancelled') then return new; end if;
  v_recipient := case when v_actor=new.creditor_id then new.debtor_id else new.creditor_id end;
  v_event := 'direct_debt_'||new.status;
  if new.status='approved' then v_title:='Khoản công nợ đã xác nhận'; v_body:='Người kết nối với bạn đã xác nhận khoản công nợ.';
  elsif new.status='disputed' then v_title:='Khoản công nợ cần trao đổi'; v_body:='Người kết nối với bạn muốn trao đổi về khoản công nợ.';
  else v_title:='Đề nghị công nợ đã hủy'; v_body:='Một đề nghị công nợ trong sổ chung đã được hủy.';
  end if;
  insert into public.notifications(recipient_id,connection_id,event_type,entity_type,entity_id,title,body,event_key)
  values(v_recipient,new.connection_id,v_event,'direct_debt',new.id,v_title,v_body,
    'direct_debt:'||new.id::text||':'||v_event||':'||v_recipient::text) on conflict(event_key) do nothing;
  return new;
end;
$$;
create trigger direct_debts_notify_created after insert on public.direct_debts
  for each row execute function public.notify_direct_debt_created();
create trigger direct_debts_notify_status after update of status on public.direct_debts
  for each row execute function public.notify_direct_debt_status();
revoke all on function public.notify_direct_debt_created() from public,anon,authenticated;
revoke all on function public.notify_direct_debt_status() from public,anon,authenticated;

create or replace function public.cancel_pending_direct_debts_on_disconnect()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status='active' and new.status='revoked' then
    update public.direct_debts set status='cancelled',version=version+1
      where connection_id=new.id and status='pending';
  end if;
  return new;
end;
$$;
create trigger connections_cancel_pending_direct_debts after update of status on public.connections
  for each row execute function public.cancel_pending_direct_debts_on_disconnect();
revoke all on function public.cancel_pending_direct_debts_on_disconnect() from public,anon,authenticated;

-- The debtor receives one persisted in-app reminder per due period the next time
-- they open the application. The PWA does not claim delivery while fully closed.
create or replace function public.process_due_direct_debt_reminders()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_debt public.direct_debts%rowtype;
  v_period date;
  v_month date;
  v_count integer := 0;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  for v_debt in select d.* from public.direct_debts d
    where d.debtor_id=v_actor and d.status='approved' and d.reminder_enabled
      and public.is_active_connection_member(d.connection_id)
  loop
    if v_debt.reminder_frequency='once' then
      v_period := v_debt.reminder_date;
    else
      v_period := make_date(extract(year from v_today)::integer,extract(month from v_today)::integer,
        least(v_debt.reminder_day,extract(day from (date_trunc('month',v_today::timestamp)+interval '1 month - 1 day'))::integer));
      if v_period>v_today then
        v_month := (date_trunc('month',v_today::timestamp)-interval '1 day')::date;
        v_period := make_date(extract(year from v_month)::integer,extract(month from v_month)::integer,
          least(v_debt.reminder_day,extract(day from (date_trunc('month',v_month::timestamp)+interval '1 month - 1 day'))::integer));
      end if;
    end if;
    if v_period is null or v_period>v_today or (v_debt.last_reminded_on is not null and v_debt.last_reminded_on>=v_period) then continue; end if;
    if not exists(select 1 from public.connection_balances b where b.connection_id=v_debt.connection_id
      and b.partner_id=v_debt.creditor_id and b.amount_owed_by_me_bigint>0) then continue; end if;
    update public.direct_debts set last_reminded_on=v_period where id=v_debt.id;
    insert into public.notifications(recipient_id,connection_id,event_type,entity_type,entity_id,title,body,event_key)
      values(v_actor,v_debt.connection_id,'direct_debt_reminder','direct_debt',v_debt.id,
        'Đến hạn khoản công nợ','Bạn có khoản công nợ đến hạn. Mở mục Chia tiền để kiểm tra và đối soát.',
        'direct_debt:'||v_debt.id::text||':reminder:'||v_period::text)
      on conflict(event_key) do nothing;
    if found then v_count := v_count+1; end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.create_direct_debt(uuid,uuid,uuid,text,text,bigint,date,boolean,text,date,smallint,uuid) from public,anon;
revoke all on function public.resolve_direct_debt(uuid,integer,text,text) from public,anon;
revoke all on function public.process_due_direct_debt_reminders() from public,anon;
grant execute on function public.create_direct_debt(uuid,uuid,uuid,text,text,bigint,date,boolean,text,date,smallint,uuid) to authenticated;
grant execute on function public.resolve_direct_debt(uuid,integer,text,text) to authenticated;
grant execute on function public.process_due_direct_debt_reminders() to authenticated;
