/**
 * The category tiles, in the same playful style as New group's "What's it for?": two big tiles a
 * row in alternating warm and lavender, springing in one after another, squashing when pressed.
 * The picked tile turns purple and pops, the others fade, and the choice lands a beat later so
 * the pop can be seen. Used on Add expense (pick a category) and Activity (filter by one).
 */
import { useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Bouncy, buzz } from '@/components/fun';
import { Text } from '@/components/ui';
import { radius, space, useColors } from '@/theme';

export interface GridTile<Id extends string> {
  id: Id;
  emoji: string;
  name: string;
  /** A small line under the name: "suggested", or a count. */
  note?: string;
}

export function CategoryGrid<Id extends string>({
  tiles,
  selected,
  onPick,
}: {
  tiles: readonly GridTile<Id>[];
  selected: Id | null;
  onPick: (id: Id) => void;
}) {
  const c = useColors();
  // The tile just tapped, shown as picked while it pops (the sheet closes a moment later).
  const [tapped, setTapped] = useState<Id | null>(null);
  const current = tapped ?? selected;
  const rows: GridTile<Id>[][] = [];
  for (let i = 0; i < tiles.length; i += 2) rows.push(tiles.slice(i, i + 2));

  function pick(id: Id) {
    if (tapped) return;
    buzz.tap();
    setTapped(id);
    setTimeout(() => {
      onPick(id);
      setTapped(null);
    }, 280);
  }

  return (
    <View style={{ gap: space.md }}>
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', gap: space.md, height: 92 }}>
          {row.map((t, i) => {
            const chosen = current === t.id;
            const faded = !!tapped && !chosen;
            const warm = (r + i) % 2 === 0;
            return (
              <Animated.View
                key={t.id}
                entering={FadeInDown.delay((r * 2 + i) * 40)
                  .springify()
                  .damping(16)}
                style={{ flex: 1 }}>
                <Bouncy
                  grow
                  accessibilityRole="radio"
                  accessibilityState={{ selected: chosen }}
                  accessibilityLabel={t.note ? `${t.name}, ${t.note}` : t.name}
                  onPress={() => pick(t.id)}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                    paddingHorizontal: space.sm,
                    borderRadius: radius.xl - 8,
                    backgroundColor: chosen ? c.primary : warm ? c.warm : c.surfaceAlt,
                    opacity: faded ? 0.35 : 1,
                    transform: [{ scale: chosen ? 1.04 : 1 }],
                  }}>
                  <Text style={{ fontSize: 26, lineHeight: 32 }}>{t.emoji}</Text>
                  <Text variant="heading" color={chosen ? c.onPrimary : c.text} numberOfLines={1} style={{ fontWeight: '700' }}>
                    {t.name}
                  </Text>
                  {t.note ? (
                    <Text variant="caption" color={chosen ? c.onPrimary : c.textMuted} style={{ fontWeight: '600' }}>
                      {t.note}
                    </Text>
                  ) : null}
                </Bouncy>
              </Animated.View>
            );
          })}
          {/* An odd tile out keeps its half width. */}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}
