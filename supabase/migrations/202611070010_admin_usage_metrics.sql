create table public.app_usage_sessions (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  request_count bigint not null default 0 check (request_count >= 0)
);

create index app_usage_sessions_started_at_idx on public.app_usage_sessions (started_at desc);
create index app_usage_sessions_last_seen_at_idx on public.app_usage_sessions (last_seen_at desc);
alter table public.app_usage_sessions enable row level security;
revoke all on public.app_usage_sessions from public, anon, authenticated;
grant all on public.app_usage_sessions to service_role;

create or replace function public.record_app_usage(p_session_id uuid, p_request_delta integer default 0)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_rows integer;
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_session_id is null or p_request_delta is null or p_request_delta < 0 or p_request_delta > 1000 then
    raise exception 'invalid usage event' using errcode = '22023';
  end if;

  insert into public.app_usage_sessions(session_id, user_id, request_count)
  values (p_session_id, v_actor, p_request_delta)
  on conflict (session_id) do update
    set last_seen_at = now(), request_count = public.app_usage_sessions.request_count + excluded.request_count
    where public.app_usage_sessions.user_id = v_actor;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'usage session owner mismatch' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.record_app_usage(uuid, integer) from public, anon;
grant execute on function public.record_app_usage(uuid, integer) to authenticated;

create or replace function public.get_admin_usage_metrics(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metrics jsonb;
begin
  if p_actor_id is null or not exists (select 1 from public.admin_users where user_id = p_actor_id) then
    raise exception 'admin access required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total_visits', count(*),
    'visits_30d', count(*) filter (where started_at >= now() - interval '30 days'),
    'total_requests', coalesce(sum(request_count), 0),
    'active_accounts_30d', count(distinct user_id) filter (where last_seen_at >= now() - interval '30 days')
  ) into v_metrics
  from public.app_usage_sessions;
  return v_metrics;
end;
$$;
revoke all on function public.get_admin_usage_metrics(uuid) from public, anon, authenticated;
grant execute on function public.get_admin_usage_metrics(uuid) to service_role;
