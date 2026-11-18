-- "Remove receipt photo" on an expense: whoever can edit the expense (the person who added it,
-- the group owner or a co-owner) can delete its photo for good while keeping the expense.
--
-- Files can only be removed through the Storage API, so the app deletes the photo first and then
-- detaches it with set_expense_receipt(expense, null). Until now only the person who took a photo,
-- or an editor of a DELETED expense, could delete it; this lets editors of a live expense do it too.

drop policy "delete own receipts and receipts of deleted expenses" on storage.objects;

create policy "delete own receipts and receipts of expenses you can edit" on storage.objects for delete to authenticated
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
