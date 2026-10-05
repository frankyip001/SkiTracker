import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
// Import for side effects: registers the background location task (top-level scope).
import '../lib/recorder';
import { getDb } from '../lib/db';

export default function RootLayout() {
  useEffect(() => {
    getDb().catch((e) => console.warn('[db] init failed', e));
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="day/[id]" options={{ title: 'Ski day' }} />
        <Stack.Screen name="day/[id]/timeline" options={{ title: 'Edit timeline' }} />
        <Stack.Screen name="day/[id]/map" options={{ title: 'Track map' }} />
      </Stack>
    </>
  );
}
