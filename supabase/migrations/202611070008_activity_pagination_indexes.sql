-- Support stable offset pagination and newest-first ordering on activity feeds.
-- These indexes only add read paths; they do not alter or remove user data.
create index if not exists transactions_owner_occurred_page_idx
  on public.transactions(owner_id, occurred_at desc, id desc);
create index if not exists transactions_owner_created_page_idx
  on public.transactions(owner_id, created_at desc, id desc);

create index if not exists receipts_owner_created_page_idx
  on public.receipts(owner_id, created_at desc, id desc);

create index if not exists connections_member_a_page_idx
  on public.connections(member_a_id, status, created_at desc, id desc);
create index if not exists connections_member_b_page_idx
  on public.connections(member_b_id, status, created_at desc, id desc);

create index if not exists shared_expenses_connection_created_page_idx
  on public.shared_expenses(connection_id, created_at desc, id desc);
create index if not exists settlements_connection_created_page_idx
  on public.settlements(connection_id, created_at desc, id desc);

create index if not exists categories_owner_kind_created_page_idx
  on public.categories(owner_id, kind, created_at desc, id desc);
create index if not exists categories_system_created_page_idx
  on public.categories(created_at desc, id desc) where owner_id is null;

create index if not exists budgets_owner_period_created_page_idx
  on public.budgets(owner_id, period_start, created_at desc, id desc);
create index if not exists wallets_owner_created_page_idx
  on public.wallets(owner_id, created_at desc, id desc);
