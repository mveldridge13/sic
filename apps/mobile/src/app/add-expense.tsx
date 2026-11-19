import {
  centsToDecimalString,
  computeSplit,
  convertMinor,
  convertSplit,
  currencyDecimals,
  FULL_PERCENT_BPS,
  formatMoney,
  inferConvertedItemsRest,
  inferItemsRest,
  itemsSubtotal,
  type ItemsRest,
  moneyToDecimalString,
  parseMoney,
  parseToCents,
  rateFromAmounts,
  SplitError,
  type SplitInput,
  type SplitMethod,
} from '@tally/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, TextInput, View, type TextInputInstance } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { Gutter, HeroScreen, onDeepMuted } from '@/components/dashboard';
import { GroupIcon, Sheet } from '@/components/friendly';
import { buzz } from '@/components/fun';
import { Avatar, Button, Card, Chip, Divider, Notice, Text } from '@/components/ui';
import { useMyId } from '@/lib/auth';
import {
  completeRecurringDue,
  useCreateExpense,
  useExchangeRate,
  useCreateRecurring,
  goneFromSplit,
  useNameOf,
  useRecurring,
  useRecurringDue,
  useSaveSplit,
  useSetReceiptScanConsent,
  useTallyData,
  useUpdateExpense,
  useUpdateRecurring,
  type Expense,
  type ExpenseOriginal,
  type RecurringDue,
  type RecurringExpense,
  type SavedSplit,
} from '@/lib/data';
import { isOnline, useOnline } from '@/lib/offline';
import { formFromSaved, savedFromForm } from '@/lib/saved-splits';
import { canPayIn, PAY_CURRENCIES } from '@/lib/currencies';
import { CATEGORIES, categoryById, guessCategory, type CategoryId } from '@/lib/categories';
import { CategoryGrid } from '@/components/category-grid';
import { defaultRecurring, RecurringLine, RecurringPanel, recurringSummary, todayDate, type RecurringForm } from '@/components/recurring';
import { attachReceipt, canScanReceipts, discardReceipt, pickReceiptPhoto, scanReceipt, uploadReceipt } from '@/lib/receipts';
import { useAfterTransition } from '@/lib/transitions';
import { brand, groupColor, radius, space, type, useColors } from '@/theme';

/**
 * The ways to split offered on the form. Adjustments are covered by Items (one extra plus
 * everything else split equally); expenses saved that way still show, and open as items when edited.
 */
type FormMethod = 'equal' | 'exact' | 'percentage' | 'shares' | 'items';
const METHODS: { id: FormMethod; label: string; hint: string }[] = [
  { id: 'equal', label: 'Equally', hint: 'Everyone ticked pays the same.' },
  {
    id: 'exact',
    label: 'Amounts',
    hint: 'Enter what each person pays. They must add up to the total.',
  },
  {
    id: 'percentage',
    label: 'Percent',
    hint: 'Enter each person’s percentage. They must add up to 100%.',
  },
  {
    id: 'shares',
    label: 'Shares',
    hint: 'Someone with 2 shares pays twice as much as someone with 1.',
  },
  {
    id: 'items',
    label: 'Items',
    hint: 'Add what was someone’s own, like a meal or a drink, and tap who had it. Everything else is split equally or in proportion.',
  },
];

/** An item as typed on the form: the price stays text until it's parsed. */
interface ItemRow {
  key: number;
  name: string;
  price: string;
  userIds: string[];
}

let nextItemKey = 1;
const newItem = (): ItemRow => ({ key: nextItemKey++, name: '', price: '', userIds: [] });

type Preview = { ok: true; shares: { userId: string; amount: number }[] } | { ok: false; error: string };

function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ??
      currency
    );
  } catch {
    return currency;
  }
}

/** Form state derived from a saved expense, so editing shows exactly what was entered. */
/** Form state from a saved split (a recurring expense or a bill that's due): who's in it and how. */
function initialFromSplit(split: SplitInput, memberIds: string[]) {
  const included: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const inIt = (id: string) => memberIds.includes(id);
  if (split.method === 'equal') for (const id of memberIds) included[id] = split.participants.includes(id);
  if (split.method === 'percentage')
    for (const id of memberIds) {
      const sh = split.shares.find((x) => x.userId === id);
      included[id] = !!sh;
      if (sh) values[id] = centsToDecimalString(sh.basisPoints).replace(/\.00$/, '');
    }
  if (split.method === 'exact')
    for (const id of memberIds) {
      const sh = split.shares.find((x) => x.userId === id);
      included[id] = !!sh;
      if (sh) values[id] = centsToDecimalString(sh.amount);
    }
  if (split.method === 'shares')
    for (const id of memberIds) {
      const sh = split.shares.find((x) => x.userId === id);
      included[id] = !!sh;
      if (sh) values[id] = String(sh.units);
    }
  if (split.method === 'items') {
    for (const id of memberIds) included[id] = (split.participants ?? []).includes(id);
    return {
      method: 'items' as FormMethod,
      included,
      values,
      items: split.items.map((i) => ({ key: nextItemKey++, name: i.name, price: centsToDecimalString(i.amount), userIds: i.userIds.filter(inIt) })),
      rest: (split.rest ?? 'proportional') as ItemsRest,
    };
  }
  const method: FormMethod =
    split.method === 'percentage' || split.method === 'shares' || split.method === 'exact' ? split.method : 'equal';
  return { method, included, values, items: [newItem()], rest: 'equal' as ItemsRest };
}

function initialFromExpense(expense: Expense | undefined, memberIds: string[], name: (id: string) => string) {
  const blank = { method: 'equal' as FormMethod, included: {}, values: {}, items: [newItem()], rest: 'equal' as ItemsRest };
  if (!expense) return blank;
  // Paid in another currency: item prices and Amounts were typed (and are shown) in that currency.
  const paid = expense.original;
  const money = (minor: number) => (paid ? moneyToDecimalString(minor, paid.currency) : centsToDecimalString(minor));
  const inSplit = new Map(expense.splits.map((s) => [s.userId, s]));
  const included: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  for (const id of memberIds) {
    const s = inSplit.get(id);
    included[id] = !!s;
    if (!s) continue;
    if (expense.method === 'percentage' && s.weight != null) values[id] = centsToDecimalString(s.weight).replace(/\.00$/, '');
    if (expense.method === 'shares' && s.weight != null) values[id] = String(s.weight);
    if (expense.method === 'exact') values[id] = paid && s.weight != null ? money(s.weight) : centsToDecimalString(s.amount);
  }
  const toRow = (rowName: string, amount: number, userIds: string[]): ItemRow => ({
    key: nextItemKey++,
    name: rowName,
    price: money(amount),
    userIds,
  });
  switch (expense.method) {
    case 'items': {
      const items = expense.items ?? [];
      const { rest, participants } = paid
        ? inferConvertedItemsRest(expense.amount, paid.amount, items, expense.splits)
        : inferItemsRest(expense.amount, items, expense.splits);
      // Ticked = shares everything else.
      for (const id of memberIds) included[id] = participants.includes(id);
      return {
        method: 'items' as FormMethod,
        included,
        values,
        items: items.length ? items.map((i) => toRow(i.name, i.amount, i.userIds)) : [newItem()],
        rest,
      };
    }
    // Saved with adjustments: each extra is a line, the rest split equally between everyone.
    case 'adjustment': {
      const extras = expense.splits.filter((s) => (s.weight ?? 0) > 0);
      return {
        method: 'items' as FormMethod,
        included,
        values,
        items: extras.length ? extras.map((s) => toRow(`Extra for ${name(s.userId)}`, s.weight!, [s.userId])) : [newItem()],
        rest: 'equal' as ItemsRest,
      };
    }
    default:
      return { ...blank, method: expense.method as FormMethod, included, values };
  }
}

