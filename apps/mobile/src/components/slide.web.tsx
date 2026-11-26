import { useRef, useState } from 'react';
import { Animated as RNAnimated, View } from 'react-native';

import { brand, radius, useColors } from '@/theme';
import { Text } from './ui';

const KNOB = 56;
const PAD = 4;

type WebPointer = { nativeEvent: { pageX: number; pointerId: number }; currentTarget: unknown };

/**
 * The web version of SlideToConfirm (phones use the one in fun.tsx, see slide.tsx). It looks the same.
 * Two web-only differences:
 * - It never swaps itself for a plain button: in the browser, "is a screen reader on?" always says yes,
 *   which is why the phone version showed a "Slide…" button there that couldn't be slid.
 * - Dragging uses the browser's pointer events, which cover a mouse, a finger and a pen.
 */
export function SlideToConfirm({ label, onConfirm, disabled }: { label: string; onConfirm: () => void; disabled?: boolean }) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const [x] = useState(() => new RNAnimated.Value(0));
  const max = Math.max(0, width - KNOB - PAD * 2);
  const done = useRef(false);
  const dragging = useRef(false);
  const startX = useRef(0);
  const dx = useRef(0);

  const handlers = {
    onPointerDown: (e: WebPointer) => {
      if (disabled || done.current) return;
      // Keep getting the pointer's moves even when it leaves the knob.
      (e.currentTarget as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.nativeEvent.pointerId);
      dragging.current = true;
      startX.current = e.nativeEvent.pageX;
      dx.current = 0;
    },
    onPointerMove: (e: WebPointer) => {
      if (!dragging.current) return;
      dx.current = e.nativeEvent.pageX - startX.current;
      x.setValue(Math.max(0, Math.min(max, dx.current)));
    },
    onPointerUp: () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (dx.current > max * 0.85) {
        done.current = true;
        RNAnimated.timing(x, { toValue: max, duration: 120, useNativeDriver: false }).start(() => onConfirm());
      } else {
        RNAnimated.spring(x, { toValue: 0, bounciness: 12, useNativeDriver: false }).start();
      }
    },
    onPointerCancel: () => {
      dragging.current = false;
      RNAnimated.spring(x, { toValue: 0, useNativeDriver: false }).start();
    },
  };

  const fill = x.interpolate({ inputRange: [0, Math.max(1, max)], outputRange: [KNOB + PAD * 2, width || KNOB], extrapolate: 'clamp' });
  const hint = x.interpolate({ inputRange: [0, Math.max(1, max * 0.6)], outputRange: [1, 0], extrapolate: 'clamp' });
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      style={{
        height: KNOB + PAD * 2,
        borderRadius: radius.pill,
        backgroundColor: c.surfaceAlt,
        overflow: 'hidden',
        opacity: disabled ? 0.5 : 1,
      }}>
      <RNAnimated.View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: fill,
          borderRadius: radius.pill,
          backgroundColor: brand.coralSoft,
        }}
      />
      <RNAnimated.View
        pointerEvents="none"
        style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', paddingLeft: KNOB, opacity: hint }}>
        <Text variant="heading" muted>
          {label}
        </Text>
      </RNAnimated.View>
      <RNAnimated.View
        {...handlers}
        style={
          {
            position: 'absolute',
            left: PAD,
            top: PAD,
            width: KNOB,
            height: KNOB,
            borderRadius: KNOB / 2,
            backgroundColor: c.primary,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ translateX: x }],
            // The drag moves the knob, not the page, and doesn't select text.
            touchAction: 'none',
            userSelect: 'none',
            cursor: disabled ? 'default' : 'grab',
          } as object
        }>
        <Text style={{ fontSize: 24, color: c.onPrimary, fontWeight: '700' }}>→</Text>
      </RNAnimated.View>
    </View>
  );
}
