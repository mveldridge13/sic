-- Joining with a group link: "Are you one of these people?"
--
-- Before, only an invite sent from a guest's own Invite button took over that guest. Someone who
-- joined with the general group link became a second, separate person, and the guest kept their
-- share. Now:
--   * invite_guests(token) lists the group's guests (people added by name, not yet taken over),
--     so the app can ask before joining;
--   * accept_invite(token, guest_id) joins as that guest: the guest's expenses, payments, item
--     lines and repeating expenses in the group become yours. This also works if you'd already
--     joined as yourself (as long as you and the guest aren't both in the same expense).
--
-- The move itself lives in move_guest_to(), shared by both kinds of invite.

-- ─── The move ────────────────────────────────────────────────────────────────
create function public.move_guest_to(p_group_id uuid, p_guest_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_guest public.profiles;
  v_role text;
begin
  select * into v_guest from public.profiles where id = p_guest_id for update;
  if v_guest.id is null or not v_guest.is_guest
     or not exists (select 1 from public.group_members where group_id = p_group_id and user_id = p_guest_id) then
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
end $$;

-- ─── Guests you could be ─────────────────────────────────────────────────────
create function public.invite_guests(p_token text)
returns table (group_name text, guest_id uuid, guest_name text)
language sql stable security definer set search_path = '' as $$
  select g.name, p.id, p.name
  from public.group_invites i
  join public.groups g on g.id = i.group_id and g.archived_at is null
  join public.group_members m on m.group_id = i.group_id and m.left_at is null
  join public.profiles p on p.id = m.user_id and p.is_guest and p.claimed_by is null
  where i.token = p_token and i.expires_at > now() and i.guest_id is null
    and (select auth.uid()) is not null
  order by p.name;
$$;

-- ─── Accepting an invite ─────────────────────────────────────────────────────
drop function public.accept_invite(text);
create function public.accept_invite(p_token text, p_guest_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  inv public.group_invites;
  v_guest uuid;
begin
  select i.* into inv
  from public.group_invites i
  join public.groups g on g.id = i.group_id
  where i.token = p_token and i.expires_at > now() and g.archived_at is null
  for update of i;
  if inv.id is null then
    raise exception 'This invite link is invalid or has expired' using errcode = '22023';
  end if;

  -- An invite sent to a guest is for that guest; a group link lets you say which guest you are.
  v_guest := coalesce(inv.guest_id, p_guest_id);
  -- An invite sent to a particular guest is for a newcomer, not someone already in the group.
  if inv.guest_id is not null and public.is_member_of(inv.group_id, uid) then
    raise exception 'You are already in this group, so you can’t also join as %',
      (select name from public.profiles where id = inv.guest_id) using errcode = '23505';
  end if;
  if v_guest is null then
    insert into public.group_members (group_id, user_id, role)
    values (inv.group_id, uid, 'member')
    on conflict (group_id, user_id) do update set left_at = null;
  else
    perform public.move_guest_to(inv.group_id, v_guest, uid);
  end if;

  update public.group_invites set accepted_at = coalesce(accepted_at, now()), accepted_by = coalesce(accepted_by, uid)
  where id = inv.id;

  return inv.group_id;
end $$;

revoke execute on function public.move_guest_to(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.invite_guests(text) from public, anon;
grant execute on function public.invite_guests(text) to authenticated;
revoke execute on function public.accept_invite(text, uuid) from public, anon;
grant execute on function public.accept_invite(text, uuid) to authenticated;
