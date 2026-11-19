/**
 * Offline: what the phone keeps so sic. works without a signal.
 *
 *  1. The last copy of your groups, expenses, payments and balances (the cache), so sic. opens
 *     with them even with no signal. Each account's copy is kept apart and removed on sign-out.
 *  2. New expenses and payments saved with no signal (the outbox). Each gets its id on the phone,
 *     so sending it again after a cut-off connection never saves it twice (the database checks).
 *     They show straight away, marked "Waiting to sync", and go up in the order they were made as
 *     soon as the connection is back. One the database turns down (say the group was closed
 *     meanwhile) is kept, marked "Couldn't sync", until it's fixed or deleted. Nothing is dropped
 *     silently.
 *  3. Whether sic. can reach the database. There's no network module in the app, so this comes
 *     from the requests themselves: one failing for lack of a connection means offline, any
 *     answer means online. While offline it checks again every 20 seconds and whenever the app
 *     comes back to the front.
 *
 * Editing or deleting something already synced needs a connection (no clashes with someone else's
 * changes). Expenses and payments still waiting can be changed or deleted freely: it's only the
 * phone's copy.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import './local-storage';
import { supabase } from './supabase';

// ─── Connection ──────────────────────────────────────────────────────────────

/** True when a request failed because there was no connection (not because the server said no). */
export function isNetworkError(e: unknown): boolean {
  if (!e) return false;
  const err = e as { message?: unknown; name?: unknown; code?: unknown };
  const message = typeof err.message === 'string' ? err.message : String(e);
  if (err.name === 'AbortError' || /abort/i.test(message)) return true;
  // Postgres and PostgREST errors carry a code; a dropped connection doesn't.
  if (typeof err.code === 'string' && err.code !== '') return false;
  return /network request failed|failed to fetch|networkerror|load failed|network|timed? ?out|internet/i.test(message);
}

/** A friendlier message for things that need a connection. */
export const NEEDS_CONNECTION = 'You’re offline. This needs a connection. Try again when you’re back online.';

/** Turn a dropped-connection error into NEEDS_CONNECTION; anything else is passed through. */
export function explainOffline(e: unknown): Error {
  if (isNetworkError(e)) {
    setOnline(false);
    return new Error(NEEDS_CONNECTION);
  }
  return e instanceof Error ? e : new Error(String((e as { message?: unknown })?.message ?? e));
}

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

let online = true;
let probeTimer: ReturnType<typeof setInterval> | null = null;
let onReconnect: (() => void) | null = null;
let refresh: (() => Promise<unknown>) | null = null;

/** Called by the app's root: how to fetch everything again (after the outbox was sent). */
export function setRefresher(fn: () => Promise<unknown>) {
  refresh = fn;
}

/** Called by the app's root: what to do when the connection comes back (refresh, send the outbox). */
export function whenReconnected(fn: () => void) {
  onReconnect = fn;
}

export function setOnline(value: boolean) {
  if (value === online) return;
  online = value;
  emit();
  if (!value && !probeTimer) probeTimer = setInterval(() => void probe(), 20_000);
  if (value) {
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    onReconnect?.();
  }
}

/** Can the database be reached? Any answer at all counts as online. */
async function probe() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(`${url}/auth/v1/health`, { signal: controller.signal });
    setOnline(true);
  } catch {
    setOnline(false);
  } finally {
    clearTimeout(timer);
  }
}

// Opening the app: find out straight away (the phone's copy shows meanwhile).
setTimeout(() => void probe(), 1500);

AppState.addEventListener('change', (state) => {
  if (state === 'active' && (!online || outbox.length > 0)) void probe();
});

export function isOnline() {
  return online;
}

export function useOnline() {
  return useSyncExternalStore(subscribe, () => online);
}

/**
 * Give a request `ms` to answer; past that, treat the connection as gone (a weak signal can leave a
 * request hanging). Safe for saves because of the phone-made ids.
 */
export function withTimeout<T extends { abortSignal: (s: AbortSignal) => T }>(builder: T, ms = 12_000): T {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return builder.abortSignal(controller.signal);
}

/** A new id for something made on this phone (random, version 4 format). */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function read<T>(key: string): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: sic. still works, just without the saved copy.
  }
}

// ─── The cache ───────────────────────────────────────────────────────────────

const cacheKey = (userId: string) => `sic.cache.${userId}`;

/** Maps don't survive JSON, so they're stored as tagged lists of pairs. */
function replacer(_key: string, value: unknown) {
  return value instanceof Map ? { __map: [...value.entries()] } : value;
}
function reviver(_key: string, value: unknown) {
  return value && typeof value === 'object' && '__map' in (value as object)
    ? new Map((value as { __map: [unknown, unknown][] }).__map)
    : value;
}

