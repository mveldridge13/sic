-- Invites and guest claims (tester feedback, 25 Nov 2026).
--
-- 1. A group link only lets you join as yourself. It no longer lists the group's guests or lets
--    you take one's place: anyone holding the link could have claimed someone else's history.
--    A guest's place can be taken only through
--      * an invite sent to that guest (create_invite with a guest), or
--      * the owner or a co-owner merging them: "This is the same person as …" (merge_guest).
-- 2. Owners and co-owners see the group's open invites, and can turn one off or replace it with
--    a fresh link (open_invites, turn_off_invite, replace_invite).
-- 3. When someone joins, the owner and co-owners are told. When someone takes a guest's place
--    they're told too, and can undo it if it was the wrong person (undo_guest_claim).

alter table public.group_invites
  add column revoked_at timestamptz,
  add column revoked_by uuid references public.profiles (id) on delete set null;

-- Each time someone takes a guest's place, with exactly what moved, so it can be undone.
create table public.guest_claims (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups (id) on delete cascade,
  guest_id    uuid not null references public.profiles (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  via         text not null check (via in ('invite', 'merge')),
  merged_by   uuid references public.profiles (id) on delete set null,
  was_member  boolean not null,      -- the user was already in the group before taking the place
  moved       jsonb not null,        -- ids of the rows that moved (see move_guest_to)
  created_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references public.profiles (id) on delete set null
);
alter table public.guest_claims enable row level security;
revoke all on public.guest_claims from public, anon, authenticated;

alter table public.notifications add column claim_id uuid references public.guest_claims (id) on delete set null;
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'added_to_group', 'settle_reminder', 'made_co_owner', 'removed_co_owner', 'removed_from_group',
  'group_settled', 'payment_to_confirm', 'payment_confirmed', 'payment_declined', 'confirm_reminder',
  'recurring_heads_up', 'recurring_added', 'recurring_due', 'recurring_due_reminder', 'made_owner',
  'owner_handed_over',
  'member_joined',     -- to owner + co-owners: actor joined with a link
  'guest_claimed',     -- to owner + co-owners: actor took a guest's place (claim_id)
  'merged_with_guest', -- to the user: actor (owner/co-owner) merged them with a guest (claim_id)
  'claim_undone'       -- to the user: actor undid their taking a guest's place
));

-- The group links stop listing guests (older app versions ask for this list).
create or replace function public.invite_guests(p_token text)
returns table (group_name text, guest_id uuid, guest_name text)
language sql stable security definer set search_path = '' as $$
  select null::text, null::uuid, null::text where false;
$$;

