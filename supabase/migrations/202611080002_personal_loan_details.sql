alter table public.transactions
  add column loan_lender_name text,
  add column loan_purpose text,
  add constraint transactions_loan_details_kind_check check (
    (kind in ('borrowed_funds','loan_principal_payment')) or (loan_lender_name is null and loan_purpose is null)
  ),
  add constraint transactions_loan_lender_length_check check (loan_lender_name is null or char_length(loan_lender_name) between 1 and 120),
  add constraint transactions_loan_purpose_length_check check (loan_purpose is null or char_length(loan_purpose) between 1 and 240);

-- Keep the existing RPC signatures working for older clients. New clients use this
-- overload, which validates and stores the lender and purpose on the same private row.
create or replace function public.create_personal_transaction(
  p_wallet_id uuid,p_kind text,p_amount_bigint bigint,p_occurred_at timestamptz,p_accounting_date date,
  p_category_id uuid,p_note text,p_idempotency_key uuid,p_affects_outstanding boolean,
  p_loan_connection_id uuid,p_loan_counterparty_id uuid,p_loan_lender_name text,p_loan_purpose text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_lender text := nullif(btrim(p_loan_lender_name),'');
  v_purpose text := nullif(btrim(p_loan_purpose),'');
  v_transaction public.transactions%rowtype;
  v_result jsonb;
  v_preexisting boolean;
begin
  if v_actor is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_kind in ('borrowed_funds','loan_principal_payment') then
    if v_lender is null or char_length(v_lender)>120 or v_purpose is null or char_length(v_purpose)>240 then
      raise exception 'loan lender and purpose are required' using errcode = '22023';
    end if;
  elsif p_loan_lender_name is not null or p_loan_purpose is not null then
    raise exception 'loan details are only valid for personal loan entries' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text || p_idempotency_key::text,0));
  select exists(select 1 from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key) into v_preexisting;
  v_result := public.create_personal_transaction(p_wallet_id,p_kind,p_amount_bigint,p_occurred_at,p_accounting_date,
    p_category_id,p_note,p_idempotency_key,p_affects_outstanding,p_loan_connection_id,p_loan_counterparty_id);
  if not v_preexisting then
    update public.transactions set loan_lender_name=v_lender,loan_purpose=v_purpose
      where owner_id=v_actor and idempotency_key=p_idempotency_key;
  end if;
  select * into v_transaction from public.transactions where owner_id=v_actor and idempotency_key=p_idempotency_key;
  if v_transaction.loan_lender_name is distinct from v_lender or v_transaction.loan_purpose is distinct from v_purpose then
    raise exception 'idempotency key reused with different loan details' using errcode = '23505';
  end if;
  return v_result || jsonb_build_object('loan_lender_name',v_transaction.loan_lender_name,'loan_purpose',v_transaction.loan_purpose);
end;
$$;
revoke all on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text) from public,anon;
grant execute on function public.create_personal_transaction(uuid,text,bigint,timestamptz,date,uuid,text,uuid,boolean,uuid,uuid,text,text) to authenticated;
