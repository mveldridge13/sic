-- Closing a group: the owner or a co-owner ends it for everyone once everyone's square.
-- A closed group is read-only: no new or changed expenses, payments or repeating expenses, and
-- repeating expenses wait instead of adding. It shows under Closed on everyone's Groups page and
-- can be reopened by the owner or a co-owner. Not archived_at, which is deleting the group.

alter table public.groups
  add column closed_at timestamptz,
  add column closed_by uuid references public.profiles (id) on delete set null;

-- ─── Nothing changes in a closed group ───────────────────────────────────────

create function public.is_group_closed(p_group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.groups where id = p_group_id and closed_at is not null);
$$;

create function public.guard_closed_group() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_group uuid := case when tg_op = 'DELETE' then old.group_id else new.group_id end;
begin
  if public.is_group_closed(v_group) then
    raise exception 'This group is closed. Reopen it to make changes.' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Expenses: no adding, editing or deleting.
create trigger guard_closed_group
  before insert or update or delete on public.expenses
  for each row execute function public.guard_closed_group();

-- Payments: no new ones, and recorded ones can't be undone. (Closing needs nothing pending,
-- so the only other changes are loose ends tidied when someone deletes their account.)
create trigger guard_closed_group
  before insert on public.settlements
  for each row execute function public.guard_closed_group();
create trigger guard_closed_group_recorded
  before update on public.settlements
  for each row when (old.status::text = 'recorded')
  execute function public.guard_closed_group();

-- Repeating expenses: no new ones. Existing ones can still be stopped.
create trigger guard_closed_group
  before insert on public.recurring_expenses
  for each row execute function public.guard_closed_group();

-- ─── Close and reopen ────────────────────────────────────────────────────────

create function public.close_group(p_group_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
begin
  if not public.is_group_owner(p_group_id) then
    raise exception 'Only the owner or a co-owner can close this group' using errcode = '42501';
  end if;
  if public.is_group_closed(p_group_id) then
    return;
  end if;
  if exists (
    select 1 from (select distinct user_id from public.group_members where group_id = p_group_id) m
    where public.member_net_balance(p_group_id, m.user_id) <> 0
  ) then
    raise exception 'Everyone needs to be square before the group can be closed' using errcode = '23514';
  end if;
  if exists (select 1 from public.settlements where group_id = p_group_id and status::text = 'pending') then
    raise exception 'A payment is still waiting to be confirmed' using errcode = '23514';
  end if;
  update public.groups set closed_at = now(), closed_by = uid where id = p_group_id;
end $$;

create function public.reopen_group(p_group_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.recurring_expenses;
  n integer;
begin
  perform public.require_user();
  if not public.is_group_owner(p_group_id) then
    raise exception 'Only the owner or a co-owner can reopen this group' using errcode = '42501';
  end if;
  -- Repeating expenses carry on from today: dates that passed while closed are skipped,
  -- the same as resuming a paused one.
  for r in
    select * from public.recurring_expenses
    where group_id = p_group_id and stopped_at is null and not paused for update
  loop
    n := r.occurrences;
    while public.recurring_date(r.start_date, r.frequency, n) < public.recurring_today(r.created_by) loop
      n := n + 1;
    end loop;
    if n <> r.occurrences then
      update public.recurring_expenses
      set occurrences = n, next_date = public.recurring_date(r.start_date, r.frequency, n), heads_up_for = null, updated_at = now()
      where id = r.id;
    end if;
  end loop;
  update public.groups set closed_at = null, closed_by = null where id = p_group_id;
  -- Anything due today goes in now.
  perform public.run_recurring(x.id) from public.recurring_expenses x
  where x.group_id = p_group_id and x.stopped_at is null and not x.paused;
end $$;

revoke execute on function public.close_group(uuid), public.reopen_group(uuid) from public, anon;
grant execute on function public.close_group(uuid), public.reopen_group(uuid) to authenticated;
revoke execute on function public.is_group_closed(uuid), public.guard_closed_group() from public, anon, authenticated;

-- ─── Repeating expenses wait while the group is closed ───────────────────────

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
                                       occurred_at, items, recurring_id)
          values (r.group_id, r.description, r.amount_cents, r.payer_id, r.created_by, r.split_method,
                  r.next_date::timestamptz + interval '12 hours', r.items, r.id)
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
