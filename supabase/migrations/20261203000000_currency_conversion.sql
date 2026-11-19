-- Currency conversion: an expense can be paid in another currency than its group's. The amount
-- is converted into the group's currency when the expense is entered, and the rate is locked:
-- balances, splits and payments keep using amount_cents (the group's currency) exactly as before,
-- and the expense keeps what was actually paid next to it.
--
--   original_currency  what was paid in, e.g. JPY (null = the group's own currency)
--   original_amount    what was paid, in that currency's smallest unit (yen, cents)
--   exchange_rate      group currency per 1 unit of the paid currency (1 JPY = 0.0093 AUD)
--   rate_date          the day the rate is for (the bank's last working day)
--   rate_source        ecb = European Central Bank daily rate (fetched automatically),
--                      manual = a rate someone typed, bank = the converted amount someone typed
--                      from their bank statement (rate worked out from it)
--
-- Rates are never refreshed afterwards. Editing only changes them when the person editing does.
-- When split by item in another currency, the item prices are in the paid currency too.

alter table public.expenses
  add column original_currency text check (original_currency ~ '^[A-Z]{3}$'),
  add column original_amount bigint check (original_amount > 0),
  add column exchange_rate numeric(30, 12) check (exchange_rate > 0),
  add column rate_date date,
  add column rate_source text check (rate_source in ('ecb', 'manual', 'bank')),
  add constraint expenses_original_all_or_none check (
    (original_currency is null and original_amount is null and exchange_rate is null and rate_source is null and rate_date is null)
    or (original_currency is not null and original_amount is not null and exchange_rate is not null and rate_source is not null)
  );

-- An Amounts split paid in another currency remembers each person's amount as typed (in that
-- currency), which can be larger than an integer holds (e.g. Indonesian rupiah).
alter table public.expense_splits alter column weight type bigint;

-- ─── Checking what was paid ──────────────────────────────────────────────────

-- p_original: null, or { currency, amount, rate, rate_date, source }. Returns the amount the
-- items are priced in (what was paid when converted; the expense amount otherwise).
create function public.check_original(p_group_id uuid, p_amount_cents bigint, p_original jsonb) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  v_currency text;
begin
  if p_original is null or jsonb_typeof(p_original) = 'null' then
    return p_amount_cents;
  end if;
  v_currency := p_original ->> 'currency';
  if v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Choose the currency you paid in' using errcode = '22023';
  end if;
  if v_currency = (select currency from public.groups where id = p_group_id) then
    raise exception 'That''s already the group''s currency' using errcode = '22023';
  end if;
  if jsonb_typeof(p_original -> 'amount') <> 'number' or (p_original ->> 'amount')::numeric <= 0
     or (p_original ->> 'amount')::numeric <> trunc((p_original ->> 'amount')::numeric) then
    raise exception 'Enter what you paid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_original -> 'rate') <> 'number' or (p_original ->> 'rate')::numeric <= 0 then
    raise exception 'The exchange rate must be more than zero' using errcode = '22023';
  end if;
  if coalesce(p_original ->> 'source', '') not in ('ecb', 'manual', 'bank') then
    raise exception 'Unknown exchange rate source' using errcode = '22023';
  end if;
  return (p_original ->> 'amount')::bigint;
end $$;

revoke execute on function public.check_original(uuid, bigint, jsonb) from public, anon, authenticated;

-- ─── Create and edit, with what was paid ─────────────────────────────────────

drop function public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb);
drop function public.update_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb);

create function public.create_expense(
  p_group_id uuid,
  p_description text,
  p_amount_cents bigint,
  p_payer_id uuid,
  p_split_method public.split_method,
  p_splits jsonb,
  p_occurred_at timestamptz default now(),
  p_notes text default null,
  p_items jsonb default null,
  p_original jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_id uuid;
  v_items_total bigint;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not a member of this group' using errcode = '42501';
  end if;
  if not public.is_member_of(p_group_id, p_payer_id) then
    raise exception 'The payer must be a member of the group' using errcode = '22023';
  end if;
  perform public.validate_splits(p_group_id, p_amount_cents, p_splits);
  v_items_total := public.check_original(p_group_id, p_amount_cents, p_original);
  if p_split_method::text = 'items' then
    perform public.validate_items(v_items_total, p_splits, p_items);
  end if;

  insert into public.expenses (group_id, description, amount_cents, payer_id, created_by, split_method, occurred_at, notes, items,
                               original_currency, original_amount, exchange_rate, rate_date, rate_source)
  values (p_group_id, trim(p_description), p_amount_cents, p_payer_id, uid, p_split_method, p_occurred_at, p_notes,
          case when p_split_method::text = 'items' then p_items end,
          p_original ->> 'currency', (p_original ->> 'amount')::bigint, (p_original ->> 'rate')::numeric,
          (p_original ->> 'rate_date')::date, p_original ->> 'source')
  returning id into v_id;

  insert into public.expense_splits (expense_id, user_id, amount_cents, weight)
  select v_id, (s ->> 'user_id')::uuid, (s ->> 'amount_cents')::bigint, (s ->> 'weight')::bigint
  from jsonb_array_elements(p_splits) s;

  return v_id;
end $$;

create function public.update_expense(
  p_expense_id uuid,
  p_description text,
  p_amount_cents bigint,
  p_payer_id uuid,
  p_split_method public.split_method,
  p_splits jsonb,
  p_occurred_at timestamptz,
  p_notes text default null,
  p_items jsonb default null,
  p_original jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_group uuid;
  v_creator uuid;
  v_items_total bigint;
begin
  select group_id, created_by into v_group, v_creator from public.expenses where id = p_expense_id and deleted_at is null for update;
  if v_group is null or not public.can_see_expense(v_group, v_creator) then
    raise exception 'Expense not found' using errcode = 'P0002';
  end if;
  if not public.is_member_of(v_group, p_payer_id) then
    raise exception 'The payer must be a member of the group' using errcode = '22023';
  end if;
  perform public.validate_splits(v_group, p_amount_cents, p_splits);
  v_items_total := public.check_original(v_group, p_amount_cents, p_original);
  if p_split_method::text = 'items' then
    perform public.validate_items(v_items_total, p_splits, p_items);
  end if;

  insert into public.expense_revisions (expense_id, edited_by, before)
  values (p_expense_id, uid, public.expense_snapshot(p_expense_id));

  update public.expenses
  set description = trim(p_description), amount_cents = p_amount_cents, payer_id = p_payer_id,
      split_method = p_split_method, occurred_at = p_occurred_at, notes = p_notes,
      items = case when p_split_method::text = 'items' then p_items end,
      original_currency = p_original ->> 'currency', original_amount = (p_original ->> 'amount')::bigint,
      exchange_rate = (p_original ->> 'rate')::numeric, rate_date = (p_original ->> 'rate_date')::date,
      rate_source = p_original ->> 'source'
  where id = p_expense_id;

  delete from public.expense_splits where expense_id = p_expense_id;
  insert into public.expense_splits (expense_id, user_id, amount_cents, weight)
  select p_expense_id, (s ->> 'user_id')::uuid, (s ->> 'amount_cents')::bigint, (s ->> 'weight')::bigint
  from jsonb_array_elements(p_splits) s;
end $$;

revoke execute on function
  public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb),
  public.update_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb)
  from public, anon;
grant execute on function
  public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb),
  public.update_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb)
  to authenticated;
