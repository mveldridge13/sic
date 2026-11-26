import { currencyDecimals, parseToCents } from '@tally/shared';
import { useQuery } from '@tanstack/react-query';
import { requireOptionalNativeModule } from 'expo';
import type * as Manipulator from 'expo-image-manipulator';
import type * as ImagePicker from 'expo-image-picker';
import { FunctionsHttpError } from '@supabase/supabase-js';

import { isCategoryId, type CategoryId } from './categories';
import { supabase } from './supabase';

/** What the scan-receipt edge function reads off a photo. Empty strings mean "not on the receipt". */
export interface ReceiptScan {
  is_receipt: boolean;
  merchant: string;
  date: string;
  currency: string;
  total: string;
  /** One of the category ids; missing from an older version of the function. */
  category?: string;
  items: { name: string; price: string }[];
}

/** The scan, with prices turned into cents and anything unreadable dropped. */
export interface ReadReceipt {
  merchant: string;
  currency: string | null;
  total: number | null;
  category: CategoryId | null;
  items: { name: string; amount: number }[];
}

/**
 * Whether this build has the camera and image packages. An app built before receipt scanning was
 * added doesn't, and loading them there would crash, so they're only loaded when scanning.
 */
export const canScanReceipts =
  !!requireOptionalNativeModule('ExponentImagePicker') && !!requireOptionalNativeModule('ExpoImageManipulator');

/* eslint-disable @typescript-eslint/no-require-imports */
const picker = () => require('expo-image-picker') as typeof ImagePicker;
const manipulator = () => require('expo-image-manipulator') as typeof Manipulator;
/* eslint-enable @typescript-eslint/no-require-imports */

// Claude reads images up to about this size on the long side; bigger only costs more to send.
const MAX_SIDE = 1568;

/** A printed amount in the receipt's currency, in its smallest unit (whole yen, or cents). */
function cents(text: string, currency: string | null): number | null {
  try {
    // Yen and won have no cents: "1250" is ¥1,250, and a stray ".00" is ignored.
    const value =
      currency && currencyDecimals(currency) === 0 ? Math.round(Number(text.replace(/,/g, ''))) : parseToCents(text);
    if (!Number.isSafeInteger(value)) return null;
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Ask for the camera or photos, then let the person take or pick one. Null if they cancel. */
export async function pickReceiptPhoto(from: 'camera' | 'library'): Promise<ImagePicker.ImagePickerAsset | null> {
  if (!canScanReceipts) throw new Error('Update sic to scan receipts.');
  const ImagePicker = picker();
  const permission =
    from === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      from === 'camera'
        ? 'sic needs the camera to scan a receipt. You can turn it on in your phone’s Settings.'
        : 'sic needs your photos to pick a receipt. You can turn it on in your phone’s Settings.',
    );
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1 };
  const result = from === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  return result.canceled ? null : (result.assets[0] ?? null);
}

function randomId(): string {
  const hex = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 36; i++) id += i === 8 || i === 13 || i === 18 || i === 23 ? '-' : hex[Math.floor(Math.random() * 16)];
  return id;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A receipt photo shrunk and ready to send: a JPEG, base64-encoded. It stays on the phone until saved. */
export type PreparedReceipt = { base64: string };

/** Shrink the photo to what Claude needs and encode it. */
export async function prepareReceipt(photo: ImagePicker.ImagePickerAsset): Promise<PreparedReceipt> {
  const { ImageManipulator, SaveFormat } = manipulator();
  const context = ImageManipulator.manipulate(photo.uri);
  if (Math.max(photo.width, photo.height) > MAX_SIDE) {
    context.resize(photo.width >= photo.height ? { width: MAX_SIDE } : { height: MAX_SIDE });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7, base64: true });
  if (!saved.base64) throw new Error('Couldn’t prepare the photo. Please try again.');
  return { base64: saved.base64 };
}

/**
 * Read a receipt. The photo is sent straight to the scan-receipt function and isn't stored: it's
 * only uploaded once the expense is saved (attachReceipt). Throws with a message that's fine to show.
 */
export async function scanReceipt(photo: PreparedReceipt): Promise<ReadReceipt> {
  const { data, error } = await supabase.functions.invoke<ReceiptScan>('scan-receipt', { body: { image: photo.base64 } });
  if (error) {
    let message = 'Couldn’t read this photo. Please try again.';
    if (error instanceof FunctionsHttpError) {
      try {
        const body = (await error.context.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the general message.
      }
    }
    throw new Error(message);
  }
  if (!data || !data.is_receipt) throw new Error('That doesn’t look like a receipt. Try another photo with the whole bill in view.');

  const currency = /^[A-Z]{3}$/.test(data.currency) ? data.currency : null;
  const items = data.items
    .map((i) => ({ name: i.name.trim().slice(0, 60), amount: cents(i.price, currency) }))
    .filter((i): i is { name: string; amount: number } => !!i.name && i.amount !== null)
    .slice(0, 100);
  return {
    merchant: data.merchant.trim().slice(0, 120),
    currency,
    total: cents(data.total, currency),
    category: isCategoryId(data.category) && data.category !== 'other' ? data.category : null,
    items,
  };
}

/**
 * Upload the photo and put it on a saved expense. If putting it on fails, the upload is left
 * unused and the server deletes it after a day.
 */
export async function attachReceipt(expenseId: string, groupId: string, photo: PreparedReceipt): Promise<void> {
  const path = `${groupId}/${randomId()}.jpg`;
  const { error: uploadError } = await supabase.storage
    .from('receipts')
    .upload(path, base64ToBytes(photo.base64), { contentType: 'image/jpeg' });
  if (uploadError) throw new Error('Couldn’t upload the photo. Check your connection and try again.');
  const { error } = await supabase.rpc('set_expense_receipt', { p_expense_id: expenseId, p_path: path });
  if (error) throw error;
}

/**
 * Ask the server to delete photos it has queued (from deleted expenses, removed photos or deleted
 * accounts). Safe to call any time; failures are tried again on the next call.
 */
export function emptyReceiptTrash(): void {
  void supabase.functions.invoke('empty-receipt-trash', { body: {} }).catch(() => {});
}

/** A short-lived link to show a receipt photo. */
export function useReceiptUrl(path: string | null) {
  return useQuery({
    queryKey: ['receipt-url', path],
    enabled: !!path,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('receipts').createSignedUrl(path!, 60 * 60);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}
