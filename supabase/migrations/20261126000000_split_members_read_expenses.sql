-- Member privacy, relaxed for expenses you're part of: anyone in an expense's split can read that
-- expense, its split and its receipt photo, so they can check what they're paying for. Editing and
-- deleting stay with the owner, co-owners and whoever added it (can_see_expense, unchanged).
-- Expenses you're not in, payments and other people's balances stay private as before.

-- Is the current user in this expense's split? SECURITY DEFINER so the expenses policy can ask
-- without recursing into expense_splits' own policy.
create function public.in_expense_split(p_expense_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.expense_splits
    where expense_id = p_expense_id and user_id = (select auth.uid())
  );
$$;

-- Can the current user read (not change) this expense?
create function public.can_read_expense(p_expense_id uuid, p_group_id uuid, p_created_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_see_expense(p_group_id, p_created_by)
      or (public.is_group_member(p_group_id) and public.in_expense_split(p_expense_id));
$$;

drop policy "owner or creator reads expenses" on public.expenses;
create policy "owner, creator or people in the split read expenses" on public.expenses for select to authenticated
  using (public.can_read_expense(id, group_id, created_by));

drop policy "read splits of visible expenses" on public.expense_splits;
create policy "read splits of readable expenses" on public.expense_splits for select to authenticated
  using (exists (
    select 1 from public.expenses e
    where e.id = expense_id and public.can_read_expense(e.id, e.group_id, e.created_by)
  ));

drop policy "read own receipts and receipts on visible expenses" on storage.objects;
create policy "read own receipts and receipts on readable expenses" on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (
      owner_id = (select auth.uid())::text
      or exists (
        select 1 from public.expenses e
        where e.receipt_path = name and public.can_read_expense(e.id, e.group_id, e.created_by)
      )
    )
  );

revoke execute on function public.in_expense_split(uuid), public.can_read_expense(uuid, uuid, uuid) from public, anon;
grant execute on function public.in_expense_split(uuid), public.can_read_expense(uuid, uuid, uuid) to authenticated;
