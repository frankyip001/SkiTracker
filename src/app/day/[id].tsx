import { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  deleteSession,
  getManualTimers,
  getSession,
  setSessionResortTag,
  updateSegmentLabel,
  upsertPersonalBest,
  getNamedRun,
  type ManualTimer,
  type Session,
} from '../../lib/db';
import { computeDayStats, type DayStats } from '../../lib/dayStats';
import { exportSessionGpx } from '../../lib/gpx';
import { getTrackPoints } from '../../lib/db';
import {
  formatDate,
  formatDelta,
  formatDistance,
  formatDuration,
  formatRunTime,
  formatSpeedKmh,
  formatTime,
  formatVertical,
} from '../../lib/format';

export default function DayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [stats, setStats] = useState<DayStats | null>(null);
  const [timers, setTimers] = useState<ManualTimer[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [editingRun, setEditingRun] = useState<number | null>(null);
  const [labelInput, setLabelInput] = useState('');
  const [pbInfo, setPbInfo] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    if (!id) return;
    const s = await getSession(id);
    setSession(s);
    if (!s) return;
    setTagInput(s.resortTag ?? '');
    const st = await computeDayStats(id);
    setStats(st);
    setTimers(await getManualTimers(id));
    // personal-best deltas for labeled runs
    const info: Record<number, string> = {};
    for (const r of st.runs) {
      if (r.segment.label) {
        const best = await getNamedRun(r.segment.label);
        if (best && best.bestSessionId !== id) {
          info[r.segment.id] = formatDelta(r.durationMs - best.bestDurationMs);
        } else if (best && best.bestSessionId === id) {
          info[r.segment.id] = 'PB';
        }
      }
    }
    setPbInfo(info);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onSaveLabel = async (segmentId: number, durationMs: number) => {
    const label = labelInput.trim();
    if (!id) return;
    // eslint-disable-next-line react-hooks/purity -- event handler, not render
    const now = Date.now();
    await updateSegmentLabel(id, segmentId, label || null);
    if (label) {
      await upsertPersonalBest(label, durationMs, id, now);
    }
    setEditingRun(null);
    setLabelInput('');
    load();
  };

  const onExport = async () => {
    if (!id || !session) return;
    try {
      const points = await getTrackPoints(id);
      await exportSessionGpx(id, points, `Ski day ${formatDate(session.startedAt)}`);
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? 'Unknown error');
    }
  };

  const onDelete = () => {
    Alert.alert('Delete this ski day?', 'The track and all stats will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (id) await deleteSession(id);
          router.replace('/(tabs)/history');
        },
      },
    ]);
  };

  if (!session || !stats) {
    return (
      <View style={styles.center}>
        <Text>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {formatDate(session.startedAt)}
        {session.resortTag ? ` · ${session.resortTag}` : ''}
      </Text>
      <Text style={styles.sub}>
        {formatTime(session.startedAt)}
        {session.endedAt ? ` – ${formatTime(session.endedAt)}` : ''} · {stats.pointCount.toLocaleString()} points
      </Text>

      <View style={styles.grid}>
        <Stat label="Vertical" value={formatVertical(stats.verticalM)} />
        <Stat label="Runs" value={String(stats.runCount)} />
        <Stat label="Max speed" value={formatSpeedKmh(stats.maxSpeedKmh)} />
        <Stat label="Distance" value={formatDistance(stats.distanceM)} />
        <Stat label="Lifts" value={String(stats.liftCount)} />
        <Stat label="Time" value={formatDuration(stats.elapsedMs)} />
      </View>

      <Text style={styles.sectionTitle}>Runs</Text>
      {stats.runs.length === 0 && <Text style={styles.muted}>No runs detected.</Text>}
      {stats.runs.map((r, i) => (
        <View key={r.segment.id} style={styles.runRow}>
          <View style={styles.runMain}>
            <Text style={styles.runTitle}>
              Run {i + 1}
              {r.segment.label ? ` · ${r.segment.label}` : ''}
              {pbInfo[r.segment.id] ? `  (${pbInfo[r.segment.id]})` : ''}
            </Text>
            <Text style={styles.runSub}>
              {formatRunTime(r.durationMs)} · {formatSpeedKmh(r.maxSpeedKmh)} max ·{' '}
              {formatVertical(r.verticalDescM)}
            </Text>
          </View>
          {editingRun === r.segment.id ? (
            <View style={styles.labelEdit}>
              <TextInput
                style={styles.input}
                placeholder="Name this run"
                value={labelInput}
                onChangeText={setLabelInput}
                autoFocus
              />
              <Pressable
                style={styles.smallBtn}
                onPress={() => onSaveLabel(r.segment.id, r.durationMs)}
              >
                <Text style={styles.smallBtnText}>Save</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={styles.smallBtn}
              onPress={() => {
                setEditingRun(r.segment.id);
                setLabelInput(r.segment.label ?? '');
              }}
            >
              <Text style={styles.smallBtnText}>{r.segment.label ? 'Rename' : 'Label'}</Text>
            </Pressable>
          )}
        </View>
      ))}

      {timers.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Manual timers</Text>
          {timers.map((t) => (
            <View key={t.id} style={styles.runRow}>
              <Text style={styles.runTitle}>{t.label}</Text>
              <Text style={styles.runSub}>
                {t.endTs ? formatRunTime(t.endTs - t.startTs) : 'running…'}
              </Text>
            </View>
          ))}
        </>
      )}

      <Text style={styles.sectionTitle}>Actions</Text>
      <View style={styles.actions}>
        <Link href={`/day/${id}/timeline`} asChild>
          <Pressable style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>Edit timeline</Text>
          </Pressable>
        </Link>
        <Link href={`/day/${id}/map`} asChild>
          <Pressable style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>View map</Text>
          </Pressable>
        </Link>
        <Pressable style={styles.actionBtn} onPress={onExport}>
          <Text style={styles.actionBtnText}>Export GPX</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Resort tag</Text>
      <View style={styles.tagRow}>
        <TextInput
          style={[styles.input, styles.tagInput]}
          placeholder="e.g. Cypress"
          value={tagInput}
          onChangeText={setTagInput}
        />
        <Pressable
          style={styles.smallBtn}
          onPress={async () => {
            if (id) {
              await setSessionResortTag(id, tagInput.trim() || null);
              load();
            }
          }}
        >
          <Text style={styles.smallBtnText}>Save</Text>
        </Pressable>
      </View>

      <Pressable style={[styles.actionBtn, styles.deleteBtn]} onPress={onDelete}>
        <Text style={styles.actionBtnText}>Delete ski day</Text>
      </Pressable>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: '#0b1d33' },
  sub: { fontSize: 13, color: '#64748b' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: {
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
    padding: 12,
    width: '31%',
    alignItems: 'center',
  },
  statValue: { fontSize: 17, fontWeight: '700', color: '#0b1d33' },
  statLabel: { fontSize: 12, color: '#64748b', marginTop: 2 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#0b1d33', marginTop: 8 },
  muted: { color: '#64748b' },
  runRow: {
    backgroundColor: '#f8fafc',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    gap: 6,
  },
  runMain: { gap: 2 },
  runTitle: { fontSize: 15, fontWeight: '700', color: '#0b1d33' },
  runSub: { fontSize: 13, color: '#475569' },
  labelEdit: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 8,
    fontSize: 15,
    flex: 1,
    backgroundColor: '#fff',
  },
  smallBtn: {
    backgroundColor: '#0b1d33',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  smallBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionBtn: {
    backgroundColor: '#0b1d33',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  deleteBtn: { backgroundColor: '#dc2626', marginTop: 4 },
  tagRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  tagInput: { flex: 1 },
});
