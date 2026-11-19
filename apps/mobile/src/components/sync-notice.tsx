/**
 * On an expense or payment saved on this phone with no signal: what's happening with it.
 * Waiting: it goes up by itself once the signal's back. Couldn't sync: why, with Try again and
 * Delete (an expense can also be fixed with Edit, which tries again).
 */
import { router } from 'expo-router';
import { Alert, View } from 'react-native';

import { Button, Notice } from '@/components/ui';
import type { SyncState } from '@/lib/data';
import { removeFromOutbox, retryEntry } from '@/lib/offline';
import { space } from '@/theme';

/** End the database's message with a full stop if it has none. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function SyncNotice({ id, sync, error, kind }: { id: string; sync: SyncState; error?: string; kind: 'expense' | 'payment' }) {
  if (sync === 'waiting') {
    return (
      <Notice tone="info">
        {`Saved on this phone while offline. It syncs by itself when you’re back online; until then nobody else can see it.`}
      </Notice>
    );
  }
  const confirmDelete = () =>
    Alert.alert(`Delete this ${kind}?`, 'It was never synced, so it’s only on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          removeFromOutbox(id);
          router.back();
        },
      },
    ]);
  return (
    <View style={{ gap: space.sm }}>
      <Notice>{`Couldn’t sync: ${sentence(error ?? 'the database turned it down')} ${kind === 'expense' ? 'Edit it to fix it, or delete it.' : 'Delete it, or try again.'}`}</Notice>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" size="small" label="Try again" onPress={() => retryEntry(id)} />
        </View>
        <View style={{ flex: 1 }}>
          <Button kind="danger" size="small" label="Delete" onPress={confirmDelete} />
        </View>
      </View>
    </View>
  );
}
