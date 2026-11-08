-- Foundation and private personal ledger primitives. All monetary values are integer đồng.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  locale text not null default 'vi-VN' check (locale in ('vi-VN')),
  timezone text not null default 'Asia/Ho_Chi_Minh',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('cash','bank','ewallet','credit')),
  display_name text not null check (char_length(trim(display_name)) between 1 and 80),
  opening_balance_bigint bigint not null default 0,
  status text not null default 'active' check (status in ('active','archived')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  parent_id uuid references public.categories(id) on delete set null,
  kind text not null check (kind in ('income','expense')),
  name text not null check (char_length(trim(name)) between 1 and 80),
  icon text,
  color text,
  created_at timestamptz not null default now(),
  unique (owner_id, kind, name)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null,
  kind text not null check (kind in ('income','expense','loan_disbursement','loan_repayment','adjustment')),
  amount_bigint bigint not null check (amount_bigint > 0),
  occurred_at timestamptz not null,
  accounting_date date not null,
  category_id uuid references public.categories(id) on delete restrict,
  note text not null default '' check (char_length(note) <= 1000),
  idempotency_key uuid not null,
  version integer not null default 1 check (version > 0),
  reversed_by uuid references public.transactions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, wallet_id) references public.wallets(owner_id, id),
  unique (owner_id, idempotency_key)
);

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  from_wallet_id uuid not null,
  to_wallet_id uuid not null,
  amount_bigint bigint not null check (amount_bigint > 0),
  occurred_at timestamptz not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  check (from_wallet_id <> to_wallet_id),
  foreign key (owner_id, from_wallet_id) references public.wallets(owner_id, id),
  foreign key (owner_id, to_wallet_id) references public.wallets(owner_id, id),
  unique (owner_id, idempotency_key)
);

create table public.idempotency_keys (
  actor_id uuid not null references auth.users(id) on delete cascade,
  key uuid not null,
  command_type text not null,
  request_hash text not null,
  result_ref uuid,
  created_at timestamptz not null default now(),
  primary key (actor_id, key)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  scope_id uuid,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  previous_hash text,
  new_hash text not null,
  created_at timestamptz not null default now()
);

create index transactions_owner_occurred_idx on public.transactions(owner_id, occurred_at desc);
create index wallets_owner_idx on public.wallets(owner_id, status);
create index categories_owner_kind_idx on public.categories(owner_id, kind);
create index transfers_owner_created_idx on public.transfers(owner_id, created_at desc);

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger wallets_updated_at before update on public.wallets for each row execute function public.set_updated_at();
create trigger transactions_updated_at before update on public.transactions for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.transfers enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.audit_events enable row level security;

create policy "profile owner select" on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy "profile owner insert" on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy "profile owner update" on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "wallet owner all" on public.wallets for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "category read own or system" on public.categories for select to authenticated using (owner_id is null or owner_id = (select auth.uid()));
create policy "category owner write" on public.categories for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "transaction owner all" on public.transactions for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "transfer owner all" on public.transfers for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Idempotency and audit rows are server managed; clients cannot inspect other commands or forge history.
revoke all on public.idempotency_keys, public.audit_events from anon, authenticated;
grant select, insert, update on public.profiles, public.wallets, public.categories, public.transactions, public.transfers to authenticated;
grant usage, select on all sequences in schema public to authenticated;