/** A rate for showing: "0.00931", "107.31", "0.6137". */
const showRate = (rate: number) => String(Number(rate.toPrecision(rate < 1 ? 4 : 6)));

// ─── Small themed controls ───────────────────────────────────────────────────

/** Avatar + name pill used to pick the payer. */
function PersonPill({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingLeft: space.xs,
        paddingRight: space.md,
        paddingVertical: space.xs,
        borderRadius: radius.pill,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? c.focus : c.border,
        backgroundColor: selected ? c.surfaceAlt : c.surface,
      }}>
      <Avatar name={label} size={30} color={selected ? c.focus : undefined} />
      <Text variant="label">{label}</Text>
    </Pressable>
  );
}

/** Segmented control for the split method. */
function Segmented({ value, onChange }: { value: FormMethod; onChange: (m: FormMethod) => void }) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: c.surfaceAlt,
        borderRadius: radius.md,
        padding: 4,
        gap: 4,
      }}>
      {METHODS.map((m) => {
        const selected = m.id === value;
        return (
          <Pressable
            key={m.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(m.id)}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: space.sm + 2,
              borderRadius: radius.sm + 2,
              backgroundColor: selected ? c.surface : 'transparent',
              elevation: selected ? 1 : 0,
            }}>
            <Text variant="label" color={selected ? c.text : c.textMuted} numberOfLines={1} adjustsFontSizeToFit>
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Round tick for including someone in the split. */
function Tick({ on, onPress, label }: { on: boolean; onPress: () => void; label: string }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`Include ${label}`}
      onPress={onPress}
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
      {on ? (
        <Text
          style={{
            color: brand.onDeep,
            fontSize: 14,
            fontWeight: '800',
            lineHeight: 16,
          }}>
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

/**
 * New expense, edit an expense, enter the amount for a recurring bill that's due (`dueId`), or edit
 * a recurring expense (`recurringId`). The last two need their saved split loaded before the form starts.
 */
export default function ExpenseFormScreen() {
  const params = useLocalSearchParams<{ groupId?: string; recurringId?: string; dueId?: string }>();
  const due = useRecurringDue();
  const schedules = useRecurring(params.groupId ?? '');
  const dueBill = params.dueId ? due.data.find((d) => d.id === params.dueId) : undefined;
  const schedule = params.recurringId ? schedules.data.find((r) => r.id === params.recurringId) : undefined;
  if ((params.dueId && !dueBill) || (params.recurringId && !schedule)) {
    const loading = params.dueId ? due.isLoading : schedules.isLoading;
    return (
      <HeroScreen nav="close" title={params.recurringId ? 'Edit recurring' : 'New expense'}>
        <Stack.Screen options={{ headerShown: false }} />
        <Gutter>
          <Notice tone="info">{loading ? 'Loading…' : params.dueId ? 'This bill has already been entered.' : 'This recurring expense has stopped.'}</Notice>
        </Gutter>
      </HeroScreen>
    );
  }
  return <ExpenseForm schedule={schedule} dueBill={dueBill} />;
}

function ExpenseForm({ schedule, dueBill }: { schedule?: RecurringExpense; dueBill?: RecurringDue }) {
  const c = useColors();
  const params = useLocalSearchParams<{
    groupId?: string;
    expenseId?: string;
    /** Set by New group when it was opened from this form: switch to the group just made. */
    newGroupId?: string;
    /** From "New recurring expense": start with Recurring switched on. */
    recurring?: string;
  }>();
  const fromSaved = schedule ?? dueBill;
  const myId = useMyId();
  const { data } = useTallyData();
  const name = useNameOf();

  const editing = data.expenses.find((e) => e.id === params.expenseId);
  const isEdit = !!params.expenseId;
  // Closed groups take no new expenses.
  const groups = useMemo(() => data.groups.filter((g) => !g.closedAt), [data.groups]);

  const createExpense = useCreateExpense();
  const updateExpense = useUpdateExpense();
  const mutation = isEdit ? updateExpense : createExpense;

  const [groupId, setGroupId] = useState(editing?.groupId ?? fromSaved?.groupId ?? params.groupId ?? groups[0]?.id ?? '');
  const group = groups.find((g) => g.id === groupId);
  // When editing, also list anyone in the original split who has since left the group.
  const members = useMemo(() => {
    const ids = [...(group?.memberIds ?? [])];
    for (const s of editing?.splits ?? []) if (!ids.includes(s.userId)) ids.push(s.userId);
    return ids;
  }, [group, editing]);

  // Only worked out once: a later name change shouldn't rewrite lines being edited.
  const initial = useMemo(
    () => (fromSaved ? initialFromSplit(fromSaved.split, members) : initialFromExpense(editing, members, name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, members, fromSaved],
  );
  const [description, setDescription] = useState(editing?.description ?? fromSaved?.description ?? '');
  const [amountText, setAmountText] = useState(
    editing?.original
      ? moneyToDecimalString(editing.original.amount, editing.original.currency)
      : editing
        ? centsToDecimalString(editing.amount)
        : schedule?.amount
          ? centsToDecimalString(schedule.amount)
          : '',
  );
  // The currency it was paid in: null = the group's own. Another currency is converted into the
  // group's at a rate that's locked when the expense is saved.
  const [paidIn, setPaidIn] = useState<string | null>(editing?.original?.currency ?? null);
  // The category someone picked (or a scanned receipt suggested); otherwise it's guessed from the
  // description as it's typed. An old expense without one shows the guess, saved if it's edited.
  const [pickedCategory, setPickedCategory] = useState<CategoryId | null>(editing?.category ?? schedule?.category ?? null);
  // An expense being edited keeps its rate unless the currency changes or someone types a new one.
  const [lockedRate, setLockedRate] = useState<Pick<ExpenseOriginal, 'rate' | 'rateDate' | 'source'> | null>(
    editing?.original && editing.original.source === 'ecb' ? editing.original : null,
  );
  // auto: today's rate (or the locked one) · manual: a typed rate · bank: what the bank charged.
  const [rateMode, setRateMode] = useState<'auto' | 'manual' | 'bank'>(
    editing?.original?.source === 'manual' ? 'manual' : editing?.original?.source === 'bank' ? 'bank' : 'auto',
  );
  const [rateText, setRateText] = useState(editing?.original?.source === 'manual' ? showRate(editing.original.rate) : '');
  const [bankText, setBankText] = useState(editing?.original?.source === 'bank' ? centsToDecimalString(editing.amount) : '');
  function payIn(code: string | null) {
    setPaidIn(code);
    setLockedRate(null);
    setRateMode('auto');
    setRateText('');
    setBankText('');
  }
  const [payerId, setPayerId] = useState(editing?.payerId ?? fromSaved?.payerId ?? myId);
  // Recurring: off for a one-off expense; a schedule being edited starts from its own settings.
  const [recurring, setRecurring] = useState<RecurringForm>(() =>
    schedule
      ? {
          on: true,
          frequency: schedule.frequency,
          start: schedule.nextDate,
          ends: schedule.endDate ? 'date' : schedule.remaining !== null ? 'times' : 'never',
          endDate: schedule.endDate,
          times: schedule.remaining ?? 12,
          variable: schedule.variable,
          headsUpDays: schedule.headsUpDays,
        }
      : { ...defaultRecurring(), on: params.recurring === '1' },
  );
  const createRecurring = useCreateRecurring();
  const updateRecurring = useUpdateRecurring();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [method, setMethod] = useState<FormMethod>(initial.method);
  const [included, setIncluded] = useState<Record<string, boolean>>(initial.included);
  const [values, setValues] = useState<Record<string, string>>(initial.values);
  const [items, setItems] = useState<ItemRow[]>(initial.items);
  // The saved split last picked (or the group default). Changing anything in the split clears it,
  // and only this expense changes: the saved split itself stays as it was.
  const [appliedSplitId, setAppliedSplitId] = useState<string | null>(null);
  function applySaved(split: SavedSplit) {
    const f = formFromSaved(split, members);
    setMethod(f.method);
    setIncluded(f.included);
    setValues(f.values);
    setAppliedSplitId(split.id);
  }
  const [rest, setRest] = useState<ItemsRest>(initial.rest);
  const [receiptPath, setReceiptPath] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  // A photo that's replaced, dropped, or left behind when the form closes is deleted, unless it was saved.
  const keptReceipt = useRef<string | null>(null);
  useEffect(() => {
    if (!receiptPath) return;
    return () => {
      if (keptReceipt.current !== receiptPath) discardReceipt(receiptPath);
    };
  }, [receiptPath]);
  const updateItem = (key: number, change: Partial<ItemRow>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));
  function pickGroup(id: string) {
    // A scanned photo is stored under its group, so it can't move to another one.
    setReceiptPath(null);
    setScanNote(null);
    setGroupId(id);
    payIn(null);
    setPayerId(myId);
    setIncluded({});
    setValues({});
    setItems([newItem()]);
  }
  // Back from New group with a fresh group: use it (keeps the amount and description already typed).
  // A new expense starts with the group's default saved split, if it has one that can be used.
  // Worked out again when the group changes (pickGroup clears the split first).
  const groupSplits = data.savedSplits.filter((sp) => sp.groupId === groupId);
  const [defaultCheckedFor, setDefaultCheckedFor] = useState<string | null>(null);
  if (!isEdit && !fromSaved && group && defaultCheckedFor !== group.id) {
    setDefaultCheckedFor(group.id);
    const fallback = groupSplits.find((sp) => sp.id === group.defaultSplitId);
    if (fallback && goneFromSplit(fallback, group.memberIds).length === 0 && method !== 'items') applySaved(fallback);
    else setAppliedSplitId(null);
  }
  const saveSplit = useSaveSplit();
  const [naming, setNaming] = useState(false);
  const [splitName, setSplitName] = useState('');
  const [seenNewGroup, setSeenNewGroup] = useState(params.newGroupId);
  if (params.newGroupId && params.newGroupId !== seenNewGroup) {
    setSeenNewGroup(params.newGroupId);
    pickGroup(params.newGroupId);
  }
  const [sheet, setSheet] = useState<'split' | 'group' | 'recurring' | 'scan' | 'consent' | 'currency' | 'rate' | 'category' | null>(
    null,
  );
  // Close the keyboard (and wait until it's gone) before a sheet slides up. Otherwise the keyboard
  // closing tugs the sheet back down mid-slide, which shows as a flicker.
  const openSheet = async (name: 'split' | 'group' | 'recurring' | 'scan' | 'consent' | 'currency' | 'rate' | 'category') => {
    if (KeyboardController.isVisible()) await KeyboardController.dismiss();
    setSheet(name);
  };

  // Receipt scanning: the photo is uploaded, read, and fills in the form as an items split. It's
  // put on the expense when it's saved, and deleted again if the form is closed without saving.
  async function scan(from: 'camera' | 'library') {
    if (!group) return;
    setSheet(null);
    setScanError(null);
    setScanNote(null);
    try {
      const photo = await pickReceiptPhoto(from);
      if (!photo) return;
      setScanning(true);
      const path = await uploadReceipt(photo, group.id);
      setReceiptPath(path);
      const read = await scanReceipt(path);
      if (read.merchant && !description.trim()) setDescription(read.merchant);
      if (read.category && !pickedCategory) setPickedCategory(read.category);
      // A receipt in another currency we have rates for is entered in that currency and converted.
      const convert = !!read.currency && read.currency !== group.currency && canPayIn(read.currency);
      const receiptCurrency = convert ? read.currency! : group.currency;
      if (convert) payIn(read.currency);
      if (read.total) setAmountText(moneyToDecimalString(read.total, receiptCurrency));
      if (read.items.length > 0) {
        setMethod('items');
        setItems(
          read.items.map((i) => ({ key: nextItemKey++, name: i.name, price: moneyToDecimalString(i.amount, receiptCurrency), userIds: [] })),
        );
        // Tax, tip and service charge are shared in proportion to what each person had.
        setRest('proportional');
      }
      const notes = [
        convert
          ? `This receipt is in ${read.currency}, so it’s converted into ${group.currency} at today’s rate. Tap the rate to change it.`
          : read.currency && read.currency !== group.currency
            ? `This receipt looks like it’s in ${read.currency}, which sic can’t convert yet. Amounts haven’t been converted.`
            : null,
        !read.total ? 'Couldn’t find the total. Please enter it.' : null,
        read.items.length > 0 ? 'Check the items, then tap who had each one.' : 'Couldn’t read the items. Choose how to split it below.',
      ].filter(Boolean);
      setScanNote(notes.join(' '));
      buzz.success();
      if (read.items.length > 0) void openSheet('split');
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Couldn’t read this photo. Please try again.');
    } finally {
      setScanning(false);
    }
  }
  // Asked once: photos only go to Anthropic after Accept; after Decline the button is gone.
  const setConsent = useSetReceiptScanConsent();
  const consent = data.me?.receiptScanConsent ?? null;
  const canScan = canScanReceipts && consent !== false && !isEdit && !schedule && !recurring.on && !!group;
  function answerConsent(accepted: boolean) {
    setConsent.mutate(accepted, {
      onSuccess: () => {
        if (accepted) setSheet('scan');
        else {
          setSheet(null);
          setScanNote('Receipt scanning is off, so no photos will be sent. You can turn it on any time in Profile.');
        }
      },
    });
  }

  // Open the keypad once the form has slid up, not during the animation.
  const amountRef = useRef<TextInputInstance>(null);
  const descriptionRef = useRef<TextInputInstance>(null);
  // Save stays tappable when only the description is missing: tapping it shakes the box and jumps in.
  const [triedSave, setTriedSave] = useState(false);
  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.get() }] }));
  useAfterTransition(() => amountRef.current?.focus(), !isEdit);

  const isIncluded = (id: string) => included[id] ?? true;
  const participantIds = members.filter(isIncluded);
  const participantKey = participantIds.join(',');

  // What was paid, in that currency's smallest unit.
  const cur = paidIn && group && paidIn !== group.currency ? paidIn : (group?.currency ?? 'USD');
  const foreign = !!group && cur !== group.currency;
  const paidAmount = useMemo(() => {
    try {
      return amountText ? parseMoney(amountText, cur) : 0;
    } catch {
      return NaN;
    }
  }, [amountText, cur]);
  const fx = useExchangeRate(foreign ? cur : undefined, group?.currency);
  const online = useOnline();
  // The rate to use, or why there isn't one yet, and the amount in the group's currency: what
  // everyone's shares and balances use.
  const { rateInfo, rateProblem, amount } = useMemo((): {
    rateInfo: Pick<ExpenseOriginal, 'rate' | 'rateDate' | 'source'> | null;
    rateProblem: string | null;
    amount: number;
  } => {
    if (!foreign || !group) return { rateInfo: null, rateProblem: null, amount: paidAmount };
    const none = (problem: string) => ({ rateInfo: null, rateProblem: problem, amount: NaN });
    const at = (info: Pick<ExpenseOriginal, 'rate' | 'rateDate' | 'source'>) => ({
      rateInfo: info,
      rateProblem: null,
      amount: Number.isFinite(paidAmount) ? convertMinor(paidAmount, cur, group.currency, info.rate) : NaN,
    });
    if (rateMode === 'manual') {
      const typed = Number(rateText.trim().replace(',', '.'));
      return Number.isFinite(typed) && typed > 0 ? at({ rate: typed, rateDate: null, source: 'manual' }) : none('Type the exchange rate, or use today’s rate.');
    }
    if (rateMode === 'bank') {
      try {
        const bank = parseToCents(bankText);
        if (!(bank > 0 && paidAmount > 0)) return none(`Type what your bank charged in ${group.currency}.`);
        // The bank's amount is used exactly; the rate is worked out from it.
        return { rateInfo: { rate: rateFromAmounts(paidAmount, cur, bank, group.currency), rateDate: null, source: 'bank' }, rateProblem: null, amount: bank };
      } catch {
        return none(`Check what your bank charged in ${group.currency}.`);
      }
    }
    if (lockedRate) return at(lockedRate);
    if (fx.data) return at({ rate: fx.data.rate, rateDate: fx.data.date, source: 'ecb' });
    if (!online) return none('You’re offline, so there’s no rate to fetch. Tap the rate to type it, or what your bank charged.');
    return none(fx.isError ? 'Couldn’t get today’s exchange rate. Tap the rate to type it.' : 'Getting today’s exchange rate…');
  }, [foreign, group, paidAmount, cur, rateMode, rateText, bankText, lockedRate, fx.data, fx.isError, online]);
  // Amounts and item prices are typed in what was paid; the split is worked out on that.
  const splitTotal = foreign ? paidAmount : amount;

  const splitInput = useMemo((): SplitInput | string => {
    try {
      switch (method) {
        case 'equal':
          return { method, participants: participantIds };
        case 'exact':
          return {
            method,
            shares: participantIds.map((userId) => ({ userId, amount: parseMoney(values[userId] || '0', cur) })),
          };
        case 'percentage':
          // "33.33" -> 3333 basis points, using the same exact decimal parser as money.
          return {
            method,
            shares: participantIds.map((userId) => ({
              userId,
              basisPoints: parseToCents(values[userId] || '0'),
            })),
          };
        case 'shares':
          return {
            method,
            shares: participantIds.map((userId) => ({
              userId,
              units: Number.parseInt(values[userId] || '1', 10),
            })),
          };
        case 'items':
          // Unnamed items get a plain name, so a quick "price + who" entry still saves.
          return {
            method,
            items: items.map((item, i) => ({
              name: item.name.trim() || `Item ${i + 1}`,
              amount: parseMoney(item.price || '0', cur),
              userIds: members.filter((id) => item.userIds.includes(id)),
            })),
            rest,
            participants: rest === 'equal' ? participantIds : undefined,
          };
      }
    } catch {
      return 'Check the numbers you entered.';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantKey, method, values, items, members, rest, cur]);

  const preview: Preview = useMemo(() => {
    if (!Number.isFinite(amount)) return { ok: false, error: 'Enter a valid amount, like 12.50.' };
    if (amount <= 0) return { ok: false, error: 'Enter an amount.' };
    if (typeof splitInput === 'string') return { ok: false, error: splitInput };
    try {
      return { ok: true, shares: foreign ? convertSplit(amount, paidAmount, splitInput) : computeSplit(amount, splitInput) };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof SplitError ? e.message : 'This split doesn’t add up.',
      };
    }
  }, [amount, splitInput, foreign, paidAmount]);

  /** "20% left to assign" for percentage splits, "$5.00 left to assign" for amounts; items that come to more than the total. */
  const remaining = useMemo(() => {
    if (typeof splitInput === 'string' || !group) return null;
    if (splitInput.method === 'percentage') {
      const left = FULL_PERCENT_BPS - splitInput.shares.reduce((a, s) => a + s.basisPoints, 0);
      // Off by rounding only (33.33% × 3) counts as done, the same as the split engine.
      if (Math.abs(left) <= splitInput.shares.length - 1) return null;
      const pct = centsToDecimalString(Math.abs(left)).replace(/\.00$/, '');
      return left > 0 ? `${pct}% left to assign` : `${pct}% too much assigned`;
    }
    if (splitInput.method === 'exact' && Number.isFinite(splitTotal) && splitTotal > 0) {
      const left = splitTotal - splitInput.shares.reduce((a, s) => a + s.amount, 0);
      if (left === 0) return null;
      return left > 0 ? `${formatMoney(left, cur)} left to assign` : `${formatMoney(-left, cur)} too much assigned`;
    }
    if (splitInput.method === 'items' && Number.isFinite(splitTotal) && splitTotal > 0) {
      const over = itemsSubtotal(splitInput.items) - splitTotal;
      return over > 0 ? `Items come to ${formatMoney(over, cur)} more than the total` : null;
    }
    return null;
  }, [splitInput, splitTotal, group, cur]);

  /** For an items split: what the items come to, and what's left over for everything else. */
  const itemTotals =
    typeof splitInput !== 'string' && splitInput.method === 'items'
      ? { items: itemsSubtotal(splitInput.items), extra: Number.isFinite(splitTotal) ? splitTotal - itemsSubtotal(splitInput.items) : 0 }
      : null;

  const suggestedCategory = guessCategory(description);
  const category: CategoryId = pickedCategory ?? suggestedCategory;
  const categoryInfo = categoryById(category);

  const title = isEdit ? 'Edit expense' : schedule ? 'Edit recurring' : 'New expense';
  if (isEdit && !editing) {
    return (
      <HeroScreen nav="close" title={title}>
        <Stack.Screen options={{ headerShown: false }} />
        <Gutter>
          <Notice tone="info">This expense no longer exists.</Notice>
        </Gutter>
      </HeroScreen>
    );
  }

  // Why Save is disabled, in plain language.
  // A recurring expense whose amount changes needs no amount unless one is being added today.
  const needsAmount = !(recurring.on && recurring.variable && (!!schedule || recurring.start !== todayDate()));
  const blocker = !group
    ? 'Choose a group'
    : needsAmount && !amountText
      ? 'Enter an amount'
      : foreign && (recurring.on || schedule)
        ? `Recurring expenses use the group’s currency (${group.currency}) for now`
        : foreign && rateProblem
          ? rateProblem
          : typeof splitInput === 'string'
        ? splitInput
        : needsAmount && !preview.ok
          ? (remaining ?? preview.error)
          : !description.trim()
            ? 'Add what it was for'
            : null;
  const busy = saving || mutation.isPending || createRecurring.isPending || updateRecurring.isPending;
  const canSave = !blocker && !busy;

  function save() {
    if (!description.trim()) {
      setTriedSave(true);
      buzz.nudge();
      shake.set(
        withSequence(
          withTiming(-10, { duration: 50 }),
          withTiming(10, { duration: 70 }),
          withTiming(-6, { duration: 60 }),
          withTiming(0, { duration: 60 }),
        ),
      );
      descriptionRef.current?.focus();
      return;
    }
    if (!group || typeof splitInput === 'string' || (needsAmount && !preview.ok)) return;
    const input = {
      description: description.trim(),
      amount,
      payerId,
      split: splitInput,
      occurredAt: editing?.occurredAt ?? new Date().toISOString(),
      original: foreign && rateInfo ? { currency: cur, amount: paidAmount, ...rateInfo } : null,
      category,
    };
    if (editing) {
      updateExpense.mutate({ ...input, expenseId: editing.id }, { onSuccess: () => router.back() });
      return;
    }
    const recurringInput = {
      description: input.description,
      payerId,
      split: splitInput,
      variable: recurring.variable,
      amount: needsAmount ? amount : null,
      frequency: recurring.frequency,
      endDate: recurring.ends === 'date' ? recurring.endDate : null,
      remaining: recurring.ends === 'times' ? recurring.times : null,
      headsUpDays: recurring.headsUpDays,
      category,
    };
    // Repeating expenses are set up on the database, so they need a connection. One-off expenses don't.
    if (!isOnline() && (schedule || dueBill || recurring.on)) {
      setSaveError('You’re offline. Repeating expenses need a connection. Turn off Repeat to save this one now, or try again when you’re back online.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    void (async () => {
      try {
        if (schedule) {
          await updateRecurring.mutateAsync({
            ...recurringInput,
            id: schedule.id,
            nextDate: recurring.start !== schedule.nextDate ? recurring.start : undefined,
          });
        } else if (dueBill) {
          // The amount for a bill that came due: save it as a normal expense, then mark the bill done.
          const id = await createExpense.mutateAsync({ ...input, groupId: group.id });
          await completeRecurringDue(dueBill.id, id);
          await keepReceipt(id);
        } else if (recurring.on) {
          // Starting today: today's expense is saved now and counts as the first one.
          const startsToday = recurring.start === todayDate();
          const firstId = startsToday ? await createExpense.mutateAsync({ ...input, groupId: group.id }) : undefined;
          await createRecurring.mutateAsync({ ...recurringInput, groupId: group.id, startDate: recurring.start, firstExpenseId: firstId });
        } else {
          await keepReceipt(await createExpense.mutateAsync({ ...input, groupId: group.id }));
        }
        buzz.success();
        router.back();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Couldn’t save. Please try again.');
      } finally {
        setSaving(false);
      }
    })();
  }

  /** Put the scanned photo on the saved expense. The expense is saved either way. */
  async function keepReceipt(expenseId: string) {
    if (!receiptPath) return;
    try {
      await attachReceipt(expenseId, receiptPath);
      keptReceipt.current = receiptPath;
    } catch {
      // The photo is cleaned up with the form; the expense itself is fine.
    }
  }

  const payerLabel = payerId === myId ? 'you' : name(payerId);
  // Who shares everything else in an items split (only when there's something left over).
  const restEqual = method === 'items' && rest === 'equal' && !!itemTotals && itemTotals.extra > 0;
  const n =
    method === 'items'
      ? new Set([...items.flatMap((i) => i.userIds), ...(restEqual ? participantIds : [])]).size
      : participantIds.length;
  const methodWords: Record<SplitMethod, string> = {
    equal: 'equally',
    exact: 'by amounts',
    percentage: 'by percentage',
    shares: 'by shares',
    items: 'by item',
    adjustment: 'equally with adjustments',
  };
  const splitLine =
    method === 'equal' && preview.ok && group && n > 0
      ? `Split equally between ${n} · ${formatMoney(Math.floor(amount / n), group.currency)} each`
      : method === 'items'
        ? `Split by item · ${items.length} ${items.length === 1 ? 'item' : 'items'} between ${n} ${n === 1 ? 'person' : 'people'}`
        : `Split ${methodWords[method]} between ${n} ${n === 1 ? 'person' : 'people'}`;
  // Only flag split problems here; a missing amount or description is obvious on the form.
  const splitProblem = amountText && Number.isFinite(amount) && amount > 0 && !preview.ok ? (remaining ?? preview.error) : null;
  const canPickGroup = !isEdit && !params.groupId;
  // Once there's an amount, the description is the last thing standing between you and Save: flag it.
  const needsDescription = (!!amountText || triedSave) && !description.trim();
  const onlyDescriptionMissing = blocker === 'Add what it was for';

  const card = (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={canPickGroup ? `Group: ${group?.name ?? 'none'}. Change group` : `Group: ${group?.name ?? 'none'}`}
          disabled={!canPickGroup}
          onPress={() => void openSheet('group')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingVertical: 6,
            paddingLeft: 6,
            paddingRight: space.md,
            borderRadius: radius.pill,
            backgroundColor: 'rgba(255,255,255,0.1)',
          }}>
          {group ? <GroupIcon group={group} size={26} /> : null}
          <Text variant="label" color={brand.onDeep} numberOfLines={1} style={{ maxWidth: 180 }}>
            {group ? group.name : 'Choose a group'}
            {canPickGroup ? '  ▾' : ''}
          </Text>
        </Pressable>
        {/* Start a new group straight from here. */}
        {canPickGroup ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New group"
            onPress={() => router.push({ pathname: '/new-group', params: { forExpense: '1' } })}
            style={{
              paddingVertical: 6,
              paddingHorizontal: space.md,
              minHeight: 38,
              justifyContent: 'center',
              borderRadius: radius.pill,
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: 'rgba(255,255,255,0.4)',
            }}>
            <Text variant="label" color={brand.onDeep}>
              ＋ New group
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Big amount entry */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: space.xl }}>
        {/* Tap the currency to say it was paid in another one (not for recurring expenses yet). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Paid in ${cur}. Change currency`}
          disabled={!group || recurring.on || !!schedule}
          onPress={() => void openSheet('currency')}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', marginRight: space.xs }}>
          <Text style={{ fontSize: 40, fontWeight: '700', color: onDeepMuted }}>{group ? currencySymbol(cur) : ''}</Text>
          {group && !recurring.on && !schedule ? <Text style={{ fontSize: 16, color: onDeepMuted, marginLeft: 2 }}>▾</Text> : null}
        </Pressable>
        <TextInput
          value={amountText}
          onChangeText={setAmountText}
          placeholder={currencyDecimals(cur) === 0 ? '0' : '0.00'}
          placeholderTextColor="rgba(255,255,255,0.35)"
          ref={amountRef}
          keyboardType="decimal-pad"
          selectionColor={brand.accent}
          cursorColor={brand.accent}
          accessibilityLabel={`Amount${group ? ` in ${cur}` : ''}`}
          style={{
            fontSize: 56,
            fontWeight: '800',
            letterSpacing: -1,
            color: brand.onDeep,
            minWidth: 120,
            textAlign: 'center',
            padding: 0,
            fontVariant: ['tabular-nums'],
          }}
        />
      </View>

      {/* Paid in another currency: what it comes to in the group's, and at what rate. */}
      {foreign && group ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void openSheet('rate')}
          style={{ alignSelf: 'center', marginTop: space.sm, paddingVertical: 6, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.1)' }}>
          <Text variant="label" color={brand.onDeep} style={{ textAlign: 'center', fontVariant: ['tabular-nums'] }}>
            {rateInfo
              ? `${Number.isFinite(amount) && amount > 0 ? `= ${formatMoney(amount, group.currency)} · ` : ''}1 ${cur} = ${showRate(rateInfo.rate)} ${group.currency}`
              : rateProblem}
          </Text>
          <Text variant="caption" color={onDeepMuted} style={{ textAlign: 'center' }}>
            {rateInfo?.source === 'manual'
              ? 'Your rate · Change'
              : rateInfo?.source === 'bank'
                ? 'From what your bank charged · Change'
                : rateInfo
                  ? `European Central Bank rate${rateInfo.rateDate ? `, ${new Date(`${rateInfo.rateDate}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''} · Change`
                  : 'Tap to type the rate'}
          </Text>
        </Pressable>
      ) : null}

      {canScan ? (
        <View style={{ alignItems: 'center', marginTop: space.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={receiptPath ? 'Scan a different receipt' : 'Scan a receipt'}
            accessibilityState={{ busy: scanning }}
            disabled={scanning}
            onPress={() => void openSheet(consent === true ? 'scan' : 'consent')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              paddingVertical: 6,
              paddingHorizontal: space.md,
              minHeight: 38,
              borderRadius: radius.pill,
              backgroundColor: 'rgba(255,255,255,0.1)',
            }}>
            <Text variant="label" color={brand.onDeep}>
              {scanning ? 'Reading receipt…' : receiptPath ? '✓ Receipt added · Scan again' : '📷 Scan receipt'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Description (needed to save) */}
      <View style={{ marginTop: space.xl, gap: space.sm }}>
        <Text variant="label" color={needsDescription ? brand.coral : brand.onDeep} style={{ textAlign: 'center', fontWeight: '700' }}>
          What was it for?
        </Text>
        <Animated.View style={shakeStyle}>
          <TextInput
            ref={descriptionRef}
            value={description}
            onChangeText={setDescription}
            placeholder="e.g. Pizza, Uber, groceries"
            placeholderTextColor="rgba(255,255,255,0.55)"
            maxLength={120}
            selectionColor={brand.accent}
            cursorColor={brand.accent}
            accessibilityLabel="What was it for? Needed to save"
            style={{
              ...type.body,
              fontSize: 18,
              color: brand.onDeep,
              backgroundColor: 'rgba(255,255,255,0.14)',
              borderWidth: 2,
              borderColor: needsDescription ? brand.coral : 'rgba(255,255,255,0.3)',
              borderRadius: radius.lg,
              paddingHorizontal: space.lg,
              paddingVertical: space.md + 2,
              textAlign: 'center',
            }}
          />
        </Animated.View>
      </View>
    </>
  );

  return (
    <HeroScreen nav="close" title={title} card={card}>
      <Stack.Screen options={{ headerShown: false }} />

      <Gutter>
        {scanError ? <Notice>{scanError}</Notice> : null}
        {scanNote ? <Notice tone="info">{scanNote}</Notice> : null}
        {/* Who paid and how it's split, in one line. Tap to change. */}
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Change who paid and how it's split"
          onPress={() => void openSheet('split')}
          android_ripple={{ color: c.surfaceAlt }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            padding: space.lg,
            borderRadius: radius.lg,
            backgroundColor: c.surfaceAlt,
            borderWidth: splitProblem ? 1.5 : 0,
            borderColor: c.danger,
            overflow: 'hidden',
          }}>
          <Avatar name={name(payerId)} size={40} color={groupColor(payerId)} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="heading">Paid by {payerLabel}</Text>
            <Text variant="caption" muted numberOfLines={2}>
              {splitLine}
            </Text>
          </View>
          <Text muted style={{ fontSize: 22 }}>
            ›
          </Text>
        </Pressable>
        {splitProblem ? (
          <Text variant="label" color={c.danger}>
            {splitProblem}. Tap above to fix it.
          </Text>
        ) : null}
        {/* What it was, for spending by category. Guessed from the description until someone picks one. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Category: ${categoryInfo.name}${pickedCategory ? '' : ', suggested'}. Change`}
          onPress={() => void openSheet('category')}
          android_ripple={{ color: c.surfaceAlt }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            padding: space.lg,
            borderRadius: radius.lg,
            backgroundColor: c.surfaceAlt,
            overflow: 'hidden',
          }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 22 }}>{categoryInfo.emoji}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="heading">Category</Text>
            <Text variant="caption" muted numberOfLines={1}>
              {categoryInfo.name}
              {pickedCategory ? '' : ' · suggested'}
            </Text>
          </View>
          <Text muted style={{ fontSize: 22 }}>
            ›
          </Text>
        </Pressable>

        {!isEdit && !dueBill ? <RecurringLine form={recurring} onPress={() => void openSheet('recurring')} /> : null}
        {dueBill ? (
          <Notice tone="info">From your recurring “{dueBill.description}”. Enter this time’s amount; it’s split the same way.</Notice>
        ) : null}
      </Gutter>

      <Gutter>
        {mutation.isError ? <Notice>{mutation.error.message}</Notice> : null}
        {saveError ? <Notice>{saveError}</Notice> : null}
        <Button
          label={isEdit || schedule ? 'Save changes' : recurring.on && recurring.start !== todayDate() ? 'Save recurring' : 'Save'}
          onPress={save}
          disabled={!canSave && !(onlyDescriptionMissing && !busy)}
          loading={busy}
        />
      </Gutter>

      {/* Who paid and how to split it */}
      <Sheet
        visible={sheet === 'split'}
        onClose={() => setSheet(null)}
        fullHeight>
        <View style={{ gap: space.sm }}>
          <Text variant="heading">Paid by</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {members.map((id) => (
              <PersonPill key={id} label={id === myId ? 'You' : name(id)} selected={payerId === id} onPress={() => setPayerId(id)} />
            ))}
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <Text variant="heading">Split</Text>
          {groupSplits.length > 0 && group ? (
            <View style={{ gap: space.xs }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                {groupSplits.map((sp) => {
                  const gone = goneFromSplit(sp, group.memberIds);
                  const fewer = sp.shares.length < group.memberIds.length ? ` · ${sp.shares.length} of ${group.memberIds.length}` : '';
                  return (
                    <Chip
                      key={sp.id}
                      label={`${sp.name}${gone.length ? ' · needs updating' : fewer}`}
                      selected={appliedSplitId === sp.id}
                      onPress={() =>
                        gone.length
                          ? Alert.alert(
                              `${sp.name} needs updating`,
                              `${gone.map(name).join(' and ')} ${gone.length === 1 ? 'is' : 'are'} no longer in ${group.name}, so this split can’t be used until it’s updated. Update it from the group’s ⋯ menu → Saved splits.`,
                            )
                          : applySaved(sp)
                      }
                    />
                  );
                })}
              </View>
              {appliedSplitId ? (
                <Text variant="caption" muted>
                  Using {groupSplits.find((sp) => sp.id === appliedSplitId)?.name}
                  {appliedSplitId === group.defaultSplitId ? ' (the group’s default)' : ''}. Changing it here only changes this
                  expense.
                </Text>
              ) : null}
            </View>
          ) : null}
          <Segmented
            value={method}
            onChange={(m) => {
              setMethod(m);
              setValues({});
              setAppliedSplitId(null);
            }}
          />
          <Text variant="caption" muted>
            {METHODS.find((m) => m.id === method)?.hint}
          </Text>
          {method === 'items' ? (
            <View style={{ gap: space.sm }}>
              {items.map((item, index) => (
                <Card key={item.key} style={{ gap: space.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                    <TextInput
                      value={item.name}
                      onChangeText={(v) => updateItem(item.key, { name: v })}
                      placeholder={`Item ${index + 1}`}
                      placeholderTextColor={c.textMuted}
                      maxLength={60}
                      selectionColor={c.focus}
                      accessibilityLabel={`Item ${index + 1} name`}
                      style={{
                        ...type.body,
                        flex: 1,
                        color: c.text,
                        backgroundColor: c.surfaceAlt,
                        borderRadius: radius.sm,
                        paddingHorizontal: space.sm,
                        paddingVertical: space.sm,
                      }}
                    />
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: c.surfaceAlt,
                        borderRadius: radius.sm,
                        paddingHorizontal: space.sm,
                      }}>
                      <Text muted>{group ? currencySymbol(cur) : ''}</Text>
                      <TextInput
                        value={item.price}
                        onChangeText={(v) => updateItem(item.key, { price: v })}
                        placeholder="0.00"
                        placeholderTextColor={c.textMuted}
                        keyboardType="decimal-pad"
                        selectionColor={c.focus}
                        accessibilityLabel={`${item.name.trim() || `Item ${index + 1}`} price`}
                        style={{ ...type.body, color: c.text, width: 72, textAlign: 'right', paddingVertical: space.sm }}
                      />
                    </View>
                    {items.length > 1 ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${item.name.trim() || `item ${index + 1}`}`}
                        onPress={() => setItems((list) => list.filter((i) => i.key !== item.key))}
                        hitSlop={8}
                        style={{ paddingHorizontal: space.xs }}>
                        <Text muted style={{ fontSize: 20 }}>
                          ×
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <Text variant="caption" muted>
                    Who had it?
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                    {members.map((id) => {
                      const had = item.userIds.includes(id);
                      return (
                        <Chip
                          key={id}
                          label={id === myId ? 'You' : name(id)}
                          selected={had}
                          onPress={() =>
                            updateItem(item.key, {
                              userIds: had ? item.userIds.filter((u) => u !== id) : [...item.userIds, id],
                            })
                          }
                        />
                      );
                    })}
                  </View>
                </Card>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() => setItems((list) => [...list, newItem()])}
                style={{
                  alignItems: 'center',
                  padding: space.md,
                  borderRadius: radius.lg,
                  borderWidth: 1.5,
                  borderStyle: 'dashed',
                  borderColor: c.border,
                }}>
                <Text variant="label" color={c.primary}>
                  ＋ Add item
                </Text>
              </Pressable>
              {itemTotals && group && amount > 0 ? (
                itemTotals.extra > 0 ? (
                  <Card style={{ gap: space.sm }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                      <Text variant="heading" style={{ flex: 1 }}>
                        Everything else
                      </Text>
                      <Text variant="heading" style={{ fontVariant: ['tabular-nums'] }}>
                        {formatMoney(itemTotals.extra, cur)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
                      <Chip label="Split equally" selected={rest === 'equal'} onPress={() => setRest('equal')} />
                      <Chip label="In proportion" selected={rest === 'proportional'} onPress={() => setRest('proportional')} />
                    </View>
                    <Text variant="caption" muted>
                      {rest === 'equal'
                        ? 'Shared equally by everyone ticked below.'
                        : 'For tax and tip: whoever had more pays more.'}
                    </Text>
                  </Card>
                ) : (
                  <Text variant="caption" muted style={{ textAlign: 'center' }}>
                    Items {formatMoney(itemTotals.items, cur)} · nothing left over
                  </Text>
                )
              ) : null}
            </View>
          ) : null}
          <Card style={{ paddingVertical: space.xs }}>
            {members.map((id, i) => {
              const hadItem = items.some((item) => item.userIds.includes(id));
              const on = method === 'items' ? hadItem || (restEqual && isIncluded(id)) : isIncluded(id);
              const share = preview.ok ? preview.shares.find((s) => s.userId === id) : undefined;
              return (
                <View key={id}>
                  {i > 0 ? <Divider /> : null}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.md,
                      paddingVertical: space.md,
                      opacity: on ? 1 : 0.55,
                    }}>
                    {method === 'items' && !restEqual ? (
                      <Avatar name={name(id)} size={26} color={on ? groupColor(id) : undefined} />
                    ) : (
                      // In an items split the tick is "shares everything else"; having an item keeps them in either way.
                      <Tick
                        on={isIncluded(id)}
                        label={name(id)}
                        onPress={() => {
                          setIncluded((s) => ({ ...s, [id]: !isIncluded(id) }));
                          setAppliedSplitId(null);
                        }}
                      />
                    )}
                    <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
                      {id === myId ? 'You' : name(id)}
                    </Text>
                    {method !== 'equal' && method !== 'items' && on ? (
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          backgroundColor: c.surfaceAlt,
                          borderRadius: radius.sm,
                          paddingHorizontal: space.sm,
                        }}>
                        {method === 'exact' && group ? <Text muted>{currencySymbol(cur)}</Text> : null}
                        <TextInput
                          value={values[id] ?? ''}
                          onChangeText={(v) => {
                            setValues((s) => ({ ...s, [id]: v }));
                            setAppliedSplitId(null);
                          }}
                          placeholder={method === 'shares' ? '1' : method === 'exact' ? '0.00' : '0'}
                          placeholderTextColor={c.textMuted}
                          keyboardType={method === 'shares' ? 'number-pad' : 'decimal-pad'}
                          selectionColor={c.focus}
                          accessibilityLabel={`${name(id)} ${method === 'percentage' ? 'percentage' : method === 'shares' ? 'shares' : 'amount'}`}
                          style={{ ...type.body, color: c.text, width: 64, textAlign: 'right', paddingVertical: space.sm }}
                        />
                        {method === 'percentage' ? <Text muted> %</Text> : null}
                      </View>
                    ) : null}
                    <Text
                      variant="label"
                      color={share ? c.text : c.textMuted}
                      style={{ width: 80, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
                      {share && group ? formatMoney(share.amount, group.currency) : on ? '—' : 'not in'}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>
        </View>

        {/* Save what's set up here as a saved split, without leaving the expense. */}
        {group && !group.closedAt && !appliedSplitId && method !== 'items' && method !== 'exact' ? (
          naming ? (
            <Card style={{ gap: space.sm }}>
              <Text variant="label">Name this split</Text>
              <TextInput
                value={splitName}
                onChangeText={setSplitName}
                placeholder="e.g. Electricity"
                placeholderTextColor={c.textMuted}
                maxLength={40}
                autoFocus
                selectionColor={c.focus}
                accessibilityLabel="Saved split name"
                style={{ ...type.body, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.sm }}
              />
              {saveSplit.isError ? <Notice>{saveSplit.error.message}</Notice> : null}
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button label="Cancel" kind="secondary" onPress={() => setNaming(false)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Save split"
                    loading={saveSplit.isPending}
                    disabled={!splitName.trim()}
                    onPress={() => {
                      const shares = savedFromForm(method, participantIds, values);
                      if (!shares.ok) {
                        Alert.alert('Can’t save this split yet', shares.error);
                        return;
                      }
                      saveSplit.mutate(
                        { groupId: group.id, name: splitName.trim(), method, shares: shares.shares },
                        {
                          onSuccess: (id) => {
                            setNaming(false);
                            setSplitName('');
                            setAppliedSplitId(id);
                            buzz.success();
                          },
                        },
                      );
                    }}
                  />
                </View>
              </View>
            </Card>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setNaming(true)} hitSlop={6} style={{ alignSelf: 'center', padding: space.xs }}>
              <Text variant="label" color={c.primary}>
                ＋ Save this split for later
              </Text>
            </Pressable>
          )
        ) : null}

        {/* Done sits at the end of the form, not pinned, so typing an item keeps the whole space. */}
        <View style={{ gap: space.sm }}>
          {remaining ? (
            <Text variant="label" color={c.danger} style={{ textAlign: 'center' }}>
              {remaining}
            </Text>
          ) : null}
          <Button label="Done" onPress={() => setSheet(null)} />
        </View>
      </Sheet>

      {/* Take or pick a photo of the receipt */}
      <Sheet visible={sheet === 'scan'} onClose={() => setSheet(null)} title="Scan a receipt">
        <View style={{ gap: space.sm }}>
          <Text muted>Get the whole receipt in the photo, flat and in good light. You can check everything before you save.</Text>
          <Button label="Take a photo" onPress={() => void scan('camera')} />
          <Button label="Choose from photos" kind="secondary" onPress={() => void scan('library')} />
        </View>
      </Sheet>

      {/* Asked the first time: may receipt photos go to Anthropic? */}
      <Sheet visible={sheet === 'consent'} onClose={() => setSheet(null)} title="Scan receipts with AI?">
        <View style={{ gap: space.md }}>
          <Text>
            To read a receipt, sic sends the photo to Anthropic, the company that makes the Claude AI. It reads the shop, total and
            items and sends them back. Only the photo is sent, not your name, email or group.
          </Text>
          <Text muted>
            Anthropic is outside Australia. Photograph just the receipt, as anything else in the photo is sent too. If you decline,
            nothing is sent and receipt scanning stays off. You can change this in Profile.
          </Text>
          {setConsent.isError ? <Notice>{setConsent.error.message}</Notice> : null}
          <Button label="Accept" onPress={() => answerConsent(true)} loading={setConsent.isPending && setConsent.variables === true} />
          <Button
            label="Decline"
            kind="secondary"
            onPress={() => answerConsent(false)}
            disabled={setConsent.isPending}
          />
        </View>
      </Sheet>

      {/* Which group (only when starting from Home with more than one group) */}
      {/* Category: ten tiles, two to a row */}
      <Sheet visible={sheet === 'category'} onClose={() => setSheet(null)} title="Category">
        <CategoryGrid
          tiles={CATEGORIES.map((cat) => ({ ...cat, note: !pickedCategory && cat.id === suggestedCategory ? 'suggested' : undefined }))}
          selected={category}
          onPick={(id) => {
            setPickedCategory(id);
            setSheet(null);
          }}
        />
      </Sheet>

      {/* Which currency it was paid in */}
      <Sheet visible={sheet === 'currency'} onClose={() => setSheet(null)} title="Paid in">
        {group ? (
          <Text variant="caption" muted>
            {group.name} settles up in {group.currency}. Anything else is converted into {group.currency} at the day’s rate, and you can
            change the rate.
          </Text>
        ) : null}
        <Card style={{ paddingVertical: 0 }}>
          {(group ? [PAY_CURRENCIES.find((x) => x.code === group.currency) ?? { code: group.currency, name: 'Group currency' }, ...PAY_CURRENCIES.filter((x) => x.code !== group.currency)] : PAY_CURRENCIES).map(
            (x, i) => (
              <View key={x.code}>
                {i > 0 ? <Divider /> : null}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: x.code === cur }}
                  onPress={() => {
                    if (x.code !== cur) payIn(group && x.code === group.currency ? null : x.code);
                    setSheet(null);
                  }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md }}>
                  <Text variant="heading" style={{ width: 52 }}>
                    {x.code}
                  </Text>
                  <Text style={{ flex: 1 }} muted={x.code !== cur}>
                    {x.name}
                    {group && x.code === group.currency ? ' · the group’s currency' : ''}
                  </Text>
                  {x.code === cur ? <Text color={c.primary}>✓</Text> : null}
                </Pressable>
              </View>
            ),
          )}
        </Card>
      </Sheet>

      {/* The exchange rate: today's, a typed rate, or what the bank charged */}
      <Sheet visible={sheet === 'rate'} onClose={() => setSheet(null)} title="Exchange rate">
        {group ? (
          <View style={{ gap: space.md }}>
            <Text muted>
              {`Paid in ${cur}, shared in ${group.currency}. The rate is locked when you save, so this expense won’t change if rates move later.`}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
              <Chip label={lockedRate && !fx.data ? 'Saved rate' : 'Today’s rate'} selected={rateMode === 'auto'} onPress={() => setRateMode('auto')} />
              <Chip label="Type a rate" selected={rateMode === 'manual'} onPress={() => setRateMode('manual')} />
              <Chip label="What my bank charged" selected={rateMode === 'bank'} onPress={() => setRateMode('bank')} />
            </View>
            {rateMode === 'auto' ? (
              <Text variant="caption" muted>
                {lockedRate
                  ? `Keeping the rate this expense was saved with: 1 ${cur} = ${showRate(lockedRate.rate)} ${group.currency}.`
                  : fx.data
                    ? `European Central Bank rate for ${new Date(`${fx.data.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}: 1 ${cur} = ${showRate(fx.data.rate)} ${group.currency}.`
                    : fx.isError
                      ? 'Couldn’t get today’s rate. Type a rate, or what your bank charged.'
                      : 'Getting today’s rate…'}
              </Text>
            ) : rateMode === 'manual' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <Text variant="heading">1 {cur} =</Text>
                <TextInput
                  value={rateText}
                  onChangeText={setRateText}
                  placeholder={fx.data ? showRate(fx.data.rate) : '0.00'}
                  placeholderTextColor={c.textMuted}
                  keyboardType="decimal-pad"
                  autoFocus
                  selectionColor={c.focus}
                  accessibilityLabel={`How many ${group.currency} one ${cur} is worth`}
                  style={{ ...type.body, flex: 1, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.sm }}
                />
                <Text variant="heading">{group.currency}</Text>
              </View>
            ) : (
              <View style={{ gap: space.xs }}>
                <Text variant="caption" muted>
                  From your bank statement or app, including any fees. The rate is worked out from it.
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Text variant="heading">{currencySymbol(group.currency)}</Text>
                  <TextInput
                    value={bankText}
                    onChangeText={setBankText}
                    placeholder={Number.isFinite(amount) && amount > 0 && rateMode !== 'bank' ? centsToDecimalString(amount) : '0.00'}
                    placeholderTextColor={c.textMuted}
                    keyboardType="decimal-pad"
                    autoFocus
                    selectionColor={c.focus}
                    accessibilityLabel={`What your bank charged in ${group.currency}`}
                    style={{ ...type.body, flex: 1, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.sm }}
                  />
                </View>
              </View>
            )}
            {rateInfo && Number.isFinite(amount) && amount > 0 ? (
              <Text variant="label" style={{ fontVariant: ['tabular-nums'] }}>
                {`${formatMoney(paidAmount, cur)} = ${formatMoney(amount, group.currency)}`}
              </Text>
            ) : null}
            <Button label="Done" onPress={() => setSheet(null)} />
          </View>
        ) : null}
      </Sheet>

      <Sheet visible={sheet === 'group'} onClose={() => setSheet(null)} title="Which group?">
        <View style={{ gap: space.sm }}>
          {groups.map((g) => (
            <Pressable
              key={g.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: g.id === groupId }}
              onPress={() => {
                pickGroup(g.id);
                setSheet(null);
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                padding: space.md,
                borderRadius: radius.lg,
                borderWidth: g.id === groupId ? 2 : 1,
                borderColor: g.id === groupId ? c.focus : c.border,
                backgroundColor: c.surface,
              }}>
              <GroupIcon group={g} size={40} />
              <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
                {g.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </Sheet>

      {/* Recurring: how often, when it starts and ends, the heads-up, and whether the amount changes. */}
      <Sheet
        visible={sheet === 'recurring'}
        onClose={() => setSheet(null)}
        title="Recurring"
        footer={<Button label="Done" onPress={() => setSheet(null)} />}>
        <RecurringPanel
          form={recurring}
          onChange={setRecurring}
          editingSchedule={!!schedule}
          summary={recurringSummary(recurring, {
            description,
            amount: Number.isFinite(amount) && amount > 0 ? amount : null,
            currency: group?.currency ?? 'USD',
            payer: payerId === myId ? 'you' : name(payerId),
            splitLine: splitLine.replace(/^Split /, 'split '),
          })}
        />
      </Sheet>
    </HeroScreen>
  );
}
