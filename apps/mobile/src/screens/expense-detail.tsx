import { centsToDecimalString, formatMoney, inferConvertedItemsRest, inferItemsRest, itemsSubtotal } from '@tally/shared';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardFigure, Gutter, HeroScreen, QuickAction, SectionTitle, StatRow, TotalPill } from '@/components/dashboard';
import { Avatar, Button, Card, Divider, Notice, Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import { seesEverything, useDeleteExpense, useExpenseHistory, useNameOf, useRemoveReceipt, useTallyData } from '@/lib/data';
import { relativeTime } from '@/lib/format';
import { useReceiptUrl } from '@/lib/receipts';
import { radius, space, useColors } from '@/theme';

const METHOD_LABEL = {
  equal: 'Split equally',
  exact: 'Split by amounts',
  percentage: 'Split by percentage',
  shares: 'Split by shares',
  items: 'Split by item',
  adjustment: 'Split equally, with adjustments',
} as const;

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Expense details. Full screen as a route, or inside the right pane of a two-pane layout
 * (`embedded`: no back button; `onGone` runs instead of going back when it's deleted or undone).
 */
export function ExpenseDetail({ id, embedded = false, onGone }: { id: string; embedded?: boolean; onGone?: () => void }) {
  const c = useColors();
  const myId = useMyId();
  const { data, isLoading } = useTallyData();
  const name = useNameOf();
  const history = useExpenseHistory(id);
  const deleteExpense = useDeleteExpense();

  const expense = data.expenses.find((e) => e.id === id);
  const group = expense ? data.groups.find((g) => g.id === expense.groupId) : undefined;

  if (!expense || !group) {
    return (
      <HeroScreen variant={embedded ? 'card' : 'full'} nav={embedded ? 'none' : 'back'} title="Expense">
        <Gutter>
          <Notice tone="info">{isLoading ? 'Loading…' : 'This expense has been deleted.'}</Notice>
        </Gutter>
      </HeroScreen>
    );
  }

  const money = (cents: number) => formatMoney(cents, group.currency);
  // Paid in another currency: item prices are in that currency, and what was paid is shown too.
  const paid = expense.original;
  const paidMoney = (minor: number) => formatMoney(minor, paid?.currency ?? group.currency);
  const paidTotal = paid?.amount ?? expense.amount;
  const rateLine = paid
    ? `Paid ${paidMoney(paid.amount)} · 1 ${paid.currency} = ${String(Number(paid.rate.toPrecision(paid.rate < 1 ? 4 : 6)))} ${group.currency} (${
        paid.source === 'manual'
          ? 'typed rate'
          : paid.source === 'bank'
            ? 'from the bank'
            : `European Central Bank${paid.rateDate ? `, ${new Date(`${paid.rateDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}`
      })`
    : null;
  // People in the split can view someone else's expense; only its owner, co-owners and whoever
  // added it can change it (the database enforces the same).
  // Nothing changes in a closed group.
  const canEdit = !group.closedAt && (seesEverything(group.myRole) || expense.createdById === myId);
  const myShare = expense.splits.find((s) => s.userId === myId)?.amount ?? 0;
  // Effect on your balance: what you paid minus your share.
  const myEffect = (expense.payerId === myId ? expense.amount : 0) - myShare;

  function confirmDelete() {
    Alert.alert(
      'Delete this expense?',
      `“${expense!.description}” (${money(expense!.amount)}) will be removed and everyone’s balances will update. A copy is kept in the history.` +
        (expense!.receiptPath ? '\n\nThe receipt photo attached to it will be deleted for good and can’t be recovered.' : ''),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            deleteExpense.mutate(expense!.id, {
              onSuccess: () => (onGone ? onGone() : router.back()),
            }),
        },
      ],
    );
  }

  const shareDetail = (weight: number | null) => {
    if (weight == null) return null;
    if (expense.method === 'percentage') return `${centsToDecimalString(weight).replace(/\.00$/, '')}%`;
    if (expense.method === 'shares') return `${weight} ${weight === 1 ? 'share' : 'shares'}`;
    if (expense.method === 'adjustment' && weight !== 0) {
      return `${weight > 0 ? '+' : '−'}${money(Math.abs(weight))}`;
    }
    return null;
  };

  const card = (
    <>
      <CardFigure
        label="Amount"
        value={money(expense.amount)}
        note={`Paid by ${name(expense.payerId)} · ${formatDateTime(expense.occurredAt)}${rateLine ? `\n${rateLine}` : ''}`}
      />
      <StatRow>
        <TotalPill label="Your share" cents={myShare} currency={group.currency} tone="neutral" />
        <TotalPill
          label={myEffect > 0 ? 'You lent' : myEffect < 0 ? 'You borrowed' : 'Your balance'}
          value={myEffect === 0 ? 'No change' : money(Math.abs(myEffect))}
          tone={myEffect > 0 ? 'owed' : myEffect < 0 ? 'owe' : 'neutral'}
        />
      </StatRow>
    </>
  );

  return (
    <HeroScreen
      variant={embedded ? 'card' : 'full'}
      nav={embedded ? 'none' : 'back'}
      eyebrow={`${group.name} · Expense`}
      title={expense.description}
      actions={
        <>
          {canEdit ? (
            <QuickAction
              icon="edit"
              label="Edit"
              onPress={() => router.push({ pathname: '/add-expense', params: { expenseId: expense.id } })}
            />
          ) : null}
          <QuickAction bold icon="groups" label="Group" onPress={() => router.push(`/group/${group.id}`)} />
          {canEdit ? <QuickAction bold icon="delete-outline" label="Delete" danger onPress={confirmDelete} /> : null}
        </>
      }
      cardTone="light"
      card={card}>
      {deleteExpense.isError ? (
        <Gutter>
          <Notice>{deleteExpense.error.message}</Notice>
        </Gutter>
      ) : null}

      {expense.items ? (
        <View style={{ gap: space.md }}>
          <SectionTitle title="Items" />
          <Gutter>
            <Card style={{ paddingVertical: 0 }}>
              {expense.items.map((item, i) => (
                <View key={i}>
                  {i > 0 ? <Divider /> : null}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="heading" numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text variant="caption" muted numberOfLines={2}>
                        {item.userIds.length === 1 ? name(item.userIds[0]!) : `Shared by ${item.userIds.map(name).join(', ')}`}
                      </Text>
                    </View>
                    <Text variant="heading" style={{ fontVariant: ['tabular-nums'] }}>
                      {paidMoney(item.amount)}
                    </Text>
                  </View>
                </View>
              ))}
              {paidTotal > itemsSubtotal(expense.items) ? (
                <>
                  <Divider />
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="heading">Everything else</Text>
                      <Text variant="caption" muted>
                        {(() => {
                          const rest = paid
                            ? inferConvertedItemsRest(expense.amount, paid.amount, expense.items, expense.splits)
                            : inferItemsRest(expense.amount, expense.items, expense.splits);
                          return rest.rest === 'equal'
                            ? `Split equally between ${rest.participants.map(name).join(', ')}`
                            : 'Shared in proportion to what each person had';
                        })()}
                      </Text>
                    </View>
                    <Text variant="heading" style={{ fontVariant: ['tabular-nums'] }}>
                      {paidMoney(paidTotal - itemsSubtotal(expense.items))}
                    </Text>
                  </View>
                </>
              ) : null}
            </Card>
          </Gutter>
        </View>
      ) : null}

      {expense.receiptPath ? <ReceiptPhoto expenseId={expense.id} path={expense.receiptPath} canRemove={canEdit} /> : null}

      <View style={{ gap: space.md }}>
        <SectionTitle title={METHOD_LABEL[expense.method]} />
        <Gutter>
          <Card style={{ paddingVertical: 0 }}>
            {expense.splits.map((s, i) => {
              const detail = shareDetail(s.weight);
              const isPayer = s.userId === expense.payerId;
              return (
                <View key={s.userId}>
                  {i > 0 ? <Divider /> : null}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.md,
                      paddingVertical: space.md,
                    }}>
                    <Avatar name={name(s.userId)} size={40} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="heading" numberOfLines={1}>
                        {name(s.userId)}
                      </Text>
                      {detail || isPayer ? (
                        <Text variant="caption" muted>
                          {[detail, isPayer ? 'paid the bill' : null].filter(Boolean).join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="heading" style={{ fontVariant: ['tabular-nums'] }}>
                      {money(s.amount)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>
          {myShare === 0 ? (
            <Text variant="caption" muted>
              You weren’t part of this split.
            </Text>
          ) : null}
        </Gutter>
      </View>

      <View style={{ gap: space.md }}>
        <SectionTitle title="History" />
        <Gutter>
          <Card style={{ gap: space.md }}>
            {(history.data ?? []).map((r) => (
              <View key={r.id} style={{ gap: 2 }}>
                <Text variant="label">
                  {name(r.editedById)} edited this · {relativeTime(r.at)}
                </Text>
                <Text variant="caption" muted>
                  Before: “{r.before.description}”, {money(r.before.amount_cents)}, paid by {name(r.before.payer_id)}
                </Text>
              </View>
            ))}
            <Text variant="label">
              {name(expense.createdById)} added this · {relativeTime(expense.createdAt)}
            </Text>
          </Card>
        </Gutter>
      </View>

      {myEffect !== 0 ? (
        <Gutter>
          <Text variant="caption" muted color={myEffect > 0 ? c.owed : c.owe} style={{ textAlign: 'center' }}>
            {myEffect > 0
              ? `This expense adds ${money(myEffect)} to what you’re owed in ${group.name}.`
              : `This expense adds ${money(-myEffect)} to what you owe in ${group.name}.`}
          </Text>
        </Gutter>
      ) : null}
    </HeroScreen>
  );
}

/** The scanned receipt: a preview that opens full screen. Editors can delete the photo and keep the expense. */
function ReceiptPhoto({ expenseId, path, canRemove }: { expenseId: string; path: string; canRemove: boolean }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const url = useReceiptUrl(path);
  const [open, setOpen] = useState(false);
  const remove = useRemoveReceipt();

  function confirmRemove() {
    Alert.alert('Remove the receipt photo?', 'The photo will be deleted for good and can’t be recovered. The expense stays as it is.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => remove.mutate({ expenseId, path }) },
    ]);
  }
  return (
    <View style={{ gap: space.md }}>
      <SectionTitle title="Receipt" />
      <Gutter>
        {url.data ? (
          <Pressable accessibilityRole="imagebutton" accessibilityLabel="Receipt photo. Tap to view full screen" onPress={() => setOpen(true)}>
            <Image
              source={{ uri: url.data }}
              contentFit="cover"
              contentPosition="top"
              style={{ width: '100%', height: 220, borderRadius: radius.lg, backgroundColor: c.surfaceAlt }}
            />
          </Pressable>
        ) : (
          <Text muted>{url.isError ? 'Couldn’t load the receipt photo.' : 'Loading receipt…'}</Text>
        )}
        {remove.isError ? <Notice>{remove.error.message}</Notice> : null}
        {canRemove ? (
          <View style={{ alignItems: 'flex-start', marginTop: space.sm }}>
            <Button label="Remove photo" kind="danger" size="small" onPress={confirmRemove} loading={remove.isPending} />
          </View>
        ) : null}
      </Gutter>
      <Modal visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {url.data ? <Image source={{ uri: url.data }} contentFit="contain" style={{ flex: 1 }} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close receipt"
            onPress={() => setOpen(false)}
            style={{
              position: 'absolute',
              top: insets.top + space.sm,
              right: space.lg,
              paddingVertical: space.sm,
              paddingHorizontal: space.lg,
              borderRadius: radius.pill,
              backgroundColor: 'rgba(255,255,255,0.2)',
            }}>
            <Text variant="label" color="#fff">
              Close
            </Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}
