-- Offline saving: the app gives a new expense or payment its id on the phone, so one saved with no
-- signal can be sent when the connection is back, and sent again safely if that attempt is cut off.
-- create_expense and record_settlement take that id (p_id). If a row with it already exists and
-- the same person made it, the call just returns the id instead of saving a second copy.
-- Without p_id (older apps) nothing changes.

drop function public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text);
drop function public.record_settlement(uuid, uuid, uuid, bigint, timestamptz, text, uuid);

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
  p_original jsonb default null,
  p_category text default null,
  p_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_id uuid;
  v_items_total bigint;
  v_creator uuid;
begin
  -- Sent again after a lost connection: it's already saved, so don't save it twice.
  if p_id is not null then
    select created_by into v_creator from public.expenses where id = p_id;
    if found then
      if v_creator is distinct from uid then
        raise exception 'That expense id is already taken' using errcode = '23505';
      end if;
      return p_id;
    end if;
  end if;
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

  insert into public.expenses (id, group_id, description, amount_cents, payer_id, created_by, split_method, occurred_at, notes, items,
                               original_currency, original_amount, exchange_rate, rate_date, rate_source, category)
  values (coalesce(p_id, gen_random_uuid()), p_group_id, trim(p_description), p_amount_cents, p_payer_id, uid, p_split_method, p_occurred_at, p_notes,
          case when p_split_method::text = 'items' then p_items end,
          p_original ->> 'currency', (p_original ->> 'amount')::bigint, (p_original ->> 'rate')::numeric,
          (p_original ->> 'rate_date')::date, p_original ->> 'source', p_category)
  returning id into v_id;

  insert into public.expense_splits (expense_id, user_id, amount_cents, weight)
  select v_id, (s ->> 'user_id')::uuid, (s ->> 'amount_cents')::bigint, (s ->> 'weight')::bigint
  from jsonb_array_elements(p_splits) s;

  return v_id;
end $$;

create function public.record_settlement(
  p_group_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount_cents bigint,
  p_occurred_at timestamptz default now(),
  p_note text default null,
  p_expense_id uuid default null,
  p_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_id uuid;
  v_status text;
  v_creator uuid;
begin
  -- Sent again after a lost connection: it's already saved, so don't save it twice.
  if p_id is not null then
    select created_by into v_creator from public.settlements where id = p_id;
    if found then
      if v_creator is distinct from uid then
        raise exception 'That payment id is already taken' using errcode = '23505';
      end if;
      return p_id;
    end if;
  end if;
  if not public.is_group_member(p_group_id) then
    raise exception 'You are not a member of this group' using errcode = '42501';
  end if;
  if not public.is_member_of(p_group_id, p_from_user_id) or not public.is_member_of(p_group_id, p_to_user_id) then
    raise exception 'Both people must be members of the group' using errcode = '22023';
  end if;
  if p_expense_id is not null and not exists (
    select 1 from public.expenses e where e.id = p_expense_id and e.group_id = p_group_id and e.deleted_at is null
  ) then
    raise exception 'That expense isn''t in this group' using errcode = '22023';
  end if;

  if uid = p_to_user_id or exists (select 1 from public.profiles where id = p_to_user_id and is_guest) then
    v_status := 'recorded';
  else
    v_status := 'pending';
  end if;

  insert into public.settlements (id, group_id, from_user_id, to_user_id, amount_cents, occurred_at, note, created_by, status, expense_id)
  values (coalesce(p_id, gen_random_uuid()), p_group_id, p_from_user_id, p_to_user_id, p_amount_cents, p_occurred_at, p_note, uid, v_status::public.settlement_status, p_expense_id)
  returning id into v_id;

  if v_status = 'pending' then
    insert into public.notifications (user_id, kind, group_id, actor_id, amount_cents, settlement_id)
    values (p_to_user_id, 'payment_to_confirm', p_group_id, uid, p_amount_cents, v_id);
  end if;
  return v_id;
end $$;

revoke execute on function
  public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text, uuid),
  public.record_settlement(uuid, uuid, uuid, bigint, timestamptz, text, uuid, uuid)
  from public, anon;
grant execute on function
  public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text, uuid),
  public.record_settlement(uuid, uuid, uuid, bigint, timestamptz, text, uuid, uuid)
  to authenticated;
