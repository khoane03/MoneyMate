-- Durable in-app notifications for connected two-person sharing activity.
-- Realtime is only a wake-up signal; this table is the source of truth.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  event_type text not null check (event_type in (
    'shared_expense_created', 'shared_expense_approved', 'shared_expense_disputed', 'shared_expense_cancelled',
    'settlement_created', 'settlement_confirmed', 'settlement_rejected', 'settlement_cancelled'
  )),
  entity_type text not null check (entity_type in ('shared_expense','settlement')),
  entity_id uuid not null,
  title text not null check (char_length(title) between 1 and 100),
  body text not null check (char_length(body) between 1 and 240),
  event_key text not null unique,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (read_at is null or read_at >= created_at)
);

create index notifications_recipient_created_idx
  on public.notifications(recipient_id,created_at desc,id desc);
create index notifications_unread_recipient_idx
  on public.notifications(recipient_id,created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;
create policy "recipients read own notifications" on public.notifications
  for select to authenticated using (recipient_id = (select auth.uid()));
revoke all on public.notifications from public,anon,authenticated;
grant select on public.notifications to authenticated;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  update public.notifications n set read_at = coalesce(n.read_at,now())
  where n.id = p_notification_id and n.recipient_id = v_actor;
  return found;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_count integer;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  update public.notifications n set read_at = now()
  where n.recipient_id = v_actor and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_notification_read(uuid) from public,anon;
revoke all on function public.mark_all_notifications_read() from public,anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

-- Internal enqueue helper: callers may only insert for a current connection member.
create or replace function public.enqueue_partner_notification(
  p_recipient uuid,
  p_connection uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_title text,
  p_body text,
  p_event_key text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_recipient is null or p_connection is null or p_entity_id is null then return; end if;
  if not exists (
    select 1 from public.connections c
    where c.id = p_connection and c.status = 'active'
      and (c.member_a_id = p_recipient or c.member_b_id = p_recipient)
  ) then return; end if;

  insert into public.notifications(
    recipient_id,connection_id,event_type,entity_type,entity_id,title,body,event_key
  ) values (
    p_recipient,p_connection,p_event_type,p_entity_type,p_entity_id,p_title,p_body,p_event_key
  ) on conflict (event_key) do nothing;
end;
$$;
revoke all on function public.enqueue_partner_notification(uuid,uuid,text,text,uuid,text,text,text)
  from public,anon,authenticated;

create or replace function public.notify_shared_expense_created()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_recipient uuid;
begin
  select case when new.created_by = c.member_a_id then c.member_b_id
              when new.created_by = c.member_b_id then c.member_a_id end
    into v_recipient
  from public.connections c where c.id = new.connection_id and c.status = 'active';

  perform public.enqueue_partner_notification(
    v_recipient,new.connection_id,'shared_expense_created','shared_expense',new.id,
    'Có đề nghị chia tiền mới','Người kết nối với bạn vừa gửi một khoản chia. Mở mục Chia tiền để xem.',
    'shared_expense:' || new.id::text || ':created:' || coalesce(v_recipient::text,'none')
  );
  return new;
end;
$$;

create or replace function public.notify_shared_expense_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_recipient uuid;
  v_event text;
  v_title text;
  v_body text;
begin
  if old.status is not distinct from new.status or old.status <> 'pending' then return new; end if;
  if new.status not in ('approved','disputed','cancelled') then return new; end if;

  select case when v_actor = c.member_a_id then c.member_b_id
              when v_actor = c.member_b_id then c.member_a_id end
    into v_recipient
  from public.connections c where c.id = new.connection_id and c.status = 'active';
  if v_recipient is null then return new; end if;

  if new.status = 'approved' then
    v_event := 'shared_expense_approved'; v_title := 'Khoản chia đã được xác nhận';
    v_body := 'Người kết nối với bạn đã xác nhận khoản chia tiền.';
  elsif new.status = 'disputed' then
    v_event := 'shared_expense_disputed'; v_title := 'Khoản chia cần trao đổi';
    v_body := 'Người kết nối với bạn muốn trao đổi về một khoản chia.';
  else
    v_event := 'shared_expense_cancelled'; v_title := 'Khoản chia đã được hủy';
    v_body := 'Một đề nghị chia tiền trong sổ chung đã được hủy.';
  end if;

  perform public.enqueue_partner_notification(
    v_recipient,new.connection_id,v_event,'shared_expense',new.id,v_title,v_body,
    'shared_expense:' || new.id::text || ':' || v_event || ':' || v_recipient::text
  );
  return new;
end;
$$;

create trigger shared_expenses_notify_created
  after insert on public.shared_expenses for each row execute function public.notify_shared_expense_created();
create trigger shared_expenses_notify_status
  after update of status on public.shared_expenses for each row execute function public.notify_shared_expense_status();
revoke all on function public.notify_shared_expense_created() from public,anon,authenticated;
revoke all on function public.notify_shared_expense_status() from public,anon,authenticated;

create or replace function public.notify_settlement_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.enqueue_partner_notification(
    new.receiver_id,new.connection_id,'settlement_created','settlement',new.id,
    'Có đề nghị thanh toán công nợ','Người kết nối với bạn vừa gửi đề nghị thanh toán. Mở mục Chia tiền để xem.',
    'settlement:' || new.id::text || ':created:' || new.receiver_id::text
  );
  return new;
end;
$$;

create or replace function public.notify_settlement_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_recipient uuid;
  v_event text;
  v_title text;
  v_body text;
begin
  if old.status is not distinct from new.status or old.status <> 'pending' then return new; end if;
  if new.status not in ('confirmed','rejected','cancelled') then return new; end if;

  if v_actor = new.payer_id then v_recipient := new.receiver_id;
  elsif v_actor = new.receiver_id then v_recipient := new.payer_id;
  else return new;
  end if;

  if new.status = 'confirmed' then
    v_event := 'settlement_confirmed'; v_title := 'Thanh toán công nợ đã xác nhận';
    v_body := 'Người kết nối với bạn đã xác nhận khoản thanh toán.';
  elsif new.status = 'rejected' then
    v_event := 'settlement_rejected'; v_title := 'Đề nghị thanh toán bị từ chối';
    v_body := 'Người nhận đã từ chối đề nghị thanh toán công nợ.';
  else
    v_event := 'settlement_cancelled'; v_title := 'Đề nghị thanh toán đã được hủy';
    v_body := 'Một đề nghị thanh toán trong sổ chung đã được hủy.';
  end if;

  perform public.enqueue_partner_notification(
    v_recipient,new.connection_id,v_event,'settlement',new.id,v_title,v_body,
    'settlement:' || new.id::text || ':' || v_event || ':' || v_recipient::text
  );
  return new;
end;
$$;

create trigger settlements_notify_created
  after insert on public.settlements for each row execute function public.notify_settlement_created();
create trigger settlements_notify_status
  after update of status on public.settlements for each row execute function public.notify_settlement_status();
revoke all on function public.notify_settlement_created() from public,anon,authenticated;
revoke all on function public.notify_settlement_status() from public,anon,authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Supabase Realtime publication supabase_realtime is missing';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;
