import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { listSessions, type Session } from '../../lib/db';
import { computeDayStats } from '../../lib/dayStats';
import { formatDate, formatDistance, formatSpeedKmh, formatVertical } from '../../lib/format';

interface Row {
  session: Session;
  verticalM: number;
  distanceM: number;
  maxSpeedKmh: number;
  runCount: number;
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sessions = await listSessions();
      const out: Row[] = [];
      for (const s of sessions) {
        try {
          const stats = await computeDayStats(s.id);
          out.push({
            session: s,
            verticalM: stats.verticalM,
            distanceM: stats.distanceM,
            maxSpeedKmh: stats.maxSpeedKmh,
            runCount: stats.runCount,
          });
        } catch {
          out.push({ session: s, verticalM: 0, distanceM: 0, maxSpeedKmh: 0, runCount: 0 });
        }
      }
      setRows(out);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <Text>Loading…</Text>
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No ski days yet.</Text>
        <Text style={styles.emptySub}>Hit Record and go skiing.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.session.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Link href={`/day/${item.session.id}`} asChild>
          <Pressable style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>
                {formatDate(item.session.startedAt)}
                {item.session.resortTag ? ` · ${item.session.resortTag}` : ''}
              </Text>
            </View>
            <View style={styles.cardStats}>
              <Text style={styles.cardStat}>{formatVertical(item.verticalM)}</Text>
              <Text style={styles.cardStat}>{item.runCount} runs</Text>
              <Text style={styles.cardStat}>{formatSpeedKmh(item.maxSpeedKmh)} max</Text>
              <Text style={styles.cardStat}>{formatDistance(item.distanceM)}</Text>
            </View>
          </Pressable>
        </Link>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  empty: { fontSize: 18, fontWeight: '700', color: '#0b1d33' },
  emptySub: { fontSize: 14, color: '#64748b' },
  list: { padding: 16, gap: 12 },
  card: {
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  cardHeader: { marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#0b1d33' },
  cardStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cardStat: { fontSize: 14, color: '#334155' },
});
