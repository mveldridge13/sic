-- "You're now the owner": tell the new owner when a group passes to them, whether the owner
-- handed it over or deleted their account. Until now nothing said so.

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('added_to_group', 'settle_reminder', 'made_co_owner', 'removed_co_owner',
                  'removed_from_group', 'group_settled',
                  'payment_to_confirm', 'payment_confirmed', 'payment_declined', 'confirm_reminder',
                  'recurring_heads_up', 'recurring_added', 'recurring_due', 'recurring_due_reminder',
                  'made_owner', 'owner_handed_over'));

-- The owner made someone else the owner.
create or replace function public.transfer_ownership(p_group_id uuid, p_new_owner_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
begin
  if public.group_role_of(p_group_id, uid) is distinct from 'owner' then
    raise exception 'Only the group owner can transfer ownership' using errcode = '42501';
  end if;
  if p_new_owner_id = uid then
    raise exception 'You are already the owner' using errcode = '22023';
  end if;
  if public.group_role_of(p_group_id, p_new_owner_id) is null then
    raise exception 'That person is not in this group' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.profiles where id = p_new_owner_id and is_guest) then
    raise exception 'A guest can’t be the owner until they join Tally' using errcode = '22023';
  end if;

  update public.group_members set role = 'member' where group_id = p_group_id and user_id = uid;
  update public.group_members set role = 'owner' where group_id = p_group_id and user_id = p_new_owner_id;
  insert into public.notifications (user_id, kind, group_id, actor_id)
  values (p_new_owner_id, 'made_owner', p_group_id, uid);
end $$;

-- The owner deleted their account and the group passed to the next person.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_user();
  v_unsettled text;
  v_group uuid;
  v_new_owner uuid;
begin
  -- Settled everywhere first.
  select string_agg(g.name, ', ' order by g.name) into v_unsettled
  from public.group_members m
  join public.groups g on g.id = m.group_id and g.archived_at is null
  where m.user_id = uid and m.left_at is null
    and public.member_net_balance(m.group_id, uid) <> 0;
  if v_unsettled is not null then
    raise exception 'Settle up first. You still owe or are owed money in: %', v_unsettled using errcode = '23514';
  end if;

  -- Hand over (or delete) groups you own.
  for v_group in
    select m.group_id from public.group_members m
    join public.groups g on g.id = m.group_id and g.archived_at is null
    where m.user_id = uid and m.left_at is null and m.role = 'owner'
  loop
    select m.user_id into v_new_owner
    from public.group_members m
    join public.profiles p on p.id = m.user_id and not p.is_guest and p.deleted_at is null
    where m.group_id = v_group and m.user_id <> uid and m.left_at is null
    order by (m.role = 'admin') desc, m.joined_at, m.user_id
    limit 1;

    if v_new_owner is null then
      update public.groups set archived_at = now() where id = v_group;
    else
      update public.group_members set role = 'member' where group_id = v_group and user_id = uid;
      update public.group_members set role = 'owner' where group_id = v_group and user_id = v_new_owner;
      insert into public.notifications (user_id, kind, group_id, actor_id)
      values (v_new_owner, 'owner_handed_over', v_group, uid);
    end if;
  end loop;

  -- Leave every group (history stays, as with leaving).
  update public.group_members set left_at = now(), role = 'member'
  where user_id = uid and left_at is null;

  -- Loose ends nobody could finish without you.
  update public.settlements set status = 'voided'
  where status::text = 'pending' and (from_user_id = uid or to_user_id = uid);
  update public.group_invites set expires_at = now()
  where invited_by = uid and accepted_at is null and expires_at > now();
  update public.recurring_expenses set stopped_at = now(), updated_at = now()
  where payer_id = uid and stopped_at is null;

  -- Your personal data.
  delete from public.payment_methods where user_id = uid;
  delete from public.notifications where user_id = uid;
  delete from public.hidden_groups where user_id = uid;
  delete from public.receipt_scans where user_id = uid;
  update public.profiles set
    avatar_url = null, time_zone = null,
    receipt_scan_consent = null, receipt_scan_consent_at = null,
    deleted_at = now()
  where id = uid;

  -- Finally the login itself.
  delete from auth.users where id = uid;
end $$;
