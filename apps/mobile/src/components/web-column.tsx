import type { ReactNode } from 'react';

/**
 * Phones: passes its children straight through, adding nothing. The web keeps them in the centred
 * page column instead (web-column.web.tsx), so a full-window screen doesn't stretch across the browser.
 */
export function WebColumn({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
