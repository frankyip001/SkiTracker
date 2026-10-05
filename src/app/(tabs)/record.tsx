import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  checkInterruptedSession,
  pauseRecording,
  resumeRecording,
  startRecording,
  stopRecording,
} from '../../lib/recorder';
import {
  getActiveSession,
  getOpenManualTimer,
  getTrackPoints,
  startManualTimer,
  stopManualTimer,
  upsertPersonalBest,
  getNamedRun,
} from '../../lib/db';
import { classify, segmentStats } from '../../lib/classifier';
import {
  formatDistance,
  formatDuration,
  formatRunTime,
  formatDelta,
  formatSpeedKmh,
  formatVertical,
} from '../../lib/format';

type Phase = 'idle' | 'recording' | 'paused';

interface LiveStats {
  speedKmh: number;
  maxSpeedKmh: number;
  verticalM: number;
  distanceM: number;
  runs: number;
  elapsedMs: number;
}

export default function RecordScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [interruptedId, setInterruptedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // manual run timer
  const [timerLabel, setTimerLabel] = useState('');
  const [openTimerId, setOpenTimerId] = useState<number | null>(null);
  const [openTimerStart, setOpenTimerStart] = useState<number | null>(null);
  const [timerElapsed, setTimerElapsed] = useState(0);
  const [lastTimerResult, setLastTimerResult] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshPhase = useCallback(async () => {
    const active = await getActiveSession();
    if (!active) {
      setPhase('idle');
      setSessionId(null);
      return;
    }
    setSessionId(active.id);
    setPhase(active.status === 'paused' ? 'paused' : 'recording');
    const openTimer = await getOpenManualTimer(active.id);
    setOpenTimerId(openTimer ? openTimer.id : null);
    setOpenTimerStart(openTimer ? openTimer.startTs : null);
    if (openTimer) setTimerLabel(openTimer.label);
  }, []);

  const pollStats = useCallback(async (sid: string) => {
    try {
      const points = await getTrackPoints(sid);
      if (points.length < 2) {
        setStats({ speedKmh: 0, maxSpeedKmh: 0, verticalM: 0, distanceM: 0, runs: 0, elapsedMs: 0 });
        return;
      }
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      const dt = (last.ts - prev.ts) / 1000;
      let speedKmh = 0;
      if (last.speed != null && last.speed >= 0) speedKmh = last.speed * 3.6;
      else if (dt > 0) {
        const dLat = ((last.lat - prev.lat) * Math.PI) / 180;
        const dLon = ((last.lon - prev.lon) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((prev.lat * Math.PI) / 180) *
            Math.cos((last.lat * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
        speedKmh = ((2 * 6371000 * Math.asin(Math.sqrt(a))) / dt) * 3.6;
      }
      const st = segmentStats(points, points[0].ts, last.ts + 1);
      const classified = classify(points);
      setStats({
        speedKmh,
        maxSpeedKmh: st.maxSpeedKmh,
        verticalM: st.verticalDescM,
        distanceM: st.distanceM,
        runs: classified.filter((s) => s.kind === 'run').length,
        elapsedMs: last.ts - points[0].ts,
      });
    } catch (e) {
      console.warn('[record] poll failed', e);
    }
  }, []);

  useEffect(() => {
    // Initial data load on mount: sync UI with any in-progress recording session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshPhase();
    checkInterruptedSession().then(setInterruptedId).catch(() => {});
  }, [refreshPhase]);

  useEffect(() => {
    // Live-stats polling while recording: subscription-style interval.
    if (phase === 'recording' && sessionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      pollStats(sessionId);
      pollRef.current = setInterval(() => pollStats(sessionId), 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase, sessionId, pollStats]);

  // manual timer tick
  useEffect(() => {
    if (openTimerStart == null) return;
    const t = setInterval(() => setTimerElapsed(Date.now() - openTimerStart), 500);
    return () => clearInterval(t);
  }, [openTimerStart]);

  const onStart = async () => {
    setBusy(true);
    try {
      const id = await startRecording();
      setSessionId(id);
      setPhase('recording');
      setLastTimerResult(null);
    } catch (e: any) {
      Alert.alert('Could not start', e.message ?? 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const onPause = async () => {
    setBusy(true);
    try {
      await pauseRecording();
      setPhase('paused');
    } finally {
      setBusy(false);
    }
  };

  const onResume = async () => {
    setBusy(true);
    try {
      await resumeRecording();
      setPhase('recording');
    } catch (e: any) {
      Alert.alert('Could not resume', e.message ?? 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    Alert.alert('Stop recording?', 'This ends the ski day and opens the summary.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            const id = await stopRecording();
            setPhase('idle');
            setSessionId(null);
            router.push(`/day/${id}`);
          } catch (e: any) {
            Alert.alert('Could not stop', e.message ?? 'Unknown error');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const onResumeInterrupted = async () => {
    setBusy(true);
    try {
      await resumeRecording();
      setInterruptedId(null);
      await refreshPhase();
    } catch (e: any) {
      Alert.alert('Could not resume', e.message ?? 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const onStartTimer = async () => {
    if (!sessionId) return;
    const label = timerLabel.trim() || 'Run';
    try {
      const id = await startManualTimer(sessionId, label, Date.now());
      setOpenTimerId(id);
      setOpenTimerStart(Date.now());
      setLastTimerResult(null);
    } catch (e: any) {
      Alert.alert('Timer failed', e.message ?? 'Unknown error');
    }
  };

  const onStopTimer = async () => {
    if (openTimerId == null || openTimerStart == null || !sessionId) return;
    const endTs = Date.now();
    const durationMs = endTs - openTimerStart;
    const label = timerLabel.trim() || 'Run';
    await stopManualTimer(openTimerId, endTs);
    setOpenTimerId(null);
    setOpenTimerStart(null);
    // personal best bookkeeping (FR-4.3)
    const prevBest = await getNamedRun(label);
    const isBest = await upsertPersonalBest(label, durationMs, sessionId, endTs);
    const delta =
      prevBest && !isBest ? ` (${formatDelta(durationMs - prevBest.bestDurationMs)} vs best)` : '';
    const best = isBest ? ' — new personal best!' : '';
    setLastTimerResult(`${label}: ${formatRunTime(durationMs)}${delta}${best}`);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {interruptedId && phase === 'idle' && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            The app was closed during a recording session.
          </Text>
          <Pressable style={styles.bannerBtn} onPress={onResumeInterrupted} disabled={busy}>
            <Text style={styles.bannerBtnText}>Resume session</Text>
          </Pressable>
        </View>
      )}

      <Pressable
        style={[styles.bigButton, phase === 'recording' && styles.bigButtonRecording]}
        onPress={phase === 'idle' ? onStart : onStop}
        onLongPress={phase === 'recording' ? onPause : undefined}
        disabled={busy || phase === 'paused'}
      >
        <Text style={styles.bigButtonText}>
          {phase === 'idle' ? '● REC' : phase === 'recording' ? '■ STOP' : '❚❚ PAUSED'}
        </Text>
        <Text style={styles.bigButtonSub}>
          {phase === 'idle'
            ? 'Start ski day'
            : phase === 'recording'
              ? 'Tap to stop · long-press to pause'
              : 'Paused'}
        </Text>
      </Pressable>

      {phase === 'paused' && (
        <View style={styles.row}>
          <Pressable style={styles.actionBtn} onPress={onResume} disabled={busy}>
            <Text style={styles.actionBtnText}>Resume</Text>
          </Pressable>
          <Pressable style={[styles.actionBtn, styles.stopBtn]} onPress={onStop} disabled={busy}>
            <Text style={styles.actionBtnText}>Stop</Text>
          </Pressable>
        </View>
      )}

      {stats && phase !== 'idle' && (
        <View style={styles.grid}>
          <Stat label="Speed" value={formatSpeedKmh(stats.speedKmh)} big />
          <Stat label="Max speed" value={formatSpeedKmh(stats.maxSpeedKmh)} />
          <Stat label="Vertical" value={formatVertical(stats.verticalM)} />
          <Stat label="Distance" value={formatDistance(stats.distanceM)} />
          <Stat label="Runs" value={String(stats.runs)} />
          <Stat label="Time" value={formatDuration(stats.elapsedMs)} />
        </View>
      )}

      {phase !== 'idle' && (
        <View style={styles.timerBox}>
          <Text style={styles.sectionTitle}>Run timer</Text>
          <TextInput
            style={styles.input}
            placeholder="Run label (e.g. Collins)"
            value={timerLabel}
            onChangeText={setTimerLabel}
            editable={openTimerId == null}
          />
          {openTimerId == null ? (
            <Pressable style={styles.actionBtn} onPress={onStartTimer}>
              <Text style={styles.actionBtnText}>Time this run</Text>
            </Pressable>
          ) : (
            <View>
              <Text style={styles.timerElapsed}>{formatRunTime(timerElapsed)}</Text>
              <Pressable style={[styles.actionBtn, styles.stopBtn]} onPress={onStopTimer}>
                <Text style={styles.actionBtnText}>Stop timer</Text>
              </Pressable>
            </View>
          )}
          {lastTimerResult && <Text style={styles.result}>{lastTimerResult}</Text>}
        </View>
      )}
    </ScrollView>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <View style={[styles.stat, big && styles.statBig]}>
      <Text style={[styles.statValue, big && styles.statValueBig]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  banner: {
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  bannerText: { fontSize: 14, color: '#92400e' },
  bannerBtn: {
    backgroundColor: '#d97706',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
  },
  bannerBtnText: { color: '#fff', fontWeight: '600' },
  bigButton: {
    backgroundColor: '#dc2626',
    borderRadius: 100,
    width: 200,
    height: 200,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigButtonRecording: { backgroundColor: '#16a34a' },
  bigButtonText: { color: '#fff', fontSize: 32, fontWeight: '800' },
  bigButtonSub: { color: '#fff', fontSize: 12, marginTop: 6, opacity: 0.9, textAlign: 'center', paddingHorizontal: 20 },
  row: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  actionBtn: {
    backgroundColor: '#0b1d33',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginTop: 8,
  },
  stopBtn: { backgroundColor: '#dc2626' },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: {
    backgroundColor: '#f1f5f9',
    borderRadius: 12,
    padding: 12,
    width: '31%',
    alignItems: 'center',
  },
  statBig: { width: '100%' },
  statValue: { fontSize: 18, fontWeight: '700', color: '#0b1d33' },
  statValueBig: { fontSize: 34 },
  statLabel: { fontSize: 12, color: '#64748b', marginTop: 2 },
  timerBox: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#0b1d33' },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
  },
  timerElapsed: { fontSize: 40, fontWeight: '800', textAlign: 'center', color: '#0b1d33' },
  result: { fontSize: 14, color: '#166534', fontWeight: '600', textAlign: 'center' },
});
