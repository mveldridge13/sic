/**
 * A small pill at the top of the screen, only when there's something to know:
 *   offline            "Offline · updated 2:14 pm · 2 waiting to sync"
 *   back online        "Syncing 2 changes…" (while what was saved offline goes up)
 *   turned down        "1 change couldn't sync" (tap to open it and fix or delete it)
 * No pop-ups: saving offline just works, and the pill and the items' own badges say what's waiting.
 */
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import { useLastSaved, useOnline, useOutbox } from '@/lib/offline';
import { brand, radius, space } from '@/theme';

const time = (ms: number) => {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function OfflineBar() {
  const insets = useSafeAreaInsets();
  const myId = useMyId();
  const online = useOnline();
  const lastSaved = useLastSaved();
  const outbox = useOutbox(myId);
  if (!myId) return null;

  const failed = outbox.filter((e) => e.error);
  const waiting = outbox.length - failed.length;

  let label: string | null = null;
  let onPress: (() => void) | undefined;
  if (failed.length > 0) {
    label = `⚠️ ${failed.length} ${failed.length === 1 ? 'change' : 'changes'} couldn’t sync`;
    const first = failed[0]!;
    onPress = () => router.push({ pathname: first.kind === 'expense' ? '/expense/[id]' : '/payment/[id]', params: { id: first.id } });
  } else if (!online) {
    label = ['Offline', lastSaved ? `updated ${time(lastSaved)}` : null, waiting ? `${waiting} waiting to sync` : null].filter(Boolean).join(' · ');
  } else if (waiting > 0) {
    label = `Syncing ${waiting} ${waiting === 1 ? 'change' : 'changes'}…`;
  }
  if (!label) return null;

  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 4, left: 0, right: 0, alignItems: 'center', zIndex: 50 }}>
      <Animated.View entering={FadeInUp} exiting={FadeOutUp}>
        <Pressable
          accessibilityRole={onPress ? 'button' : 'text'}
          accessibilityLiveRegion="polite"
          onPress={onPress}
          disabled={!onPress}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 5,
            paddingHorizontal: space.md,
            borderRadius: radius.pill,
            backgroundColor: failed.length ? '#B91C1C' : 'rgba(30, 26, 36, 0.86)',
          }}>
          {!online && !failed.length ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#F59E0B' }} /> : null}
          <Text variant="caption" color={brand.onDeep} style={{ fontWeight: '700' }} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}
