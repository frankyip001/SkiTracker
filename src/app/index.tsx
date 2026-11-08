import { Redirect } from 'expo-router';

// The route tree has no screen at "/" — without this index route a cold
// start lands on Expo Router's "Unmatched Route" page. Send the app's
// home route straight to the Record tab.
export default function Index() {
  return <Redirect href="/record" />;
}