-- Same moves as before, now returning what moved and refusing deleted members.
drop function public.move_guest_to(uuid, uuid, uuid);
create function public.move_guest_to(p_group_id uuid, p_guest_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_guest public.profiles;
  v_role text;
  v_moved jsonb;
begin
  select * into v_guest from public.profiles where id = p_guest_id for update;
  if v_guest.id is null or not v_guest.is_guest or v_guest.deleted_at is not null
     or not exists (select 1 from public.group_members where group_id = p_group_id and user_id = p_guest_id and left_at is null) then
    raise exception 'That person isn’t a guest in this group' using errcode = '22023';
  end if;
  if v_guest.claimed_by is not null then
    raise exception '% has already joined', v_guest.name using errcode = '22023';
  end if;
  if exists (
    select 1 from public.expense_splits s join public.expenses e on e.id = s.expense_id
    where e.group_id = p_group_id and s.user_id = p_user_id
      and exists (select 1 from public.expense_splits s2 where s2.expense_id = s.expense_id and s2.user_id = p_guest_id)
  ) then
    raise exception 'You and % are both in the same expense, so they can’t be joined together', v_guest.name using errcode = '23505';
  end if;

  v_moved := jsonb_build_object(
    'paid', coalesce((select jsonb_agg(id) from public.expenses where group_id = p_group_id and payer_id = p_guest_id), '[]'),
    'splits', coalesce((select jsonb_agg(s.expense_id) from public.expense_splits s join public.expenses e on e.id = s.expense_id
                        where e.group_id = p_group_id and s.user_id = p_guest_id), '[]'),
    'paid_from', coalesce((select jsonb_agg(id) from public.settlements where group_id = p_group_id and from_user_id = p_guest_id), '[]'),
    'paid_to', coalesce((select jsonb_agg(id) from public.settlements where group_id = p_group_id and to_user_id = p_guest_id), '[]'),
    'recurring_payer', coalesce((select jsonb_agg(id) from public.recurring_expenses where group_id = p_group_id and payer_id = p_guest_id), '[]'),
    'recurring_in', coalesce((select jsonb_agg(id) from public.recurring_expenses where group_id = p_group_id
                              and (splits::text like '%' || p_guest_id::text || '%' or items::text like '%' || p_guest_id::text || '%'
                                   or split_input::text like '%' || p_guest_id::text || '%')), '[]'),
    'joined_at', (select joined_at from public.group_members where group_id = p_group_id and user_id = p_guest_id)
  );

  -- The guest's history in this group becomes the user's (item names follow via a trigger).
  update public.expenses set payer_id = p_user_id where group_id = p_group_id and payer_id = p_guest_id;
  update public.expense_splits s set user_id = p_user_id
    from public.expenses e where e.id = s.expense_id and e.group_id = p_group_id and s.user_id = p_guest_id;
  update public.settlements set from_user_id = p_user_id where group_id = p_group_id and from_user_id = p_guest_id;
  update public.settlements set to_user_id = p_user_id where group_id = p_group_id and to_user_id = p_guest_id;
  update public.recurring_expenses set payer_id = p_user_id where group_id = p_group_id and payer_id = p_guest_id;
  update public.recurring_expenses
    set splits = replace(splits::text, p_guest_id::text, p_user_id::text)::jsonb
    where group_id = p_group_id and splits is not null and splits::text like '%' || p_guest_id::text || '%';
  update public.recurring_expenses
    set items = replace(items::text, p_guest_id::text, p_user_id::text)::jsonb
    where group_id = p_group_id and items is not null and items::text like '%' || p_guest_id::text || '%';
  update public.recurring_expenses
    set split_input = replace(split_input::text, p_guest_id::text, p_user_id::text)::jsonb
    where group_id = p_group_id and split_input is not null and split_input::text like '%' || p_guest_id::text || '%';

  -- Membership: keep the user's own row if they're already in (with their role), otherwise the
  -- guest's row becomes theirs. An old row from leaving earlier is replaced.
  select role::text into v_role from public.group_members
  where group_id = p_group_id and user_id = p_user_id and left_at is null;
  if v_role is not null then
    delete from public.group_members where group_id = p_group_id and user_id = p_guest_id;
  else
    delete from public.group_members where group_id = p_group_id and user_id = p_user_id;
    update public.group_members set user_id = p_user_id, left_at = null where group_id = p_group_id and user_id = p_guest_id;
  end if;

  update public.profiles set claimed_by = p_user_id, claimed_at = now() where id = p_guest_id;
  -- The guest's view link stops working: they're a member now.
  update public.guest_links set revoked_at = now() where guest_id = p_guest_id and revoked_at is null;
  return v_moved;
end $$;

revoke execute on function public.move_guest_to(uuid, uuid, uuid) from public, anon, authenticated;

-- Tell the owner and co-owners, except the person it's about and (unless p_include_me) whoever
-- did it. An owner who links a guest is told too, so the notification is where they can undo it.
create function public.notify_group_managers(p_group_id uuid, p_kind text, p_actor uuid, p_claim uuid default null,
                                             p_include_me boolean default false) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, kind, group_id, actor_id, claim_id)
  select m.user_id, p_kind, p_group_id, p_actor, p_claim
  from public.group_members m
  where m.group_id = p_group_id and m.left_at is null and m.role in ('owner', 'admin')
    and m.user_id <> p_actor and (p_include_me or m.user_id <> coalesce((select auth.uid()), p_actor));
$$;

revoke execute on function public.notify_group_managers(uuid, text, uuid, uuid, boolean) from public, anon, authenticated;

