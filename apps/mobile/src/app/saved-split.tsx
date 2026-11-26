/**
 * Make or change a saved split (Saved splits → ＋ New saved split, or Edit / Update on one).
 * A name, Equally / Percent / Shares, and one row per person in the group: tick who's in, and
 * for Percent or Shares type their number. People who've left the group are taken out when a
 * split is updated, and their share is never handed to anyone automatically.
 */
import { centsToDecimalString, FULL_PERCENT_BPS, parseToCents } from '@tally/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Gutter, HeroScreen } from '@/components/dashboard';
import { Avatar, Button, Card, Chip, Divider, Field, Notice, Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import { goneFromSplit, useNameOf, useSaveSplit, useTallyData, useUpdateSplit, type SavedSplitMethod } from '@/lib/data';
import { formFromSaved, SAVED_METHOD_LABEL, savedFromForm } from '@/lib/saved-splits';
import { brand, groupColor, radius, space, type, useColors } from '@/theme';
import { goBack } from '@/lib/nav';

const HINTS: Record<SavedSplitMethod, string> = {
  equal: 'Everyone ticked pays the same.',
  percentage: 'Each person’s percentage. They must add up to 100%.',
  shares: 'Someone with 2 shares pays twice as much as someone with 1.',
};

export default function SavedSplitScreen() {
  const c = useColors();
  const myId = useMyId();
  const name = useNameOf();
  const { groupId, id } = useLocalSearchParams<{ groupId: string; id?: string }>();
  const { data } = useTallyData();
  const group = data.groups.find((g) => g.id === groupId);
  const existing = data.savedSplits.find((sp) => sp.id === id);
  const members = group?.pickableIds ?? [];
  const gone = existing && group ? goneFromSplit(existing, group.pickableIds) : [];

  const start = existing ? formFromSaved(existing, members) : { method: 'percentage' as SavedSplitMethod, included: {}, values: {} };
  const [splitName, setSplitName] = useState(existing?.name ?? '');
  const [method, setMethod] = useState<SavedSplitMethod>(start.method);
  const [included, setIncluded] = useState<Record<string, boolean>>(start.included);
  const [values, setValues] = useState<Record<string, string>>(start.values);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveSplit();
  const update = useUpdateSplit();
  const busy = save.isPending || update.isPending;

  if (!group || (id && !existing)) {
    return (
      <HeroScreen nav="close" title="Saved split">
        <Stack.Screen options={{ headerShown: false }} />
        <Gutter>
          <Notice tone="info">This saved split no longer exists.</Notice>
        </Gutter>
      </HeroScreen>
    );
  }

  const isIn = (uid: string) => included[uid] ?? true;
  const people = members.filter(isIn);
  // Percent: what's left to reach 100%, off by rounding only (33.33% × 3) counting as done.
  let left: string | null = null;
  if (method === 'percentage') {
    try {
      const sum = people.reduce((t, uid) => t + parseToCents(values[uid] || '0'), 0);
      const diff = FULL_PERCENT_BPS - sum;
      if (Math.abs(diff) > people.length - 1) {
        const pct = centsToDecimalString(Math.abs(diff)).replace(/\.00$/, '');
        left = diff > 0 ? `${pct}% left to assign` : `${pct}% too much assigned`;
      }
    } catch {
      left = 'Check the numbers you entered.';
    }
  }

  function submit() {
    setError(null);
    if (!splitName.trim()) return setError('Give the split a name, like “Electricity”.');
    const shares = savedFromForm(method, people, values);
    if (!shares.ok) return setError(shares.error);
    const input = { name: splitName.trim(), method, shares: shares.shares };
    const done = { onSuccess: () => goBack(), onError: (e: Error) => setError(e.message) };
    if (existing) update.mutate({ ...input, id: existing.id }, done);
    else save.mutate({ ...input, groupId: group!.id }, done);
  }

  return (
    <HeroScreen
      nav="close"
      eyebrow={`${group.icon ? `${group.icon} ` : ''}${group.name}`}
      title={existing ? (gone.length ? 'Update saved split' : 'Edit saved split') : 'New saved split'}>
      <Stack.Screen options={{ headerShown: false }} />
      <Gutter>
        {gone.length ? (
          <Notice tone="info">
            {`${gone.map(name).join(' and ')} ${gone.length === 1 ? 'has' : 'have'} left the group and ${gone.length === 1 ? 'has' : 'have'} been taken out. Their share isn’t given to anyone: check the numbers before saving.`}
          </Notice>
        ) : null}
        {existing ? (
          <Text variant="caption" muted>
            Changes apply to new expenses only. Expenses already split this way stay as they are.
          </Text>
        ) : null}

        <Field label="Name" value={splitName} onChangeText={setSplitName} placeholder="e.g. Electricity" maxLength={40} />

        <View style={{ gap: space.sm }}>
          <Text variant="label">How it’s split</Text>
          <View style={{ flexDirection: 'row', gap: space.xs }}>
            {(['equal', 'percentage', 'shares'] as const).map((m) => (
              <Chip
                key={m}
                label={SAVED_METHOD_LABEL[m]}
                selected={method === m}
                onPress={() => {
                  setMethod(m);
                  setValues({});
                }}
              />
            ))}
          </View>
          <Text variant="caption" muted>
            {HINTS[method]}
          </Text>
        </View>

        <Card style={{ paddingVertical: space.xs }}>
          {members.map((uid, i) => {
            const on = isIn(uid);
            return (
              <View key={uid}>
                {i > 0 ? <Divider /> : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, opacity: on ? 1 : 0.55 }}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`Include ${name(uid)}`}
                    onPress={() => setIncluded((s) => ({ ...s, [uid]: !on }))}
                    hitSlop={8}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      borderWidth: 2,
                      borderColor: on ? c.focus : c.border,
                      backgroundColor: on ? c.focus : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                    {on ? <Text style={{ color: brand.onDeep, fontSize: 14, fontWeight: '800', lineHeight: 16 }}>✓</Text> : null}
                  </Pressable>
                  <Avatar name={name(uid)} size={26} color={on ? groupColor(uid) : undefined} />
                  <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
                    {uid === myId ? 'You' : name(uid)}
                  </Text>
                  {method !== 'equal' && on ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: space.sm }}>
                      <TextInput
                        value={values[uid] ?? ''}
                        onChangeText={(v) => setValues((s) => ({ ...s, [uid]: v }))}
                        placeholder={method === 'shares' ? '1' : '0'}
                        placeholderTextColor={c.textMuted}
                        keyboardType={method === 'shares' ? 'number-pad' : 'decimal-pad'}
                        selectionColor={c.focus}
                        accessibilityLabel={`${name(uid)} ${method === 'percentage' ? 'percentage' : 'shares'}`}
                        style={{ ...type.body, color: c.text, width: 64, textAlign: 'right', paddingVertical: space.sm }}
                      />
                      {method === 'percentage' ? <Text muted> %</Text> : null}
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Card>

        {left ? (
          <Text variant="label" color={c.danger} style={{ textAlign: 'center' }}>
            {left}
          </Text>
        ) : null}
        {error ? <Notice>{error}</Notice> : null}
        <Button label={existing ? 'Save changes' : 'Save split'} onPress={submit} loading={busy} />
      </Gutter>
    </HeroScreen>
  );
}
