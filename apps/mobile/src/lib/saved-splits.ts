/**
 * Turning a saved split into the Add expense form's state and back, and describing one in words.
 * The form keeps per-person text: percentages as typed ("33.33"), shares as whole numbers ("2").
 */
import { centsToDecimalString, FULL_PERCENT_BPS, parseToCents } from '@tally/shared';

import type { SavedSplit, SavedSplitMethod } from './data';

export interface SplitFormState {
  method: SavedSplitMethod;
  included: Record<string, boolean>;
  values: Record<string, string>;
}

/** The form state a saved split fills in: who's ticked (everyone else in the group unticked) and their numbers. */
export function formFromSaved(split: SavedSplit, memberIds: string[]): SplitFormState {
  const included: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  for (const id of memberIds) {
    const share = split.shares.find((s) => s.userId === id);
    included[id] = !!share;
    if (share && share.weight !== null) {
      values[id] = split.method === 'percentage' ? centsToDecimalString(share.weight).replace(/\.00$/, '') : String(share.weight);
    }
  }
  return { method: split.method, included, values };
}

/** The shares to save from the form, or why they can't be saved yet. */
export function savedFromForm(
  method: SavedSplitMethod,
  participantIds: string[],
  values: Record<string, string>,
): { ok: true; shares: SavedSplit['shares'] } | { ok: false; error: string } {
  if (participantIds.length === 0) return { ok: false, error: 'Tick at least one person.' };
  if (method === 'equal') return { ok: true, shares: participantIds.map((userId) => ({ userId, weight: null })) };
  try {
    const shares = participantIds.map((userId) => ({
      userId,
      weight: method === 'percentage' ? parseToCents(values[userId] || '0') : Number.parseInt(values[userId] || '1', 10),
    }));
    if (shares.some((s) => !Number.isSafeInteger(s.weight) || (s.weight ?? 0) < 0)) return { ok: false, error: 'Check the numbers you entered.' };
    const total = shares.reduce((a, s) => a + (s.weight ?? 0), 0);
    // Same rule as splitting an expense: 33.33% × 3 = 99.99% counts as 100%.
    if (method === 'percentage' && Math.abs(total - FULL_PERCENT_BPS) > shares.length - 1)
      return { ok: false, error: 'The percentages need to add up to 100%.' };
    if (method === 'shares' && total === 0) return { ok: false, error: 'At least one person needs a share.' };
    return { ok: true, shares };
  } catch {
    return { ok: false, error: 'Check the numbers you entered.' };
  }
}

/** "Alex 50% · Sam 25% · Jordan 25%", "Alex 2 · Sam 1", "Equally: Alex, Sam". */
export function describeSplit(split: SavedSplit, name: (id: string) => string): string {
  if (split.method === 'equal') return `Equally: ${split.shares.map((s) => name(s.userId)).join(', ')}`;
  return split.shares
    .map((s) =>
      split.method === 'percentage'
        ? `${name(s.userId)} ${centsToDecimalString(s.weight ?? 0).replace(/\.00$/, '')}%`
        : `${name(s.userId)} ${s.weight} ${s.weight === 1 ? 'share' : 'shares'}`,
    )
    .join(' · ');
}

export const SAVED_METHOD_LABEL: Record<SavedSplitMethod, string> = { equal: 'Equally', percentage: 'Percent', shares: 'Shares' };
