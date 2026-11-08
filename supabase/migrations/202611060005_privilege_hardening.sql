-- Keep financial facts append-only and make owner-checked RPCs the only wallet write path.
revoke all on public.wallets, public.transactions, public.transfers from anon;
revoke insert, update, delete on public.wallets, public.transactions, public.transfers from authenticated;
grant select on public.wallets, public.transactions, public.transfers to authenticated;

-- Categories may be edited by their owner; system defaults are read-only.
revoke all on public.categories from anon;
grant select, insert, update, delete on public.categories to authenticated;

-- Prevent attaching another user's private category, even when a UUID is guessed.
create or replace function public.validate_transaction_category_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_category_owner uuid;
  v_category_kind text;
begin
  if new.category_id is null then return new; end if;
  select owner_id, kind into v_category_owner, v_category_kind
    from public.categories where id = new.category_id;
  if not found or (v_category_owner is not null and v_category_owner <> new.owner_id) then
    raise exception 'category unavailable' using errcode = '42501';
  end if;
  if new.kind in ('income') and v_category_kind <> 'income' then
    raise exception 'category kind mismatch' using errcode = '23514';
  end if;
  if new.kind in ('expense') and v_category_kind <> 'expense' then
    raise exception 'category kind mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger transactions_category_owner_check
before insert or update of category_id, owner_id, kind on public.transactions
for each row execute function public.validate_transaction_category_owner();
