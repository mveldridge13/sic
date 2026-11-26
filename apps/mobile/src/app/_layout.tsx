import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Platform, useColorScheme } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { OfflineBar } from '@/components/offline-bar';
import { installWebAlerts, WebAlertHost } from '@/components/web-alert';
import { useAuth } from '@/lib/auth';
import { TALLY_KEY } from '@/lib/data';
import { flushOutbox, forgetCache, setRefresher, whenReconnected } from '@/lib/offline';
import { emptyReceiptTrash } from '@/lib/receipts';
import { brand, useColors } from '@/theme';

SplashScreen.preventAutoHideAsync();
// Fade the purple splash into the first screen (which also starts purple) instead of cutting to it.
SplashScreen.setOptions({ fade: true, duration: 350 });

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

// In a browser, fields get the browser's own blue focus box on top of sic's styling. Every field
// already shows focus its own way, so the browser's box is turned off for all of them at once.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = 'input:focus, textarea:focus { outline: none; }';
  document.head.appendChild(style);
  // Alert.alert does nothing in a browser: show sic's own pop-up instead (see web-alert.tsx).
  installWebAlerts();
}

// Back online: send what was saved with no signal, then bring everything up to date.
setRefresher(() => queryClient.invalidateQueries({ queryKey: TALLY_KEY }));
whenReconnected(() => {
  void flushOutbox().then((sent) => {
    // flushOutbox already refreshed when it sent something.
    if (!sent) void queryClient.invalidateQueries({ queryKey: TALLY_KEY });
  });
});

// Refetch when the app comes back to the foreground.
AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));

export default function RootLayout() {
  const scheme = useColorScheme();
  const c = useColors();
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const { session, ready } = useAuth();
  const signedIn = !!session;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  const userId = session?.user.id;
  useEffect(() => {
    // Drop cached data from a previous account on sign-out, including the copy kept on the phone.
    if (!userId) return;
    // Signed in: send anything saved with no signal last time, and have the server delete any
    // receipt photos it couldn't delete before.
    void flushOutbox();
    emptyReceiptTrash();
    return () => {
      queryClient.clear();
      if (!useAuth.getState().session) forgetCache(userId);
    };
  }, [userId]);

  if (!ready) return null;

  return (
    <KeyboardProvider>
      <QueryClientProvider client={queryClient}>
        {/* background = navy: every screen starts with a navy header, so nothing light flashes while a screen slides in */}
        <ThemeProvider
          value={{
            ...base,
            colors: {
              ...base.colors,
              background: brand.deep,
              card: c.surface,
              text: c.text,
              primary: c.primary,
              border: c.border,
            },
          }}>
          {/* Every screen has a navy top, so the status bar stays light. Flipping it per screen made it flicker. */}
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              // Screens slide in from the right; forms (modals below) slide up from the bottom.
              animation: 'slide_from_right',
              contentStyle: { backgroundColor: brand.deep },
            }}>
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="group/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="expense/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="payment/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="balance/[groupId]" />
              <Stack.Screen name="notifications" options={{ headerShown: false }} />
              <Stack.Screen
                name="add-expense"
                options={{
                  presentation: 'modal',
                  animation: 'slide_from_bottom',
                }}
              />
              <Stack.Screen
                name="new-group"
                options={{
                  presentation: 'modal',
                  animation: 'slide_from_bottom',
                }}
              />
              <Stack.Screen
                name="saved-split"
                options={{
                  presentation: 'modal',
                  animation: 'slide_from_bottom',
                }}
              />
              <Stack.Screen
                name="settle"
                options={{
                  presentation: 'modal',
                  animation: 'slide_from_bottom',
                }}
              />
            </Stack.Protected>
            {/* Reachable signed in or out: signed out, it saves the invite and sends you to sign up. */}
            <Stack.Screen name="invite/[token]" options={{ headerShown: false }} />
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="welcome" options={{ animation: 'fade' }} />
              <Stack.Screen name="sign-in" options={{ headerShown: false }} />
              <Stack.Screen name="sign-up" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
          {/* Offline, syncing, or something that couldn't sync: a small pill over every screen. */}
          {signedIn ? <OfflineBar /> : null}
          {Platform.OS === 'web' ? <WebAlertHost /> : null}
        </ThemeProvider>
      </QueryClientProvider>
    </KeyboardProvider>
  );
}
