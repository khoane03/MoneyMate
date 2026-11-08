-- Personal transaction proof remains private. Group check-ins are visible only
-- to active members and may include an optional private-bucket image.
create table public.transaction_evidence (
  transaction_id uuid primary key references public.transactions(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  check (storage_path ~ ('^'||owner_id::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'))
);
alter table public.transaction_evidence enable row level security;
create policy "transaction owner reads evidence" on public.transaction_evidence for select to authenticated
  using (owner_id=(select auth.uid()) and exists(select 1 from public.transactions t where t.id=transaction_id and t.owner_id=(select auth.uid())));
create policy "transaction owner attaches evidence" on public.transaction_evidence for insert to authenticated
  with check (owner_id=(select auth.uid()) and exists(select 1 from public.transactions t where t.id=transaction_id and t.owner_id=(select auth.uid()))
    and exists(select 1 from storage.objects o where o.bucket_id='receipt-files' and o.name=storage_path));
revoke all on public.transaction_evidence from public,anon;
grant select,insert on public.transaction_evidence to authenticated;

create table public.bill_checkins (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  caption text not null default '' check (char_length(caption)<=280),
  storage_path text,
  created_at timestamptz not null default now(),
  check (storage_path is null or storage_path ~ ('^'||created_by::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$')),
  check (caption<>'' or storage_path is not null)
);
create index bill_checkins_group_feed_idx on public.bill_checkins(connection_id,created_at desc,id desc);
alter table public.bill_checkins enable row level security;
create policy "active group members read bill checkins" on public.bill_checkins for select to authenticated
  using (public.is_active_connection_member(connection_id));
create policy "active group members create bill checkins" on public.bill_checkins for insert to authenticated
  with check (created_by=(select auth.uid()) and public.is_active_connection_member(connection_id)
    and (storage_path is null or exists(select 1 from storage.objects o where o.bucket_id='receipt-files' and o.name=storage_path)));
revoke all on public.bill_checkins from public,anon;
grant select,insert on public.bill_checkins to authenticated;

create policy "active group members read checkin images" on storage.objects for select to authenticated
  using (bucket_id='receipt-files' and exists(select 1 from public.bill_checkins b
    where b.storage_path=name and public.is_active_connection_member(b.connection_id)));

create table public.shared_loan_payment_evidence (
  shared_payment_id uuid primary key references public.shared_personal_loan_payments(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  check (storage_path ~ ('^'||owner_id::text||'/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'))
);
alter table public.shared_loan_payment_evidence enable row level security;
create policy "shared loan participants read repayment evidence" on public.shared_loan_payment_evidence for select to authenticated
  using (exists(select 1 from public.shared_personal_loan_payments p join public.shared_personal_loans l on l.id=p.shared_loan_id
    where p.id=shared_payment_id and public.is_active_connection_member(l.connection_id)));
create policy "borrower attaches repayment evidence" on public.shared_loan_payment_evidence for insert to authenticated
  with check (owner_id=(select auth.uid()) and exists(select 1 from public.shared_personal_loan_payments p
    where p.id=shared_payment_id and p.created_by=(select auth.uid()) and p.status='pending')
    and exists(select 1 from storage.objects o where o.bucket_id='receipt-files' and o.name=storage_path));
revoke all on public.shared_loan_payment_evidence from public,anon;
grant select,insert on public.shared_loan_payment_evidence to authenticated;
create policy "active group members read shared repayment images" on storage.objects for select to authenticated
  using (bucket_id='receipt-files' and exists(select 1 from public.shared_loan_payment_evidence e
    join public.shared_personal_loan_payments p on p.id=e.shared_payment_id
    join public.shared_personal_loans l on l.id=p.shared_loan_id
    where e.storage_path=name and public.is_active_connection_member(l.connection_id)));

-- Bill check-ins intentionally do not mutate balances or the expense ledger.
