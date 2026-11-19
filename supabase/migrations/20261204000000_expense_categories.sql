-- Expense categories: one of ten fixed categories per expense, the foundation for spending by
-- category. The app suggests one from the description (on the phone) and it can always be changed.
-- Not required: expenses saved before this, or saved by an older app, have none, and the app shows
-- a guess for them. Recurring expenses keep a category, and each one they add gets it.

alter table public.expenses add column category text
  check (category in ('food', 'groceries', 'accommodation', 'transport', 'home', 'bills', 'entertainment', 'shopping', 'health', 'other'));
alter table public.recurring_expenses add column category text
  check (category in ('food', 'groceries', 'accommodation', 'transport', 'home', 'bills', 'entertainment', 'shopping', 'health', 'other'));

-- ─── Create and edit, with a category ────────────────────────────────────────

drop function public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb);
drop function public.update_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb);

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
  p_category text default null
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
                               original_currency, original_amount, exchange_rate, rate_date, rate_source, category)
  values (p_group_id, trim(p_description), p_amount_cents, p_payer_id, uid, p_split_method, p_occurred_at, p_notes,
          case when p_split_method::text = 'items' then p_items end,
          p_original ->> 'currency', (p_original ->> 'amount')::bigint, (p_original ->> 'rate')::numeric,
          (p_original ->> 'rate_date')::date, p_original ->> 'source', p_category)
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
  p_original jsonb default null,
  p_category text default null
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
      rate_source = p_original ->> 'source', category = p_category
  where id = p_expense_id;

  delete from public.expense_splits where expense_id = p_expense_id;
  insert into public.expense_splits (expense_id, user_id, amount_cents, weight)
  select p_expense_id, (s ->> 'user_id')::uuid, (s ->> 'amount_cents')::bigint, (s ->> 'weight')::bigint
  from jsonb_array_elements(p_splits) s;
end $$;

revoke execute on function public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text), public.update_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.create_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text), public.update_expense(uuid, text, bigint, uuid, public.split_method, jsonb, timestamptz, text, jsonb, jsonb, text) to authenticated;

-- ─── Recurring expenses ──────────────────────────────────────────────────────

-- Set after create_recurring / update_recurring (kept as they are, so older apps still work).
create function public.set_recurring_category(p_id uuid, p_category text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.recurring_expenses;
begin
  perform public.require_user();
  select * into r from public.recurring_expenses where id = p_id;
  if r.id is null or not public.can_manage_recurring(r.group_id, r.created_by) then
    raise exception 'Recurring expense not found' using errcode = 'P0002';
  end if;
  update public.recurring_expenses set category = p_category, updated_at = now() where id = p_id;
end $$;

revoke execute on function public.set_recurring_category(uuid, text) from public, anon;
grant execute on function public.set_recurring_category(uuid, text) to authenticated;

-- Each expense a recurring one adds gets its category.
create or replace function public.run_recurring(p_only uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r public.recurring_expenses;
  v_expense uuid;
  v_done integer := 0;
  v_loops integer;
  v_stop boolean;
  v_today date;
begin
  for r in
    select x.* from public.recurring_expenses x
    join public.groups g on g.id = x.group_id and g.archived_at is null and g.closed_at is null
    where ((x.stopped_at is null and not x.paused) or (x.due_date is not null and not x.due_reminded))
      and (p_only is null or x.id = p_only)
  loop
    begin
      -- "Today" where the person who set it up is.
      v_today := public.recurring_today(r.created_by);
      -- Heads-up before the next one.
      if r.stopped_at is null and not r.paused and r.heads_up_days > 0 and r.heads_up_for is distinct from r.next_date
         and r.next_date > v_today and r.next_date - r.heads_up_days <= v_today then
        insert into public.notifications (user_id, kind, group_id, actor_id, amount_cents, recurring_id)
        select u, 'recurring_heads_up', r.group_id, r.created_by, r.amount_cents, r.id from public.recurring_audience(r) u;
        update public.recurring_expenses set heads_up_for = r.next_date where id = r.id;
      end if;

      -- Everything due by today (catching up at most a year of weekly ones).
      v_loops := 0;
      v_stop := r.stopped_at is not null or r.paused;
      while r.next_date <= v_today and v_loops < 53 and not v_stop loop
        v_loops := v_loops + 1;
        if r.variable then
          r.due_date := coalesce(r.due_date, r.next_date);
          r.due_reminded := false;
          insert into public.notifications (user_id, kind, group_id, actor_id, recurring_id)
          select u, 'recurring_due', r.group_id, r.created_by, r.id from public.recurring_audience(r) u;
        else
          perform public.validate_splits(r.group_id, r.amount_cents, r.splits);
          insert into public.expenses (group_id, description, amount_cents, payer_id, created_by, split_method,
                                       occurred_at, items, recurring_id, category)
          values (r.group_id, r.description, r.amount_cents, r.payer_id, r.created_by, r.split_method,
                  r.next_date::timestamptz + interval '12 hours', r.items, r.id, r.category)
          returning id into v_expense;
          insert into public.expense_splits (expense_id, user_id, amount_cents, weight)
          select v_expense, (s ->> 'user_id')::uuid, (s ->> 'amount_cents')::bigint, (s ->> 'weight')::integer
          from jsonb_array_elements(r.splits) s;
          insert into public.notifications (user_id, kind, group_id, actor_id, amount_cents, recurring_id)
          select u, 'recurring_added', r.group_id, r.created_by, r.amount_cents, r.id from public.recurring_audience(r) u;
        end if;
        v_done := v_done + 1;
        r.occurrences := r.occurrences + 1;
        r.remaining := case when r.remaining is null then null else r.remaining - 1 end;
        r.next_date := public.recurring_date(r.start_date, r.frequency, r.occurrences);
        v_stop := r.remaining = 0 or (r.end_date is not null and r.next_date > r.end_date);
      end loop;

      -- One reminder about a bill still waiting for its amount after 3 days.
      if r.variable and r.due_date is not null and not r.due_reminded and r.due_date + 3 <= v_today then
        insert into public.notifications (user_id, kind, group_id, actor_id, recurring_id)
        values (r.payer_id, 'recurring_due_reminder', r.group_id, r.created_by, r.id);
        r.due_reminded := true;
      end if;

      -- An ended schedule stops; a variable bill already due stays waiting for its amount.
      update public.recurring_expenses set
        occurrences = r.occurrences, remaining = r.remaining, next_date = r.next_date,
        due_date = r.due_date, due_reminded = r.due_reminded,
        stopped_at = case when v_stop and stopped_at is null and not paused then now() else stopped_at end
      where id = r.id;
    exception when others then
      -- Can't be added any more (e.g. someone in it left the group): pause it so it shows in the list.
      update public.recurring_expenses set paused = true, updated_at = now() where id = r.id;
    end;
  end loop;
  return v_done;
end $$;
