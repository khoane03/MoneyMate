-- Monthly budget envelopes are owner-private planning records, not ledger movements.
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid references public.categories(id) on delete restrict,
  period_start date not null check (extract(day from period_start) = 1),
  limit_bigint bigint not null check (limit_bigint > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique nulls not distinct (owner_id, period_start, category_id)
);

create index budgets_owner_period_idx on public.budgets(owner_id, period_start desc);
create index budgets_category_idx on public.budgets(category_id) where category_id is not null;
create trigger budgets_updated_at before update on public.budgets
  for each row execute function public.set_updated_at();

create or replace function public.validate_budget_category_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid;
  v_kind text;
begin
  if new.category_id is null then return new; end if;
  select owner_id, kind into v_owner, v_kind
    from public.categories where id = new.category_id;
  if not found or (v_owner is not null and v_owner <> new.owner_id) or v_kind <> 'expense' then
    raise exception 'budget category unavailable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger budgets_category_owner_check before insert or update of category_id, owner_id
  on public.budgets for each row execute function public.validate_budget_category_owner();

alter table public.budgets enable row level security;
create policy "budget owner select" on public.budgets for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "budget owner insert" on public.budgets for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "budget owner update" on public.budgets for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "budget owner delete" on public.budgets for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.budgets from anon;
grant select, insert, update, delete on public.budgets to authenticated;
