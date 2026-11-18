import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Logo } from '@/components/brand';
import { Gutter, HeroScreen, onDeepMuted } from '@/components/dashboard';
import { Button, Notice, Text } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { inviteGuests, useAcceptInvite } from '@/lib/data';
import { savePendingInvite } from '@/lib/pending-invite';
import { brand, space } from '@/theme';

type Guests = { groupName: string; guests: { id: string; name: string }[] };

/**
 * Opened from sic://invite/<token> (via the invite web page) or automatically
 * after sign-in when an invite was saved while signed out.
 *
 * If the group has guests (people added by name), it first asks whether you're one of them:
 * picking one joins you as that guest, so their share of the expenses becomes yours.
 */
export default function AcceptInviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const accept = useAcceptInvite();
  const started = useRef(false);
  const signedIn = useAuth((s) => !!s.session);
  const [choice, setChoice] = useState<Guests | null>(null);

  const join = (guestId?: string) =>
    accept.mutate({ token: token!.trim(), guestId }, { onSuccess: (groupId) => router.replace(`/group/${groupId}`) });

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    if (!signedIn) {
      // Not signed in yet: keep the invite and join automatically after sign-up or log-in.
      savePendingInvite(token);
      router.replace('/welcome');
      return;
    }
    // Ask first if there are guests to choose from; otherwise (or if asking fails) just join.
    inviteGuests(token.trim())
      .then((g) => (g.guests.length > 0 ? setChoice(g) : join()))
      .catch(() => join());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, signedIn]);

  const failed = accept.isError;
  const asking = !!choice && !accept.isPending && !accept.isSuccess && !failed;

  const card = (
    <View style={{ alignItems: 'center', gap: space.lg }}>
      <Logo width={120} tone="light" />
      {failed || asking ? null : <ActivityIndicator color={brand.accent} />}
      <Text variant="body" color={onDeepMuted} style={{ textAlign: 'center' }}>
        {failed
          ? 'This invite didn’t work.'
          : asking
            ? `You’re joining ${choice!.groupName || 'a group'}.`
            : 'Adding you to the group…'}
      </Text>
    </View>
  );

  return (
    <HeroScreen
      nav="back"
      eyebrow="Invite"
      title={failed ? 'Couldn’t join' : asking ? 'Are you one of these people?' : 'Joining group'}
      card={card}>
      <Stack.Screen options={{ headerShown: false }} />
      <Gutter>
        {failed ? (
          <>
            <Notice>{accept.error.message}</Notice>
            <Text variant="caption" muted>
              Invite codes expire after 14 days and stop working if the group is deleted. Ask for a fresh invite, then tap the link or paste
              it in Groups → Join group.
            </Text>
            <Button label="Back to groups" onPress={() => router.replace('/groups')} />
          </>
        ) : asking ? (
          <View style={{ gap: space.md }}>
            <Text muted>
              Someone added these people by name. If one of them is you, pick it and their share of the expenses becomes yours.
            </Text>
            {choice!.guests.map((g) => (
              <Button key={g.id} kind="secondary" label={`I’m ${g.name}`} onPress={() => join(g.id)} />
            ))}
            <Button label="None of these, join as me" onPress={() => join()} />
          </View>
        ) : (
          <Text variant="caption" muted style={{ textAlign: 'center' }}>
            You’ll go straight to the group once you’ve joined.
          </Text>
        )}
      </Gutter>
    </HeroScreen>
  );
}
