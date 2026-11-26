import type { ReactNode } from 'react';
import { View } from 'react-native';

import { CONTENT_MAX_WIDTH } from '@/lib/layout';

/** Web: the same centred column as every other page (see HeroScreen), filling the window's height. */
export function WebColumn({ children }: { children: ReactNode }) {
  return <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>{children}</View>;
}
