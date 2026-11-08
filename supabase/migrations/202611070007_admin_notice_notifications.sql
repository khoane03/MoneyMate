-- Persist admin announcements in each recipient's notification inbox.
alter table public.notifications alter column connection_id drop not null;
alter table public.notifications drop constraint notifications_event_type_check;
alter table public.notifications add constraint notifications_event_type_check check (event_type in (
  'shared_expense_created', 'shared_expense_approved', 'shared_expense_disputed', 'shared_expense_cancelled',
  'settlement_created', 'settlement_confirmed', 'settlement_rejected', 'settlement_cancelled', 'admin_notice'
));
alter table public.notifications drop constraint notifications_entity_type_check;
alter table public.notifications add constraint notifications_entity_type_check check (entity_type in ('shared_expense','settlement','admin_notice'));

alter table public.app_public_settings add column notice_id uuid;

create or replace function public.save_public_notice_and_fanout(
  p_actor_id uuid,
  p_active boolean,
  p_title text,
  p_body text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notice_id uuid := gen_random_uuid();
  v_recipient_count integer := 0;
begin
  if p_actor_id is null or not exists (select 1 from public.admin_users a where a.user_id = p_actor_id) then
    raise exception 'admin access required' using errcode = '42501';
  end if;
  if p_active is null or p_title is null or p_body is null
     or char_length(p_title) > 100 or char_length(p_body) > 500
     or (p_active and (char_length(btrim(p_title)) = 0 or char_length(btrim(p_body)) = 0)) then
    raise exception 'invalid public notice' using errcode = '22023';
  end if;

  update public.app_public_settings
    set notice_active = p_active,
        notice_title = p_title,
        notice_body = p_body,
        notice_id = v_notice_id,
        updated_by = p_actor_id,
        updated_at = now()
    where id = true;
  if not found then raise exception 'public settings row missing' using errcode = 'P0002'; end if;

  if p_active then
    insert into public.notifications(
      recipient_id, connection_id, event_type, entity_type, entity_id, title, body, event_key
    )
    select u.id, null, 'admin_notice', 'admin_notice', v_notice_id, p_title, p_body,
      'admin_notice:' || v_notice_id::text || ':' || u.id::text
    from auth.users u
    on conflict (event_key) do nothing;
    get diagnostics v_recipient_count = row_count;
  end if;
  return v_recipient_count;
end;
$$;
revoke all on function public.save_public_notice_and_fanout(uuid,boolean,text,text) from public, anon, authenticated;
grant execute on function public.save_public_notice_and_fanout(uuid,boolean,text,text) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_public_settings'
  ) then
    alter publication supabase_realtime add table public.app_public_settings;
  end if;
end;
$$;
