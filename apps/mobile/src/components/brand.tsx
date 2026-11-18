import { useFocusEffect } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback, type ReactNode } from 'react';
import { Image, useColorScheme, View } from 'react-native';
import { KeyboardAwareScrollView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { brand, radius, space, useColors } from '@/theme';
import { usePendingInvite } from '@/lib/pending-invite';
import { Notice, Text } from './ui';

const LOGO_DARK = require('../../assets/images/logo-dark.png');
const LOGO_LIGHT = require('../../assets/images/logo-light.png');
/** Width ÷ height of the logo images (made by scripts/generate-icons.mjs from the sic. artwork). */
const LOGO_RATIO = 769 / 360;

/**
 * The sic. logo (without the tagline). Purple with the red full stop on light screens; cream on purple
 * screens and in dark mode. Pass tone="light" when it sits on purple.
 */
export function Logo({ width = 96, tone }: { width?: number; tone?: 'dark' | 'light' }) {
  const scheme = useColorScheme();
  const light = (tone ?? (scheme === 'dark' ? 'light' : 'dark')) === 'light';
  return (
    <Image
      source={light ? LOGO_LIGHT : LOGO_DARK}
      style={{ width, height: width / LOGO_RATIO }}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="sic."
    />
  );
}

/** White status-bar icons while a navy screen (sign in, welcome) is in front. */
export function useLightStatusBar() {
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
    }, []),
  );
}

/** Soft decorative circles for navy hero areas. */
export function HeroGlow({ color = brand.accent, strength = 1 }: { color?: string; strength?: number } = {}) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <View
        style={{
          position: 'absolute',
          width: 320,
          height: 320,
          borderRadius: 160,
          backgroundColor: color,
          opacity: 0.1 * strength,
          top: -120,
          right: -100,
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: 220,
          height: 220,
          borderRadius: 110,
          backgroundColor: color,
          opacity: 0.07 * strength,
          top: 140,
          left: -120,
        }}
      />
    </View>
  );
}

/**
 * Layout for sign-in screens: navy header with logo and title,
 * then a light rounded sheet holding the form.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const c = useColors();
  const pendingInvite = usePendingInvite((state) => state.token);
  const insets = useSafeAreaInsets();
  // While typing, collapse the header to just the title so the form has room above the keyboard.
  const typing = useKeyboardState((state) => state.isVisible);
  useLightStatusBar();
  return (
    <View style={{ flex: 1, backgroundColor: brand.deep }}>
      <HeroGlow />
      <View
        style={{
          paddingTop: insets.top + (typing ? space.md : space.xl),
          paddingHorizontal: space.xl,
          paddingBottom: typing ? space.xl + space.sm : space.xxl + space.lg,
          gap: space.lg,
        }}>
        {typing ? null : <Logo width={104} tone="light" />}
        <View style={{ gap: space.xs }}>
          <Text variant={typing ? 'title' : 'display'} color={brand.onDeep}>
            {title}
          </Text>
          {typing ? null : (
            <Text variant="body" color="rgba(255,255,255,0.75)">
              {subtitle}
            </Text>
          )}
        </View>
      </View>

      <KeyboardAwareScrollView
        showsVerticalScrollIndicator={false}
        bottomOffset={space.xl}
        style={{
          flex: 1,
          backgroundColor: c.bg,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          marginTop: -space.lg,
        }}
        contentContainerStyle={{
          padding: space.xl,
          paddingBottom: insets.bottom + space.xl,
          gap: space.lg,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled">
        {pendingInvite ? (
          <Notice tone="info">You’ve been invited to a group. Create an account or log in and you’ll be added straight away.</Notice>
        ) : null}
        {children}
        {footer ? (
          <View
            style={{
              marginTop: 'auto',
              paddingTop: space.lg,
              alignItems: 'center',
            }}>
            {footer}
          </View>
        ) : null}
      </KeyboardAwareScrollView>
    </View>
  );
}
