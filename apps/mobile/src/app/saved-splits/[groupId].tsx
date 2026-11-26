/**
 * A group's saved splits (group page → ⋯ → Saved splits): one card per split with who's in it and
 * their numbers, who made it and who last changed it. Anyone in the group can add one; whoever made
 * it, the owner and co-owners can change or delete it; the owner and co-owners choose the default.
 * A split with someone who has left shows as "Needs updating" and can't be used until it's fixed.
 */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, View } from 'react-native';

import { Gutter, HeroScreen } from '@/components/dashboard';
import { Card, Notice, Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import {
  goneFromSplit,
  seesEverything,
  useDeleteSplit,
  useNameOf,
  useSetDefaultSplit,
  useTallyData,
  type SavedSplit,
} from '@/lib/data';
import { describeSplit, SAVED_METHOD_LABEL } from '@/lib/saved-splits';
import { radius, space, useColors } from '@/theme';

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function Action({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        paddingVertical: space.xs + 2,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: c.surfaceAlt,
        opacity: pressed ? 0.7 : 1,
      })}>
      <Text variant="label" color={danger ? c.danger : c.primary}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function SavedSplitsScreen() {
  const c = useColors();
  const myId = useMyId();
  const name = useNameOf();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { data } = useTallyData();
  const group = data.groups.find((g) => g.id === groupId);
  const splits = data.savedSplits.filter((sp) => sp.groupId === groupId);
  const setDefault = useSetDefaultSplit();
  const deleteSplit = useDeleteSplit();

  if (!group) {
    return (
      <HeroScreen nav="back" title="Saved splits">
        <Stack.Screen options={{ headerShown: false }} />
        <Gutter>
          <Notice tone="info">This group no longer exists, or you’re no longer a member.</Notice>
        </Gutter>
      </HeroScreen>
    );
  }
  const admin = seesEverything(group.myRole);
  const closed = !!group.closedAt;
  const who = (id: string | null) => (!id ? 'someone' : id === myId ? 'you' : name(id));
  const fail = (title: string) => (e: unknown) => Alert.alert(title, e instanceof Error ? e.message : 'Please try again.');

  function confirmDelete(sp: SavedSplit) {
    Alert.alert(`Delete “${sp.name}”?`, 'Expenses already split this way stay exactly as they are.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteSplit.mutate(sp.id, { onError: fail('Couldn’t delete it') }) },
    ]);
  }

  return (
    <HeroScreen
      nav="back"
      eyebrow={`${group.icon ? `${group.icon} ` : ''}${group.name}`}
      title="Saved splits"
      subtitle="Ways this group usually divides costs. Pick one when you add an expense.">
      <Stack.Screen options={{ headerShown: false }} />
      <Gutter>
        {splits.length === 0 ? (
          <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl, borderRadius: radius.lg, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }}>
            <Text style={{ fontSize: 36 }}>🧮</Text>
            <Text muted style={{ textAlign: 'center', paddingHorizontal: space.lg }}>
              No saved splits yet. Save one here, or tap “Save this split for later” when you add an expense.
            </Text>
          </View>
        ) : null}

        {splits.map((sp) => {
          const gone = goneFromSplit(sp, group.pickableIds);
          const isDefault = group.defaultSplitId === sp.id;
          const canManage = !closed && (admin || sp.createdBy === myId);
          const changed = sp.updatedAt !== sp.createdAt;
          return (
            <Card key={sp.id} style={{ gap: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
                <Text variant="heading" style={{ flexShrink: 1 }}>
                  {sp.name}
                </Text>
                {isDefault ? (
                  <View style={{ backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 }}>
                    <Text variant="caption" color={c.onPrimary} style={{ fontWeight: '700' }}>
                      Default
                    </Text>
                  </View>
                ) : null}
                <Text variant="caption" muted>
                  {SAVED_METHOD_LABEL[sp.method]}
                </Text>
              </View>
              <Text>{describeSplit(sp, (id) => (id === myId ? 'You' : name(id)))}</Text>
              {gone.length ? (
                <Notice>
                  {`Needs updating: ${gone.map(name).join(' and ')} ${gone.length === 1 ? 'is' : 'are'} no longer in the group, so this split can’t be used until it’s updated.`}
                </Notice>
              ) : sp.shares.length < group.pickableIds.length ? (
                <Text variant="caption" muted>
                  {sp.shares.length} of the {group.pickableIds.length} people in the group
                </Text>
              ) : null}
              <Text variant="caption" muted>
                Made by {who(sp.createdBy)}
                {changed ? ` · changed by ${who(sp.updatedBy)} on ${shortDate(sp.updatedAt)}` : ` on ${shortDate(sp.createdAt)}`}
              </Text>
              {canManage || (admin && !closed) ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: space.xs }}>
                  {canManage ? (
                    <Action
                      label={gone.length ? 'Update' : 'Edit'}
                      onPress={() => router.push({ pathname: '/saved-split', params: { groupId: group.id, id: sp.id } })}
                    />
                  ) : null}
                  {admin && !closed ? (
                    <Action
                      label={isDefault ? 'Remove default' : 'Make default'}
                      onPress={() =>
                        setDefault.mutate({ groupId: group.id, splitId: isDefault ? null : sp.id }, { onError: fail('Couldn’t change the default') })
                      }
                    />
                  ) : null}
                  {canManage ? <Action label="Delete" danger onPress={() => confirmDelete(sp)} /> : null}
                </View>
              ) : null}
            </Card>
          );
        })}

        {group.defaultSplitId ? (
          <Text variant="caption" muted>
            New expenses in {group.name} start with the default. You can still change the split for any one expense.
          </Text>
        ) : null}

        {closed ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/saved-split', params: { groupId: group.id } })}
            style={{ alignItems: 'center', padding: space.md, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.border }}>
            <Text variant="label" color={c.primary}>
              ＋ New saved split
            </Text>
          </Pressable>
        )}
      </Gutter>
    </HeroScreen>
  );
}
