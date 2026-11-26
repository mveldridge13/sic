import { formatMoney } from '@tally/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { Gutter, HeroScreen } from '@/components/dashboard';
import { ConfirmButtons } from '@/components/confirm-payment';
import { GroupIcon } from '@/components/friendly';
import { Button, Card, Divider, Notice, Text } from '@/components/ui';
import { seesEverything, useMarkNotificationsRead, useNotifications, useTallyData, useUndoGuestClaim, type AppNotification } from '@/lib/data';
import { useMyId } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import { usePullToRefresh } from '@/lib/pull-to-refresh';
import { useGroupSummaries } from '@/store/hooks';
import { brand, space, useColors } from '@/theme';

function Row({ n }: { n: AppNotification }) {
  const c = useColors();
  const myId = useMyId();
  const summaries = useGroupSummaries();
  const { data } = useTallyData();
  const undo = useUndoGuestClaim();
  const reminder = n.kind === 'settle_reminder';
  const asksToConfirm = n.kind === 'payment_to_confirm' || n.kind === 'confirm_reminder';
  // A payment to someone who deleted their account: the owner or a co-owner answers it for them.
  const payment = n.settlementId ? data.pendingPayments.find((p) => p.id === n.settlementId) : undefined;
  const forDeleted = payment && data.people[payment.toUserId]?.deleted ? data.people[payment.toUserId]!.name : null;
  // Owners and co-owners can undo someone taking a guest's place.
  const myRole = data.groups.find((g) => g.id === n.group.id)?.myRole;
  const canUndo = n.kind === 'guest_claimed' && !!n.claimId && !n.claimUndone && seesEverything(myRole);
  const askUndo = () =>
    Alert.alert(
      `Undo ${n.actorName} joining as ${n.claimGuestName ?? 'a guest'}?`,
      `Everything recorded for ${n.claimGuestName ?? 'the guest'} goes back to them. If ${n.actorName} has nothing else in ${n.group.name}, they’re taken out of the group. You can then send ${n.claimGuestName ?? 'the guest'} a new invite.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Undo',
          style: 'destructive',
          onPress: () =>
            undo.mutate(n.claimId!, { onError: (e) => Alert.alert('Couldn’t undo that', e instanceof Error ? e.message : 'Please try again.') }),
        },
      ],
    );

  // Notifications stay after you leave or are removed from a group, but there's nothing to open.
  const inGroup = summaries.some((s) => s.group.id === n.group.id);

  function open() {
    if (!inGroup) return;
    // A recurring bill waiting for its amount: straight to entering it.
    if ((n.kind === 'recurring_due' || n.kind === 'recurring_due_reminder') && n.recurringId) {
      router.push({ pathname: '/add-expense', params: { dueId: n.recurringId, groupId: n.group.id } });
      return;
    }
    if (reminder) {
      // Straight to Settle up with what you owe now; if you've already settled, the group instead.
      const mine = summaries.find((s) => s.group.id === n.group.id)?.transfers.find((t) => t.fromUserId === myId);
      if (mine) {
        router.push({
          pathname: '/settle',
          params: { groupId: n.group.id, from: mine.fromUserId, to: mine.toUserId, amount: String(mine.amount) },
        });
        return;
      }
    }
    router.push(`/group/${n.group.id}`);
  }

  const bold = (t: string) => (
    <Text variant="body" style={{ fontWeight: '700' }}>
      {t}
    </Text>
  );

  return (
    <Pressable
      accessibilityRole={inGroup ? 'button' : 'text'}
      onPress={open}
      disabled={!inGroup}
      android_ripple={{ color: c.surfaceAlt }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
      <GroupIcon group={n.group} size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        {reminder ? (
          <Text variant="body">
            {bold(n.actorName)} reminded you to settle up in {bold(n.group.name)}
            {n.amount ? ` · You owe ${formatMoney(n.amount, n.group.currency)}` : ''}
          </Text>
        ) : n.kind === 'made_co_owner' ? (
          <Text variant="body">
            {bold(n.actorName)} made you a co-owner of {bold(n.group.name)} · You can now see everything in this group
          </Text>
        ) : n.kind === 'made_owner' ? (
          <Text variant="body">
            {bold(n.actorName)} made you the owner of {bold(n.group.name)} · You now manage the group
          </Text>
        ) : n.kind === 'owner_handed_over' ? (
          <Text variant="body">
            {bold(n.actorName)} deleted their account, so you’re now the owner of {bold(n.group.name)}
          </Text>
        ) : n.kind === 'removed_from_group' ? (
          <Text variant="body">
            {bold(n.actorName)} removed you from {bold(n.group.name)}
          </Text>
        ) : n.kind === 'group_settled' ? (
          <Text variant="body">
            {bold(n.group.name)} is all settled up · Everyone’s square
          </Text>
        ) : (n.kind === 'payment_to_confirm' || n.kind === 'confirm_reminder') && forDeleted ? (
          <Text variant="body">
            {bold(n.actorName)} says they paid {bold(forDeleted)} {bold(formatMoney(n.amount ?? 0, n.group.currency))} in {bold(n.group.name)}
            {' · '}They deleted their account, so you can confirm it for them
          </Text>
        ) : n.kind === 'payment_to_confirm' || n.kind === 'confirm_reminder' ? (
          <Text variant="body">
            {bold(n.actorName)} {n.kind === 'confirm_reminder' ? 'is waiting for you to confirm' : 'says they paid you'}{' '}
            {bold(formatMoney(n.amount ?? 0, n.group.currency))} in {bold(n.group.name)}
            {n.settlementStatus === 'pending' ? ' · Did it arrive?' : ''}
          </Text>
        ) : n.kind === 'recurring_heads_up' ? (
          <Text variant="body">
            {bold(n.recurringDescription ?? 'A recurring expense')}
            {n.amount ? ` ${formatMoney(n.amount, n.group.currency)}` : ''} is coming up in {bold(n.group.name)}
          </Text>
        ) : n.kind === 'recurring_added' ? (
          <Text variant="body">
            {bold(n.recurringDescription ?? 'A recurring expense')}
            {n.amount ? ` ${formatMoney(n.amount, n.group.currency)}` : ''} was added to {bold(n.group.name)}
          </Text>
        ) : n.kind === 'recurring_due' ? (
          <Text variant="body">
            {bold(n.recurringDescription ?? 'A bill')} in {bold(n.group.name)} is due · Enter this time’s amount
          </Text>
        ) : n.kind === 'recurring_due_reminder' ? (
          <Text variant="body">
            {bold(n.recurringDescription ?? 'A bill')} in {bold(n.group.name)} still needs this time’s amount
          </Text>
        ) : n.kind === 'payment_confirmed' ? (
          <Text variant="body">
            {bold(n.actorName)} confirmed your {bold(formatMoney(n.amount ?? 0, n.group.currency))} payment in {bold(n.group.name)}
          </Text>
        ) : n.kind === 'payment_declined' ? (
          <Text variant="body">
            {bold(n.actorName)} says your {bold(formatMoney(n.amount ?? 0, n.group.currency))} payment in {bold(n.group.name)} hasn’t
            arrived · It’s been removed, so check with them
          </Text>
        ) : n.kind === 'member_joined' ? (
          <Text variant="body">
            {bold(n.actorName)} joined {bold(n.group.name)} with an invite link
          </Text>
        ) : n.kind === 'guest_claimed' && n.claimVia === 'merge' ? (
          <Text variant="body">
            {bold(n.actorName)} is now linked to {bold(n.claimGuestName ?? 'a guest')} in {bold(n.group.name)} · Everything recorded for{' '}
            {n.claimGuestName ?? 'them'} is theirs now
          </Text>
        ) : n.kind === 'guest_claimed' ? (
          <Text variant="body">
            {bold(n.actorName)} joined {bold(n.group.name)} as {bold(n.claimGuestName ?? 'a guest')} · Everything recorded for{' '}
            {n.claimGuestName ?? 'them'} is theirs now
          </Text>
        ) : n.kind === 'merged_with_guest' ? (
          <Text variant="body">
            {bold(n.actorName)} linked you with {bold(n.claimGuestName ?? 'a guest')} in {bold(n.group.name)} · What was recorded for{' '}
            {n.claimGuestName ?? 'them'} is now yours
          </Text>
        ) : n.kind === 'claim_undone' ? (
          <Text variant="body">
            {bold(n.actorName)} undid your joining {bold(n.group.name)} as someone who was already in it · Ask them if that was a mistake
          </Text>
        ) : n.kind === 'removed_co_owner' ? (
          <Text variant="body">
            {bold(n.actorName)} removed you as co-owner of {bold(n.group.name)} · You’ll now see only items you added
          </Text>
        ) : (
          <Text variant="body">
            {bold(n.actorName)} added you to {bold(n.group.name)}
          </Text>
        )}
        <Text variant="caption" muted>
          {relativeTime(n.at)}
          {asksToConfirm && n.settlementStatus !== 'pending'
            ? ` · ${n.settlementStatus === 'recorded' ? 'Confirmed' : n.settlementStatus === 'declined' ? 'Marked as not arrived' : 'Cancelled'}`
            : ''}
          {(n.kind === 'guest_claimed' || n.kind === 'merged_with_guest') && n.claimUndone ? ' · Undone' : ''}
        </Text>
        {/* Still waiting for you: answer right here. */}
        {asksToConfirm && n.settlementStatus === 'pending' && n.settlementId ? (
          <View style={{ marginTop: space.sm }}>
            <ConfirmButtons settlementId={n.settlementId} fromName={n.actorName} amount={n.amount ?? 0} currency={n.group.currency} />
          </View>
        ) : null}
        {canUndo ? (
          <View style={{ marginTop: space.sm, alignSelf: 'flex-start' }}>
            <Button size="small" kind="secondary" label="Wrong person? Undo" onPress={askUndo} loading={undo.isPending} />
          </View>
        ) : null}
      </View>
      {/* Dot for ones that were new when you opened the screen. */}
      {!n.read ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: brand.slash }} /> : null}
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const { data, refetch, isLoading, error } = useNotifications();
  const pull = usePullToRefresh(refetch);
  const markRead = useMarkNotificationsRead();
  // What was unread on arrival keeps its dot while you're here; the bell clears straight away.
  const [unreadOnArrival, setUnreadOnArrival] = useState<Set<string> | null>(null);
  if (unreadOnArrival === null && !isLoading) setUnreadOnArrival(new Set(data.filter((n) => !n.read).map((n) => n.id)));

  const { mutate } = markRead;
  const hasUnread = data.some((n) => !n.read);
  useEffect(() => {
    if (hasUnread) mutate();
  }, [hasUnread, mutate]);

  return (
    <HeroScreen nav="back" title="Notifications" refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Gutter>
        {error ? <Notice>Couldn’t load notifications. Pull down to try again.</Notice> : null}
        {data.length === 0 ? (
          <Card>
            <Text muted>
              {isLoading ? 'Loading…' : 'Nothing yet. Updates about your groups, like being added or reminded to settle up, show up here.'}
            </Text>
          </Card>
        ) : (
          <Card style={{ paddingVertical: 0 }}>
            {data.map((n, i) => (
              <View key={n.id}>
                {i > 0 ? <Divider /> : null}
                <Row n={{ ...n, read: !unreadOnArrival?.has(n.id) }} />
              </View>
            ))}
          </Card>
        )}
      </Gutter>
    </HeroScreen>
  );
}
