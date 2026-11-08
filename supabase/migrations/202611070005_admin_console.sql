-- Admin membership can only be granted through trusted SQL/service_role, never by users.
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from public,anon,authenticated;
grant all on public.admin_users to service_role;

-- The notice contains public copy only, not operational secrets.
create table public.app_public_settings (
  id boolean primary key default true check (id),
  notice_active boolean not null default false,
  notice_title text not null default '' check (char_length(notice_title)<=100),
  notice_body text not null default '' check (char_length(notice_body)<=500),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.app_public_settings(id) values(true) on conflict(id) do nothing;
alter table public.app_public_settings enable row level security;
create policy "signed in users read public application notice" on public.app_public_settings
  for select to authenticated using (true);
revoke all on public.app_public_settings from public,anon,authenticated;
grant select on public.app_public_settings to authenticated;
grant all on public.app_public_settings to service_role;
grant select,insert,update,delete on public.categories to service_role;
grant insert on public.audit_events to service_role;
grant usage,select on sequence public.audit_events_id_seq to service_role;