-- Joining. A group link: join as yourself. An invite sent to a guest: take that guest's place.
drop function public.accept_invite(text, uuid);
create function public.accept_invite(p_token text, p_guest_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  inv public.group_invites;
  v_was_member boolean;
  v_moved jsonb;
  v_claim uuid;
begin
  select i.* into inv
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  where i.token = p_token and i.expires_at > now() and i.revoked_at is null and g.archived_at is null
  for update of i;
  if inv.id is null then
    raise exception 'This invite link is invalid or has expired' using errcode = '22023';
  end if;
  -- p_guest_id is only accepted from older app versions; a group link can't be used to claim.
  if inv.guest_id is null and p_guest_id is not null then
    raise exception 'To join as someone already in this group, ask the owner for your own invite' using errcode = '42501';
  end if;

  v_was_member := public.is_member_of(inv.group_id, uid);
  if inv.guest_id is null then
    insert into public.group_members (group_id, user_id, role)
    values (inv.group_id, uid, 'member')
    on conflict (group_id, user_id) do update set left_at = null;
    if not v_was_member then
      perform public.notify_group_managers(inv.group_id, 'member_joined', uid);
    end if;
  else
    -- An invite sent to a particular guest is for a newcomer, not someone already in the group.
    if v_was_member then
      raise exception 'You are already in this group, so you can’t also join as %',
        (select name from public.profiles where id = inv.guest_id) using errcode = '23505';
    end if;
    v_moved := public.move_guest_to(inv.group_id, inv.guest_id, uid);
    insert into public.guest_claims (group_id, guest_id, user_id, via, was_member, moved)
    values (inv.group_id, inv.guest_id, uid, 'invite', false, v_moved)
    returning id into v_claim;
    perform public.notify_group_managers(inv.group_id, 'guest_claimed', uid, v_claim);
  end if;

  update public.group_invites set accepted_at = coalesce(accepted_at, now()), accepted_by = coalesce(accepted_by, uid)
  where id = inv.id;

  return inv.group_id;
end $$;

revoke execute on function public.accept_invite(text, uuid) from public, anon;
grant execute on function public.accept_invite(text, uuid) to authenticated;

-- Owner or co-owner: "this member is the same person as that guest".
create function public.merge_guest(p_group_id uuid, p_guest_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_moved jsonb;
  v_claim uuid;
begin
  if public.group_role_of(p_group_id, uid) is distinct from 'owner' and public.group_role_of(p_group_id, uid) is distinct from 'admin' then
    raise exception 'Only the owner or a co-owner can do this' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.group_members m join public.profiles p on p.id = m.user_id
    where m.group_id = p_group_id and m.user_id = p_user_id and m.left_at is null and not p.is_guest
  ) then
    raise exception 'That person isn’t a member of this group with an account' using errcode = '22023';
  end if;

  v_moved := public.move_guest_to(p_group_id, p_guest_id, p_user_id);
  insert into public.guest_claims (group_id, guest_id, user_id, via, merged_by, was_member, moved)
  values (p_group_id, p_guest_id, p_user_id, 'merge', uid, true, v_moved)
  returning id into v_claim;

  if p_user_id <> uid then
    insert into public.notifications (user_id, kind, group_id, actor_id, claim_id)
    values (p_user_id, 'merged_with_guest', p_group_id, uid, v_claim);
  end if;
  perform public.notify_group_managers(p_group_id, 'guest_claimed', p_user_id, v_claim, true);
end $$;

revoke execute on function public.merge_guest(uuid, uuid, uuid) from public, anon;
grant execute on function public.merge_guest(uuid, uuid, uuid) to authenticated;

-- Undo taking a guest's place: what moved goes back to the guest. Anything the person added since
-- stays theirs. If they joined by taking the place and have nothing else here, they leave.
create function public.undo_guest_claim(p_claim_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  c public.guest_claims;
  g uuid;
  u uuid;
  v_ids uuid[];
begin
  select * into c from public.guest_claims where id = p_claim_id for update;
  if c.id is null or (public.group_role_of(c.group_id, uid) is distinct from 'owner' and public.group_role_of(c.group_id, uid) is distinct from 'admin') then
    raise exception 'Only the owner or a co-owner can undo this' using errcode = '42501';
  end if;
  if c.undone_at is not null then
    raise exception 'This has already been undone' using errcode = '22023';
  end if;
  if public.is_group_closed(c.group_id) then
    raise exception 'This group is closed. Reopen it to make changes.' using errcode = '23514';
  end if;
  g := c.guest_id;
  u := c.user_id;

  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(c.moved -> 'paid') x;
  update public.expenses set payer_id = g where group_id = c.group_id and payer_id = u and id = any (coalesce(v_ids, '{}'));
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(c.moved -> 'splits') x;
  update public.expense_splits set user_id = g where user_id = u and expense_id = any (coalesce(v_ids, '{}'));
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(c.moved -> 'paid_from') x;
  update public.settlements set from_user_id = g where group_id = c.group_id and from_user_id = u and id = any (coalesce(v_ids, '{}'));
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(c.moved -> 'paid_to') x;
  update public.settlements set to_user_id = g where group_id = c.group_id and to_user_id = u and id = any (coalesce(v_ids, '{}'));
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(c.moved -> 'recurring_payer') x;
  update public.recurring_expenses set payer_id = g where group_id = c.group_id and payer_id = u and id = any (coalesce(v_ids, '{}'));
  select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(c.moved -> 'recurring_in') x;
  update public.recurring_expenses
    set splits = case when splits is null then null else replace(splits::text, u::text, g::text)::jsonb end,
        items = case when items is null then null else replace(items::text, u::text, g::text)::jsonb end,
        split_input = case when split_input is null then null else replace(split_input::text, u::text, g::text)::jsonb end
    where group_id = c.group_id and id = any (coalesce(v_ids, '{}'));

  -- The guest is back in the group, unclaimed.
  insert into public.group_members (group_id, user_id, role, joined_at)
  values (c.group_id, g, 'member', coalesce((c.moved ->> 'joined_at')::timestamptz, now()))
  on conflict (group_id, user_id) do update set left_at = null;
  update public.profiles set claimed_by = null, claimed_at = null where id = g;

  -- Someone who only got in by taking the place leaves, unless they've added things since.
  if not c.was_member and public.member_net_balance(c.group_id, u) = 0
     and not exists (select 1 from public.expense_splits s join public.expenses e on e.id = s.expense_id
                     where e.group_id = c.group_id and (s.user_id = u or e.payer_id = u))
     and not exists (select 1 from public.settlements s where s.group_id = c.group_id and u in (s.from_user_id, s.to_user_id))
     and public.group_role_of(c.group_id, u) = 'member' then
    update public.group_members set left_at = now() where group_id = c.group_id and user_id = u;
  end if;

  update public.guest_claims set undone_at = now(), undone_by = uid where id = c.id;
  if u <> uid then
    insert into public.notifications (user_id, kind, group_id, actor_id)
    values (u, 'claim_undone', c.group_id, uid);
  end if;
end $$;

revoke execute on function public.undo_guest_claim(uuid) from public, anon;
grant execute on function public.undo_guest_claim(uuid) to authenticated;

-- Open invites, for the owner and co-owners.
create function public.open_invites(p_group_id uuid)
returns table (id uuid, token text, guest_id uuid, guest_name text, invited_by uuid, invited_by_name text,
               created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.group_role_of(p_group_id, (select auth.uid())) is distinct from 'owner'
     and public.group_role_of(p_group_id, (select auth.uid())) is distinct from 'admin' then
    raise exception 'Only the owner or a co-owner can see invites' using errcode = '42501';
  end if;
  return query
  select i.id, i.token, i.guest_id, gp.name, i.invited_by, ip.name, i.created_at, i.expires_at
  from public.group_invites i
  left join public.profiles gp on gp.id = i.guest_id
  left join public.profiles ip on ip.id = i.invited_by
  where i.group_id = p_group_id and i.expires_at > now() and i.revoked_at is null
  order by i.created_at desc;
end $$;

revoke execute on function public.open_invites(uuid) from public, anon;
grant execute on function public.open_invites(uuid) to authenticated;

-- Turn an invite off: the owner, a co-owner, or whoever made it.
create function public.turn_off_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  inv public.group_invites;
begin
  select * into inv from public.group_invites where id = p_invite_id for update;
  if inv.id is null or not public.is_group_member(inv.group_id) or not (
    inv.invited_by = uid or public.group_role_of(inv.group_id, uid) in ('owner', 'admin')
  ) then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  update public.group_invites set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, uid),
    expires_at = least(expires_at, now())
  where id = inv.id;
end $$;

revoke execute on function public.turn_off_invite(uuid) from public, anon;
grant execute on function public.turn_off_invite(uuid) to authenticated;

-- Turn an invite off and make a fresh one of the same kind. Returns the new link's code.
create function public.replace_invite(p_invite_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  inv public.group_invites;
begin
  perform public.turn_off_invite(p_invite_id);
  select * into inv from public.group_invites where id = p_invite_id;
  return public.create_invite(inv.group_id, inv.guest_id);
end $$;

revoke execute on function public.replace_invite(uuid) from public, anon;
grant execute on function public.replace_invite(uuid) to authenticated;

-- Notifications now carry the claim they're about, so an owner can undo it from there.
drop function public.my_notifications();
create function public.my_notifications()
returns table (id uuid, kind text, group_id uuid, group_name text, group_icon text, group_currency text,
               actor_name text, amount_cents bigint, created_at timestamptz, read_at timestamptz,
               settlement_id uuid, settlement_status text, recurring_id uuid, recurring_description text,
               claim_id uuid, claim_guest_name text, claim_undone boolean, claim_via text)
language sql stable security definer set search_path = '' as $$
  select n.id, n.kind, n.group_id, g.name, g.icon, g.currency, a.name, n.amount_cents, n.created_at, n.read_at,
         n.settlement_id, s.status::text, n.recurring_id, r.description,
         n.claim_id, cp.name, c.undone_at is not null, c.via
  from public.notifications n
  join public.groups g on g.id = n.group_id and g.archived_at is null
  left join public.profiles a on a.id = n.actor_id
  left join public.settlements s on s.id = n.settlement_id
  left join public.recurring_expenses r on r.id = n.recurring_id
  left join public.guest_claims c on c.id = n.claim_id
  left join public.profiles cp on cp.id = c.guest_id
  where n.user_id = (select auth.uid())
  order by n.created_at desc
  limit 50;
$$;

revoke execute on function public.my_notifications() from public, anon;
grant execute on function public.my_notifications() to authenticated;