export function saveCache(userId: string, data: unknown) {
  try {
    globalThis.localStorage?.setItem(cacheKey(userId), JSON.stringify({ savedAt: Date.now(), data }, replacer));
    lastSaved = Date.now();
    emit();
  } catch {
    // Not fatal.
  }
}

export function loadCache<T>(userId: string): { savedAt: number; data: T } | null {
  try {
    const raw = globalThis.localStorage?.getItem(cacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw, reviver) as { savedAt: number; data: T };
    if (lastSaved === null) lastSaved = parsed.savedAt;
    return parsed;
  } catch {
    return null;
  }
}

/** When the phone's copy was last brought up to date (for "Offline · updated 2:14pm"). */
let lastSaved: number | null = null;
export function useLastSaved() {
  return useSyncExternalStore(subscribe, () => lastSaved);
}

// ─── The outbox ──────────────────────────────────────────────────────────────

export type OutboxEntry = {
  /** The id the phone gave it; the database keeps it. */
  id: string;
  userId: string;
  groupId: string;
  createdAt: string;
  /** The database turned it down: why. Kept until fixed or deleted. */
  error?: string;
} & (
  | { kind: 'expense'; rpc: 'create_expense'; args: Record<string, unknown> }
  | { kind: 'payment'; rpc: 'record_settlement'; args: Record<string, unknown> }
);

const OUTBOX_KEY = 'sic.outbox';
let outbox: OutboxEntry[] = read<OutboxEntry[]>(OUTBOX_KEY) ?? [];
const saveOutbox = () => {
  write(OUTBOX_KEY, outbox.length ? outbox : null);
  emit();
};

export function useOutbox(userId: string): OutboxEntry[] {
  const all = useSyncExternalStore(subscribe, () => outbox);
  return useMemo(() => all.filter((e) => e.userId === userId), [all, userId]);
}

export function outboxEntry(id: string): OutboxEntry | undefined {
  return outbox.find((e) => e.id === id);
}

export function addToOutbox(entry: OutboxEntry) {
  outbox = [...outbox.filter((e) => e.id !== entry.id), entry];
  saveOutbox();
  setOnline(false);
}

/** Change something still waiting (editing it before it synced). It's tried again. */
export function replaceInOutbox(id: string, args: Record<string, unknown>) {
  outbox = outbox.map((e) => (e.id === id ? ({ ...e, args: { ...args, p_id: id }, error: undefined } as OutboxEntry) : e));
  saveOutbox();
  if (online) void flushOutbox();
}

export function removeFromOutbox(id: string) {
  outbox = outbox.filter((e) => e.id !== id);
  saveOutbox();
}

/** Forget a signed-out account's saved copy. Unsent changes stay, in case they sign back in. */
export function forgetCache(userId: string) {
  write(cacheKey(userId), null);
  lastSaved = null;
  emit();
}

let flushing: Promise<boolean> | null = null;

/**
 * Send what's waiting, oldest first, for the signed-in account. Stops at the first dropped
 * connection (the rest wait for the next try). Returns true if anything was saved.
 */
export function flushOutbox(): Promise<boolean> {
  if (flushing) return flushing;
  flushing = (async () => {
    const sentIds: string[] = [];
    const { data } = await supabase.auth.getSession();
    const me = data.session?.user.id;
    if (!me) return false;
    for (const entry of outbox.filter((e) => e.userId === me && !e.error)) {
      try {
        const { error } = await withTimeout(supabase.rpc(entry.rpc as never, entry.args as never));
        if (error) throw error;
        sentIds.push(entry.id);
      } catch (e) {
        if (isNetworkError(e)) {
          setOnline(false);
          break;
        }
        outbox = outbox.map((x) =>
          x.id === entry.id ? { ...x, error: e instanceof Error ? e.message : String((e as { message?: unknown }).message ?? e) } : x,
        );
        saveOutbox();
      }
    }
    if (sentIds.length) {
      // Fetch the database's copy first, so what was sent never blinks out of the list in between.
      try {
        await refresh?.();
      } catch {
        // Shown as synced anyway; the next refresh catches up.
      }
      outbox = outbox.filter((e) => !sentIds.includes(e.id));
      saveOutbox();
    }
    return sentIds.length > 0;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Try one that couldn't sync again (after the problem was fixed elsewhere). */
export function retryEntry(id: string) {
  outbox = outbox.map((e) => (e.id === id ? ({ ...e, error: undefined } as OutboxEntry) : e));
  saveOutbox();
  void flushOutbox();
}
