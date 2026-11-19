/**
 * Pop-up messages and "Are you sure?" questions in a browser.
 *
 * The app asks with React Native's Alert.alert (Close group, Delete, Leave, Undo payment, …). On
 * phones that's the system dialog; in a browser React Native's version does nothing at all, so
 * every confirm button silently failed. On the web, Alert.alert is pointed at this instead: a card
 * in the middle of the page with the same title, message and buttons, in sic's style.
 */
import { useSyncExternalStore } from 'react';
import { Alert, Pressable, View, type AlertButton } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';

import { Button, Text } from '@/components/ui';
import { space, useColors } from '@/theme';

type Shown = { title: string; message?: string; buttons: AlertButton[]; cancelable: boolean };

let current: Shown | null = null;
const listeners = new Set<() => void>();
const set = (next: Shown | null) => {
  current = next;
  listeners.forEach((l) => l());
};

function show(title: string, message?: string, buttons?: AlertButton[], options?: { cancelable?: boolean }) {
  set({ title, message, buttons: buttons?.length ? buttons : [{ text: 'OK' }], cancelable: options?.cancelable ?? true });
}

/** Point Alert.alert at the web pop-up. Call once, in a browser only. */
export function installWebAlerts() {
  (Alert as { alert: typeof show }).alert = show;
}

export function WebAlertHost() {
  const c = useColors();
  const shown = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  if (!shown) return null;

  const press = (b?: AlertButton) => {
    set(null);
    b?.onPress?.();
  };
  const cancel = shown.buttons.find((b) => b.style === 'cancel');
  // Two buttons sit side by side (Cancel on the left); more than two stack, Cancel last.
  const ordered = [...shown.buttons.filter((b) => b.style !== 'cancel'), ...(cancel ? [cancel] : [])];
  const sideBySide = ordered.length === 2;
  const buttons = sideBySide ? [ordered[1]!, ordered[0]!] : ordered;

  return (
    <Animated.View
      entering={FadeIn.duration(120)}
      exiting={FadeOut.duration(100)}
      style={{ position: 'absolute', inset: 0, zIndex: 100, alignItems: 'center', justifyContent: 'center', padding: space.lg }}>
      <Pressable
        accessibilityLabel="Close"
        onPress={() => (shown.cancelable ? press(cancel) : undefined)}
        style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(47,40,56,0.45)' }}
      />
      <Animated.View
        entering={ZoomIn.duration(160)}
        accessibilityRole="alert"
        style={{ width: '100%', maxWidth: 400, backgroundColor: c.bg, borderRadius: 28, padding: space.lg, gap: space.md }}>
        <Text variant="title" style={{ fontSize: 22, fontWeight: '800', letterSpacing: -0.3 }}>
          {shown.title}
        </Text>
        {shown.message ? <Text muted>{shown.message}</Text> : null}
        <View style={{ flexDirection: sideBySide ? 'row' : 'column', gap: space.sm, marginTop: space.xs }}>
          {buttons.map((b, i) => (
            <View key={`${b.text}-${i}`} style={sideBySide ? { flex: 1 } : undefined}>
              <Button
                size="small"
                kind={b.style === 'destructive' ? 'danger' : b.style === 'cancel' ? 'secondary' : 'primary'}
                label={b.text ?? 'OK'}
                onPress={() => press(b)}
              />
            </View>
          ))}
        </View>
      </Animated.View>
    </Animated.View>
  );
}
