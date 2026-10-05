import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="record"
        options={{ title: 'Record', tabBarLabel: 'Record' }}
      />
      <Tabs.Screen
        name="history"
        options={{ title: 'History', tabBarLabel: 'History' }}
      />
    </Tabs>
  );
}
