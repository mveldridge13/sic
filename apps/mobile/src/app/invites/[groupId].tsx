/**
 * A group's invites that still work (group page → ⋯ → Invites). Owner and co-owners only.
 * Each is either the group link (anyone with it joins as themselves) or one sent to a particular
 * guest (whoever uses it takes that guest's place). Turn one off if it went to the wrong person or
 * got passed around; Replace turns it off and shares a fresh one of the same kind.
 */
import { Stack, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, Share, View } from 'react-native';

import { Gutter, HeroScreen } from '@/components/dashboard';
import { Card, Notice, Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import { seesEverything, useOpenInvites, useTallyData, useTurnOffInvite, type OpenInvite } from '@/lib/data';
import { inviteMessage } from '@/lib/invite';
import { usePullToRefresh } from '@/lib/pull-to-refresh';
import { radius, space, useColors } from '@/theme';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Action({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        paddingVertical: space.xs + 2,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: c.surfaceAlt,
        opacity: pressed ? 0.7 : 1,
      })}>
      <Text variant="label" color={danger ? c.danger : c.primary}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function InvitesScreen() {
  const c = useColors();
  const myId = useMyId();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { data } = useTallyData();
  const group = data.groups.find((g) => g.id === groupId);
  const admin = seesEverything(group?.myRole);
  const invites = useOpenInvites(groupId, admin);
  const pull = usePullToRefresh(invites.refetch);
  const turnOff = useTurnOffInvite();

  if (!group || !admin) {
    return (
      <HeroScreen nav="back" title="Invites">
        <Stack.Screen options={{ headerShown: false }} />
        <Gutter>
          <Notice tone="info">Only the group’s owner and co-owners can see its invites.</Notice>
        </Gutter>
      </HeroScreen>
    );
  }

  const fail = (title: string) => (e: unknown) => Alert.alert(title, e instanceof Error ? e.message : 'Please try again.');
  const what = (i: OpenInvite) => (i.guestId ? `${i.guestName ?? 'a guest'}’s invite` : 'the group link');

  function confirmOff(i: OpenInvite) {
    Alert.alert(
      `Turn off ${what(i)}?`,
      i.guestId
        ? `Nobody can use it to join as ${i.guestName ?? 'this guest'}. You can send them a new one any time.`
        : 'Nobody new can join with it. People already in the group stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn off', style: 'destructive', onPress: () => turnOff.mutate({ inviteId: i.id, groupId }, { onError: fail('Couldn’t turn it off') }) },
      ],
    );
  }

  function confirmReplace(i: OpenInvite) {
    Alert.alert(`Replace ${what(i)}?`, 'The old link stops working, and you can share the new one.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Replace',
        onPress: () =>
          turnOff.mutate(
            { inviteId: i.id, groupId, replace: true },
            {
              onSuccess: (token) => {
                if (token) void Share.share({ message: inviteMessage(group!.name, token, i.guestName ?? undefined) });
              },
              onError: fail('Couldn’t replace it'),
            },
          ),
      },
    ]);
  }

  const list = invites.data ?? [];
  return (
    <HeroScreen
      nav="back"
      eyebrow={`${group.icon ? `${group.icon} ` : ''}${group.name}`}
      title="Invites"
      subtitle="Links that still work. Each lasts 14 days."
      refreshing={pull.refreshing}
      onRefresh={pull.onRefresh}>
      <Stack.Screen options={{ headerShown: false }} />
      <Gutter>
        {invites.error ? <Notice>Couldn’t load invites. Pull down to try again.</Notice> : null}
        {!invites.isLoading && list.length === 0 ? (
          <View
            style={{
              alignItems: 'center',
              gap: space.sm,
              paddingVertical: space.xl,
              borderRadius: radius.lg,
              backgroundColor: c.surface,
              borderWidth: 1,
              borderColor: c.border,
            }}>
            <Text style={{ fontSize: 36 }}>✉️</Text>
            <Text muted style={{ textAlign: 'center', paddingHorizontal: space.lg }}>
              No invites are open. Share one from the ⋯ menu, or from a guest’s page to invite them.
            </Text>
          </View>
        ) : null}
        {list.map((i) => (
          <Card key={i.id} style={{ gap: space.sm }}>
            <Text variant="label" style={{ fontWeight: '700' }}>
              {i.guestId ? `For ${i.guestName ?? 'a guest'}` : 'Group link'}
            </Text>
            <Text variant="caption" muted>
              {i.guestId
                ? `Whoever uses it joins as ${i.guestName ?? 'this guest'} and takes over what’s recorded for them.`
                : 'Anyone with it joins as themselves.'}
            </Text>
            <Text variant="caption" muted>
              Shared by {i.invitedById === myId ? 'you' : (i.invitedByName ?? 'someone')} on {shortDate(i.createdAt)} · works until{' '}
              {shortDate(i.expiresAt)}
            </Text>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.xs }}>
              <Action label="Replace" onPress={() => confirmReplace(i)} />
              <Action label="Turn off" danger onPress={() => confirmOff(i)} />
            </View>
          </Card>
        ))}
      </Gutter>
    </HeroScreen>
  );
}
