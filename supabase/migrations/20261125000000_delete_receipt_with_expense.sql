-- A deleted expense's receipt photo is deleted too. Files can only be removed through the Storage
-- API, so the app removes the photo right after delete_expense; this lets whoever deleted the
-- expense (its owner, a co-owner or the person who added it) remove a photo someone else took.
drop policy "delete own receipts" on storage.objects;

create policy "delete own receipts and receipts of deleted expenses" on storage.objects for delete to authenticated
  using (
    bucket_id = 'receipts'
    and (
      owner_id = (select auth.uid())::text
      or exists (
        select 1 from public.expenses e
        where e.receipt_path = name and e.deleted_at is not null and public.can_see_expense(e.group_id, e.created_by)
      )
    )
  );

-- Removing a file also needs read access to it, so people who could see the expense keep read
-- access to its photo after the expense is deleted (until the app removes it moments later).
drop policy "read own receipts and receipts on visible expenses" on storage.objects;

create policy "read own receipts and receipts on visible expenses" on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (
      owner_id = (select auth.uid())::text
      or exists (
        select 1 from public.expenses e
        where e.receipt_path = name and public.can_see_expense(e.group_id, e.created_by)
      )
    )
  );
