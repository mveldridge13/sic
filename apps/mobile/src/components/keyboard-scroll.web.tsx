import { ScrollView, type ScrollViewProps } from 'react-native';

/** The web stand-in for react-native-keyboard-controller's KeyboardAwareScrollView (see keyboard-scroll.tsx). */
export function KeyboardAwareScrollView({
  bottomOffset,
  ...props
}: ScrollViewProps & { bottomOffset?: number }) {
  void bottomOffset; // Browsers move the page for the keyboard themselves.
  return <ScrollView {...props} />;
}
