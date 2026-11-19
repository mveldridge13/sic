import { router } from 'expo-router';

/**
 * Close the screen: back to where you came from, or Home when there's nothing to go back to
 * (in a browser, a page opened directly or refreshed has no history, so "back" did nothing).
 */
export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}
