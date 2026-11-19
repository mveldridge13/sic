import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Logo } from '@/components/brand';
import { GroupListCard, PositionFigure, Gutter, HeroScreen, CardText, QuickAction, StatRow, TotalPill } from '@/components/dashboard';
import { Sheet } from '@/components/friendly';
import { Bouncy, buzz } from '@/components/fun';
import { Button, Card, Field, Notice, Text } from '@/components/ui';
import { inviteCodeFrom } from '@/lib/invite';
import { useTallyData } from '@/lib/data';
import { useWidthClass } from '@/lib/layout';
import { useGroupSummaries } from '@/store/hooks';
import { brand, radius, space, useColors } from '@/theme';
import { usePullToRefresh } from '@/lib/pull-to-refresh';

type Filter = 'all' | 'owed' | 'owe' | 'settled';
const FILTER_WORDS: Record<Exclude<Filter, 'all'>, string> = {
  owed: 'groups that owe you',
  owe: 'groups you owe',
  settled: 'settled groups',
};

/** A bar at the bottom of the list ("Put away 4 ⌄") that opens to show its groups. Starts closed. */
function ClosedSection({ emoji, title, count, children }: { emoji: string; title: string; count: number; children: ReactNode }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Bouncy
        scaleTo={0.98}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${count} ${count === 1 ? 'group' : 'groups'}. ${open ? 'Collapse' : 'Expand'}`}
        onPress={() => {
          buzz.tap();
          setOpen((o) => !o);
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          padding: space.lg,
          marginTop: space.sm,
          borderRadius: radius.xl - 6,
          backgroundColor: c.surfaceAlt,
        }}>
        <Text style={{ fontSize: 22 }}>{emoji}</Text>
        <Text variant="heading" style={{ flex: 1, fontSize: 19, fontWeight: '700' }}>
          {title}
        </Text>
        <View style={{ backgroundColor: brand.deep, borderRadius: radius.pill, paddingHorizontal: space.sm + 2, paddingVertical: 2 }}>
          <Text variant="label" color={brand.onDeep} style={{ fontWeight: '700' }}>
            {count}
          </Text>
        </View>
        <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={26} color={c.textMuted} />
      </Bouncy>
      {open ? <Animated.View entering={FadeInDown.duration(220)}>{children}</Animated.View> : null}
    </>
  );
}

export default function GroupsScreen() {
  const { data, refetch, error } = useTallyData();
  const pull = usePullToRefresh(refetch);
  const summaries = useGroupSummaries();
  const [filter, setFilter] = useState<Filter>('all');
  // Tap a figure on the card to show only those groups; tap it again to show them all.
  const toggle = (f: Exclude<Filter, 'all'>) => setFilter((cur) => (cur === f ? 'all' : f));
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const closeJoin = () => {
    setJoining(false);
    setCode('');
  };
  const join = () => {
    const token = inviteCodeFrom(code);
    if (!token) return;
    closeJoin();
    router.push(`/invite/${token}`);
  };
  // Unfolded (expanded width): one full-width page; group cards two per row.
  // Two cards a row only on the Fold's unfolded screen; in a browser the page is a centred column.
  const wide = useWidthClass() === 'expanded' && Platform.OS !== 'web';

  // Most recent expense or payment per group, for "2h ago" and sorting.
  const lastActivity = useMemo(() => {
    const latest = new Map<string, string>();
    for (const item of [
      ...data.expenses.map((e) => ({ g: e.groupId, at: e.occurredAt })),
      ...data.settlements.map((s) => ({ g: s.groupId, at: s.occurredAt })),
    ]) {
      const prev = latest.get(item.g);
      if (!prev || item.at > prev) latest.set(item.g, item.at);
    }
    return latest;
  }, [data]);

  // How many expenses each group has (that you can see).
  const expenseCounts = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of data.expenses) n.set(e.groupId, (n.get(e.groupId) ?? 0) + 1);
    return n;
  }, [data.expenses]);

  const counts = useMemo(
    () => ({
      all: summaries.length,
      owed: summaries.filter((s) => s.myBalance > 0).length,
      owe: summaries.filter((s) => s.myBalance < 0).length,
      settled: summaries.filter((s) => s.myBalance === 0).length,
    }),
    [summaries],
  );

  const visible = useMemo(
    () =>
      summaries
        .filter((s) =>
          filter === 'all' ? true : filter === 'owed' ? s.myBalance > 0 : filter === 'owe' ? s.myBalance < 0 : s.myBalance === 0,
        )
        // Most recently active first; groups with no activity keep creation order at the end.
        .sort((a, b) => (lastActivity.get(b.group.id) ?? '').localeCompare(lastActivity.get(a.group.id) ?? '')),
    [summaries, filter, lastActivity],
  );

  // With no filter, two closed sections at the bottom: groups the owner or a co-owner closed for
  // everyone, and groups you've hidden from your own list (they come back by themselves when
  // someone adds an expense). Being square doesn't move a group: it stays until it's closed.
  const sectioned = filter === 'all';
  const closed = sectioned ? visible.filter((s) => s.group.closedAt) : [];
  const putAway = sectioned ? visible.filter((s) => !s.group.closedAt && s.group.hiddenByMe) : [];
  const active = sectioned ? visible.filter((s) => !s.group.closedAt && !s.group.hiddenByMe) : visible;
  const grid = (list: typeof visible) => (
    <View style={{ flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap', gap: space.md }}>
      {list.map((s) => (
        <View key={s.group.id} style={{ width: wide ? '48.8%' : '100%' }}>
          <GroupListCard summary={s} lastActivity={lastActivity.get(s.group.id)} expenseCount={expenseCounts.get(s.group.id) ?? 0} />
        </View>
      ))}
    </View>
  );

  const card =
    summaries.length > 0 ? (
      <>
        <PositionFigure summaries={summaries} />
        <StatRow>
          <TotalPill label="Owe you" value={String(counts.owed)} tone="owed" selected={filter === 'owed'} onPress={() => toggle('owed')} />
          <TotalPill label="You owe" value={String(counts.owe)} tone="owe" selected={filter === 'owe'} onPress={() => toggle('owe')} />
          <TotalPill
            label="Settled"
            value={String(counts.settled)}
            tone="neutral"
            selected={filter === 'settled'}
            onPress={() => toggle('settled')}
          />
        </StatRow>
        <CardText variant="caption" muted style={{ marginTop: space.sm }}>
          {filter === 'all' ? 'Tap a figure to filter your groups' : `Showing ${FILTER_WORDS[filter]} · tap again for all`}
        </CardText>
      </>
    ) : (
      <View style={{ gap: space.sm }}>
        <Logo width={80} />
        <CardText muted>A group is the people you share costs with: a trip, your flat, a dinner club.</CardText>
      </View>
    );

  // The list (filtered by tapping a figure on the card).
  const body = (
    <>
      {error ? (
        <Gutter>
          <Notice>Couldn’t refresh. Pull down to try again.</Notice>
        </Gutter>
      ) : null}

      {summaries.length > 0 ? (
        <View style={{ gap: space.md }}>
          <Gutter>
            {visible.length === 0 ? (
              <Card>
                <Text muted>No groups here.</Text>
              </Card>
            ) : active.length > 0 ? (
              grid(active)
            ) : null}

            {closed.length > 0 ? (
              <ClosedSection emoji="🔒" title="Closed" count={closed.length}>
                {grid(closed)}
              </ClosedSection>
            ) : null}
            {putAway.length > 0 ? (
              <ClosedSection emoji="📦" title="Put away" count={putAway.length}>
                {grid(putAway)}
              </ClosedSection>
            ) : null}
          </Gutter>
        </View>
      ) : null}
    </>
  );

  return (
    <View style={{ flex: 1 }}>
      <HeroScreen
        nav="tab"
        title="Your groups"
        subtitle={summaries.length ? `${summaries.length} ${summaries.length === 1 ? 'group' : 'groups'}` : 'No groups yet'}
        hideActionsTitle
        actions={
          <>
            <QuickAction bold icon="group-add" label="New group" onPress={() => router.push('/new-group')} />
            <QuickAction bold icon="link" label="Join group" onPress={() => setJoining(true)} />
          </>
        }
        card={card}
        cardTone="light"
        fullWidth={wide}
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}>
        {body}
      </HeroScreen>

      {/* Join with a code or link someone shared, for when tapping the link didn't open sic. */}
      <Sheet
        visible={joining}
        onClose={closeJoin}
        title="Join a group"
        footer={<Button label="Join group" onPress={join} disabled={!inviteCodeFrom(code)} />}>
        <Field
          label="Invite code or link"
          value={code}
          onChangeText={setCode}
          placeholder="Paste it here"
          autoCapitalize="none"
          autoCorrect={false}
          // Keyboard opens with the sheet, so the panel and keyboard rise together in one movement.
          autoFocus
          returnKeyType="go"
          onSubmitEditing={join}
        />
      </Sheet>
    </View>
  );
}
