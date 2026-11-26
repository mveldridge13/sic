import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Logo } from '@/components/brand';
import { Gutter, HeroScreen, onDeepMuted } from '@/components/dashboard';
import { Button, Notice, Text } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useAcceptInvite } from '@/lib/data';
import { savePendingInvite } from '@/lib/pending-invite';
import { brand, space } from '@/theme';

/**
 * Opened from sic://invite/<token> (via the invite web page) or automatically
 * after sign-in when an invite was saved while signed out.
 *
 * A group link joins you as yourself. An invite sent to a particular guest joins you as that
 * guest, so what's recorded for them becomes yours. A group link never shows who the guests are:
 * if you're one of them, the owner can send you your own invite or link you after you join.
 */
export default function AcceptInviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const accept = useAcceptInvite();
  const started = useRef(false);
  const signedIn = useAuth((s) => !!s.session);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    if (!signedIn) {
      // Not signed in yet: keep the invite and join automatically after sign-up or log-in.
      savePendingInvite(token);
      router.replace('/welcome');
      return;
    }
    accept.mutate({ token: token.trim() }, { onSuccess: (groupId) => router.replace(`/group/${groupId}`) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, signedIn]);

  const failed = accept.isError;

  const card = (
    <View style={{ alignItems: 'center', gap: space.lg }}>
      <Logo width={120} tone="light" />
      {failed ? null : <ActivityIndicator color={brand.accent} />}
      <Text variant="body" color={onDeepMuted} style={{ textAlign: 'center' }}>
        {failed ? 'This invite didn’t work.' : 'Adding you to the group…'}
      </Text>
    </View>
  );

  return (
    <HeroScreen nav="back" eyebrow="Invite" title={failed ? 'Couldn’t join' : 'Joining group'} card={card}>
      <Stack.Screen options={{ headerShown: false }} />
      <Gutter>
        {failed ? (
          <>
            <Notice>{accept.error.message}</Notice>
            <Text variant="caption" muted>
              Invites expire after 14 days, and stop working if the owner turns them off or the group is deleted. Ask for a fresh invite,
              then tap the link or paste it in Groups → Join group.
            </Text>
            <Button label="Back to groups" onPress={() => router.replace('/groups')} />
          </>
        ) : (
          <Text variant="caption" muted style={{ textAlign: 'center' }}>
            You’ll go straight to the group once you’ve joined. If someone already added you by name, ask the owner to link you to it.
          </Text>
        )}
      </Gutter>
    </HeroScreen>
  );
}
