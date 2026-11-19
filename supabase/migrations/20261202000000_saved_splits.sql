-- Saved splits: named ways a group usually divides costs ("Electricity 50/25/25"), picked with one
-- tap on Add expense. A saved split is a template: picking one copies it into the expense, so
-- editing or deleting it later never changes expenses already recorded (or repeating expenses,
-- which keep their own split).
--
--   - Belongs to the group: everyone in it can see, use and create saved splits.
--   - Whoever made it, the owner and co-owners can change or delete it.
--   - Equally (who's in), Percent (basis points, 33.33% = 3333) or Shares (units). Amounts and
--     Items depend on one bill's total, so they can't be saved.
--   - One saved split can be the group default (owner and co-owners): new expenses start with it.
--   - Someone in it leaving the group doesn't change it; the app shows it as "Needs updating"
--     and won't use it until it's fixed. Nothing is ever redistributed automatically.

create table public.saved_splits (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  method      text not null check (method in ('equal', 'percentage', 'shares')),
  -- [{ "user_id": uuid, "weight": int|null }]: null for equal, basis points or share units otherwise.
  shares      jsonb not null,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now()
);

create unique index saved_splits_group_name on public.saved_splits (group_id, lower(btrim(name)));
create index saved_splits_group on public.saved_splits (group_id);

alter table public.groups add column default_split_id uuid references public.saved_splits (id) on delete set null;

alter table public.saved_splits enable row level security;
create policy "members read saved splits" on public.saved_splits for select to authenticated
  using (public.is_group_member(group_id));
revoke all on public.saved_splits from anon;
grant select on public.saved_splits to authenticated;

-- ─── Checks ──────────────────────────────────────────────────────────────────

-- The shares must be people in the group now, once each, and add up the way the method needs.
create function public.check_saved_split(p_group_id uuid, p_method text, p_shares jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  n integer;
  total bigint;
  s jsonb;
  clean jsonb := '[]'::jsonb;
begin
  if p_method not in ('equal', 'percentage', 'shares') then
    raise exception 'Only Equally, Percent and Shares splits can be saved' using errcode = '22023';
  end if;
  if jsonb_typeof(p_shares) <> 'array' or jsonb_array_length(p_shares) = 0 then
    raise exception 'Pick at least one person' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_shares);
  if (select count(distinct x ->> 'user_id') from jsonb_array_elements(p_shares) x) <> n then
    raise exception 'Someone is in the split twice' using errcode = '22023';
  end if;
  for s in select * from jsonb_array_elements(p_shares) loop
    if not public.is_member_of(p_group_id, (s ->> 'user_id')::uuid) then
      raise exception 'Everyone in a saved split must be in the group' using errcode = '22023';
    end if;
    if p_method = 'equal' then
      clean := clean || jsonb_build_array(jsonb_build_object('user_id', s ->> 'user_id', 'weight', null));
    else
      if jsonb_typeof(s -> 'weight') <> 'number' or (s ->> 'weight')::numeric <> floor((s ->> 'weight')::numeric)
         or (s ->> 'weight')::bigint < 0 then
        raise exception 'Each person needs a whole, positive number' using errcode = '22023';
      end if;
      clean := clean || jsonb_build_array(jsonb_build_object('user_id', s ->> 'user_id', 'weight', (s ->> 'weight')::bigint));
    end if;
  end loop;
  if p_method = 'percentage' then
    select sum((x ->> 'weight')::bigint) into total from jsonb_array_elements(clean) x;
    -- Same rule as splitting an expense: 33.33% × 3 = 99.99% counts as 100%.
    if abs(total - 10000) > n - 1 then
      raise exception 'The percentages need to add up to 100%%' using errcode = '22023';
    end if;
  elsif p_method = 'shares' then
    select sum((x ->> 'weight')::bigint) into total from jsonb_array_elements(clean) x;
    if total = 0 then
      raise exception 'At least one person needs a share' using errcode = '22023';
    end if;
  end if;
  return clean;
end $$;

-- Whoever made it, or the owner or a co-owner.
create function public.can_manage_saved_split(p_group_id uuid, p_created_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_group_owner(p_group_id)
      or (p_created_by = (select auth.uid()) and public.is_group_member(p_group_id));
$$;

create function public.split_name_taken(p_group_id uuid, p_name text, p_except uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.saved_splits
    where group_id = p_group_id and lower(btrim(name)) = lower(btrim(p_name)) and id is distinct from p_except
  );
$$;

-- ─── Create, change, delete, default ─────────────────────────────────────────

create function public.save_split(p_group_id uuid, p_name text, p_method text, p_shares jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_id uuid;
begin
  if not public.is_group_member(p_group_id) then
    raise exception 'Group not found' using errcode = 'P0002';
  end if;
  if public.is_group_closed(p_group_id) then
    raise exception 'This group is closed. Reopen it to make changes.' using errcode = '23514';
  end if;
  if public.split_name_taken(p_group_id, p_name, null) then
    raise exception 'There''s already a saved split called "%"', btrim(p_name) using errcode = '23505';
  end if;
  insert into public.saved_splits (group_id, name, method, shares, created_by, updated_by)
  values (p_group_id, btrim(p_name), p_method, public.check_saved_split(p_group_id, p_method, p_shares), uid, uid)
  returning id into v_id;
  return v_id;
end $$;

create function public.update_split(p_id uuid, p_name text, p_method text, p_shares jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  r public.saved_splits;
begin
  select * into r from public.saved_splits where id = p_id for update;
  if r.id is null or not public.can_manage_saved_split(r.group_id, r.created_by) then
    raise exception 'Saved split not found' using errcode = 'P0002';
  end if;
  if public.is_group_closed(r.group_id) then
    raise exception 'This group is closed. Reopen it to make changes.' using errcode = '23514';
  end if;
  if public.split_name_taken(r.group_id, p_name, p_id) then
    raise exception 'There''s already a saved split called "%"', btrim(p_name) using errcode = '23505';
  end if;
  update public.saved_splits
  set name = btrim(p_name), method = p_method, shares = public.check_saved_split(r.group_id, p_method, p_shares),
      updated_by = uid, updated_at = now()
  where id = p_id;
end $$;

create function public.delete_split(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.saved_splits;
begin
  perform public.require_user();
  select * into r from public.saved_splits where id = p_id;
  if r.id is null or not public.can_manage_saved_split(r.group_id, r.created_by) then
    raise exception 'Saved split not found' using errcode = 'P0002';
  end if;
  -- Expenses keep the split they were saved with; only the template goes.
  delete from public.saved_splits where id = p_id;
end $$;

-- p_split_id null clears the default.
create function public.set_default_split(p_group_id uuid, p_split_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_user();
  if not public.is_group_owner(p_group_id) then
    raise exception 'Only the owner or a co-owner can set the group''s default split' using errcode = '42501';
  end if;
  if p_split_id is not null and not exists (select 1 from public.saved_splits where id = p_split_id and group_id = p_group_id) then
    raise exception 'Saved split not found' using errcode = 'P0002';
  end if;
  update public.groups set default_split_id = p_split_id where id = p_group_id;
end $$;

revoke execute on function public.save_split(uuid, text, text, jsonb), public.update_split(uuid, text, text, jsonb),
  public.delete_split(uuid), public.set_default_split(uuid, uuid) from public, anon;
grant execute on function public.save_split(uuid, text, text, jsonb), public.update_split(uuid, text, text, jsonb),
  public.delete_split(uuid), public.set_default_split(uuid, uuid) to authenticated;
revoke execute on function public.check_saved_split(uuid, text, jsonb), public.can_manage_saved_split(uuid, uuid),
  public.split_name_taken(uuid, text, uuid) from public, anon, authenticated;
