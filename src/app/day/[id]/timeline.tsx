import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  deleteTrackPointsInRange,
  getSegments,
  replaceSegments,
  type Segment,
  type SegmentKind,
} from '../../../lib/db';
import { formatDuration, formatTime } from '../../../lib/format';

const KIND_COLORS: Record<SegmentKind, string> = {
  run: '#22c55e',
  lift: '#94a3b8',
  stationary: '#e2e8f0',
  unclassified: '#f59e0b',
  ignored: '#1e293b',
};

const KINDS: SegmentKind[] = ['run', 'lift', 'stationary', 'unclassified', 'ignored'];

interface WorkSegment {
  key: string;
  kind: SegmentKind;
  startTs: number;
  endTs: number;
  label: string | null;
  manual: number;
  touched: boolean;
}

let tmpKey = 0;
const newKey = () => `tmp_${tmpKey++}`;

export default function TimelineEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [segs, setSegs] = useState<WorkSegment[]>([]);
  const [deletedRanges, setDeletedRanges] = useState<[number, number][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const dbSegs = await getSegments(id);
    setSegs(
      dbSegs.map((s: Segment) => ({
        key: String(s.id),
        kind: s.kind,
        startTs: s.startTs,
        endTs: s.endTs,
        label: s.label,
        manual: s.manual,
        touched: false,
      }))
    );
    setDeletedRanges([]);
    setSelected(null);
    setDirty(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const totalMs = useMemo(() => {
    if (segs.length === 0) return 1;
    return segs[segs.length - 1].endTs - segs[0].startTs;
  }, [segs]);

  const selectedSeg = segs.find((s) => s.key === selected) ?? null;
  const selectedIdx = segs.findIndex((s) => s.key === selected);

  const markDirty = (next: WorkSegment[]) => {
    setSegs(next);
    setDirty(true);
  };

  const onSplit = () => {
    if (!selectedSeg || selectedIdx < 0) return;
    const mid = Math.floor((selectedSeg.startTs + selectedSeg.endTs) / 2);
    const a: WorkSegment = { ...selectedSeg, endTs: mid, touched: true, manual: 1 };
    const b: WorkSegment = {
      ...selectedSeg,
      key: newKey(),
      startTs: mid,
      touched: true,
      manual: 1,
    };
    const next = [...segs];
    next.splice(selectedIdx, 1, a, b);
    markDirty(next);
    setSelected(b.key);
  };

  const onMergeNext = () => {
    if (!selectedSeg || selectedIdx < 0 || selectedIdx >= segs.length - 1) return;
    const next = segs[selectedIdx + 1];
    const merged: WorkSegment = {
      ...selectedSeg,
      endTs: next.endTs,
      touched: true,
      manual: 1,
    };
    const arr = [...segs];
    arr.splice(selectedIdx, 2, merged);
    markDirty(arr);
    setSelected(merged.key);
  };

  const onDelete = () => {
    if (!selectedSeg || selectedIdx < 0) return;
    Alert.alert('Delete segment?', 'Its track points will be removed too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setDeletedRanges((r) => [...r, [selectedSeg.startTs, selectedSeg.endTs]]);
          const arr = segs.filter((s) => s.key !== selectedSeg.key);
          markDirty(arr);
          setSelected(null);
        },
      },
    ]);
  };

  const onReclassify = (kind: SegmentKind) => {
    if (!selectedSeg || selectedIdx < 0) return;
    const arr = [...segs];
    arr[selectedIdx] = { ...selectedSeg, kind, touched: true, manual: 1 };
    markDirty(arr);
  };

  const onTrimStart = () => {
    if (!selectedSeg) return;
    const cutTs = selectedSeg.startTs;
    Alert.alert('Trim session start?', `Everything before ${formatTime(cutTs)} will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Trim',
        style: 'destructive',
        onPress: () => {
          const firstTs = segs[0].startTs;
          setDeletedRanges((r) => [...r, [firstTs, cutTs]]);
          markDirty(segs.filter((s) => s.endTs > cutTs));
          setSelected(null);
        },
      },
    ]);
  };

  const onTrimEnd = () => {
    if (!selectedSeg) return;
    const cutTs = selectedSeg.endTs;
    Alert.alert('Trim session end?', `Everything from ${formatTime(cutTs)} on will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Trim',
        style: 'destructive',
        onPress: () => {
          const lastTs = segs[segs.length - 1].endTs;
          setDeletedRanges((r) => [...r, [cutTs, lastTs]]);
          markDirty(segs.filter((s) => s.startTs < cutTs));
          setSelected(null);
        },
      },
    ]);
  };

  const onSave = async () => {
    if (!id) return;
    try {
      for (const [from, to] of deletedRanges) {
        if (to > from) await deleteTrackPointsInRange(id, from, to);
      }
      await replaceSegments(
        id,
        segs.map((s) => ({
          kind: s.kind,
          startTs: s.startTs,
          endTs: s.endTs,
          label: s.label,
          manual: s.manual,
        }))
      );
      router.back();
    } catch (e: any) {
      Alert.alert('Save failed', e.message ?? 'Unknown error');
    }
  };

  const onDiscard = () => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert('Discard changes?', 'All edits will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.hint}>
          Tap a block to select it, then split, merge, delete, reclassify, or trim the session.
        </Text>

        {/* timeline strip */}
        <View style={styles.strip}>
          {segs.map((s) => {
            const w = Math.max(2, ((s.endTs - s.startTs) / totalMs) * 100);
            return (
              <Pressable
                key={s.key}
                onPress={() => setSelected(s.key)}
                style={[
                  styles.block,
                  {
                    width: `${w}%`,
                    backgroundColor: KIND_COLORS[s.kind],
                    borderColor: selected === s.key ? '#0b1d33' : 'transparent',
                  },
                ]}
              />
            );
          })}
        </View>

        {/* legend */}
        <View style={styles.legend}>
          {KINDS.map((k) => (
            <View key={k} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: KIND_COLORS[k] }]} />
              <Text style={styles.legendText}>{k}</Text>
            </View>
          ))}
        </View>

        {selectedSeg ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>
              {selectedSeg.kind}
              {selectedSeg.label ? ` · ${selectedSeg.label}` : ''} ·{' '}
              {formatDuration(selectedSeg.endTs - selectedSeg.startTs)}
            </Text>
            <Text style={styles.panelSub}>
              {formatTime(selectedSeg.startTs)} – {formatTime(selectedSeg.endTs)}
            </Text>

            <View style={styles.btnRow}>
              <Pressable style={styles.btn} onPress={onSplit}>
                <Text style={styles.btnText}>Split</Text>
              </Pressable>
              <Pressable
                style={[styles.btn, selectedIdx >= segs.length - 1 && styles.btnDisabled]}
                onPress={onMergeNext}
                disabled={selectedIdx >= segs.length - 1}
              >
                <Text style={styles.btnText}>Merge next</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnDanger]} onPress={onDelete}>
                <Text style={styles.btnText}>Delete</Text>
              </Pressable>
            </View>

            <Text style={styles.miniTitle}>Reclassify as</Text>
            <View style={styles.btnRow}>
              {KINDS.map((k) => (
                <Pressable
                  key={k}
                  style={[styles.btn, selectedSeg.kind === k && styles.btnActive]}
                  onPress={() => onReclassify(k)}
                >
                  <Text style={styles.btnText}>{k}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.miniTitle}>Trim session</Text>
            <View style={styles.btnRow}>
              <Pressable style={styles.btn} onPress={onTrimStart}>
                <Text style={styles.btnText}>Start here</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={onTrimEnd}>
                <Text style={styles.btnText}>End here</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Text style={styles.muted}>Select a block above to edit it.</Text>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable style={[styles.footerBtn, styles.footerSecondary]} onPress={onDiscard}>
          <Text style={styles.footerBtnTextDark}>Discard</Text>
        </Pressable>
        <Pressable
          style={[styles.footerBtn, !dirty && styles.btnDisabled]}
          onPress={onSave}
          disabled={!dirty}
        >
          <Text style={styles.footerBtnText}>Save changes</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 16, gap: 12, paddingBottom: 24 },
  hint: { fontSize: 13, color: '#64748b' },
  strip: {
    flexDirection: 'row',
    height: 56,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
    overflow: 'hidden',
  },
  block: { height: '100%', borderWidth: 2 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: '#475569' },
  panel: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  panelTitle: { fontSize: 15, fontWeight: '700', color: '#0b1d33', textTransform: 'capitalize' },
  panelSub: { fontSize: 13, color: '#64748b' },
  miniTitle: { fontSize: 13, fontWeight: '600', color: '#475569', marginTop: 4 },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: {
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  btnActive: { backgroundColor: '#0b1d33' },
  btnDanger: { backgroundColor: '#fecaca' },
  btnDisabled: { opacity: 0.4 },
  btnText: { fontSize: 13, fontWeight: '600', color: '#0b1d33' },
  muted: { color: '#94a3b8', textAlign: 'center', marginTop: 12 },
  footer: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  footerBtn: {
    flex: 1,
    backgroundColor: '#0b1d33',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  footerSecondary: { backgroundColor: '#f1f5f9' },
  footerBtnText: { color: '#fff', fontWeight: '700' },
  footerBtnTextDark: { color: '#0b1d33', fontWeight: '700' },
});
