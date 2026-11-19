/**
 * A guest's own view link (on their balance page): share it so they can see their part of the
 * group in a browser, with no app or account, and turn it off again. View only.
 * Anyone in the group can share it; the owner, co-owners and whoever shared it can turn it off.
 */
import { Alert, Share, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import { seesEverything, useGuestLink, useShareGuestLink, useTurnOffGuestLink, type GroupRole } from '@/lib/data';
import { guestLinkMessage } from '@/lib/invite';
import { space } from '@/theme';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function GuestLinkCard({
  groupId,
  groupName,
  myRole,
  guestId,
  guestName,
}: {
  groupId: string;
  groupName: string;
  myRole: GroupRole | undefined;
  guestId: string;
  guestName: string;
}) {
  const myId = useMyId();
  const { data: link } = useGuestLink(groupId, guestId);
  const share = useShareGuestLink();
  const turnOff = useTurnOffGuestLink();
  const canTurnOff = !!link && (seesEverything(myRole) || link.createdBy === myId);

  function shareLink() {
    share.mutate(
      { groupId, guestId },
      {
        onSuccess: (token) => void Share.share({ message: guestLinkMessage(groupName, guestName, token) }),
        onError: (e) => Alert.alert('Couldn’t make the link', e instanceof Error ? e.message : 'Please try again.'),
      },
    );
  }

  function confirmTurnOff() {
    Alert.alert(`Turn off ${guestName}’s link?`, 'The link stops working straight away. You can share a new one later.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Turn off',
        style: 'destructive',
        onPress: () =>
          turnOff.mutate(
            { groupId, guestId },
            { onError: (e) => Alert.alert('Couldn’t turn it off', e instanceof Error ? e.message : 'Please try again.') },
          ),
      },
    ]);
  }

  return (
    <Card style={{ gap: space.sm }}>
      <Text variant="heading">🔗 {guestName}’s link</Text>
      <Text variant="caption" muted>
        {guestName} can open it in a browser to see what they owe, what they’ve paid and how to pay. No app or account needed, and
        they can’t change anything.
      </Text>
      {link ? (
        <Text variant="caption" muted style={{ fontWeight: '600' }}>
          {link.lastViewedAt ? `Last opened ${shortDate(link.lastViewedAt)}` : `Shared ${shortDate(link.createdAt)} · not opened yet`}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" size="small" label={link ? 'Share again' : `Share ${guestName}’s link`} onPress={shareLink} loading={share.isPending} />
        </View>
        {canTurnOff ? (
          <View style={{ flex: 1 }}>
            <Button kind="secondary" size="small" label="Turn off link" onPress={confirmTurnOff} loading={turnOff.isPending} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}
