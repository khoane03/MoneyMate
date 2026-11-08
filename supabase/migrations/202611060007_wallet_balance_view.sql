-- Calculate wallet balances from immutable movements. The view honors the caller's RLS on both source tables.
create view public.wallet_balances with (security_invoker = true) as
select w.id, w.owner_id, w.kind, w.display_name, w.opening_balance_bigint, w.status,
  w.opening_balance_bigint::numeric + coalesce(sum(case
    when t.kind in ('income','loan_repayment','transfer_in') then t.amount_bigint::numeric
    when t.kind in ('expense','loan_disbursement','transfer_out') then -t.amount_bigint::numeric
    else 0::numeric end),0::numeric) as current_balance_bigint
from public.wallets w
left join public.transactions t on t.wallet_id = w.id and t.owner_id = w.owner_id
 group by w.id;
revoke all on public.wallet_balances from anon;
grant select on public.wallet_balances to authenticated;
