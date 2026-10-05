import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import MapView, { Polyline } from 'react-native-maps';
import { getTrackPoints, type TrackPoint } from '../../../lib/db';
import { speedColor } from '../../../lib/format';

interface Chunk {
  coords: { latitude: number; longitude: number }[];
  color: string;
}

const MAX_CHUNKS = 120;

function buildChunks(points: TrackPoint[]): Chunk[] {
  if (points.length < 2) return [];
  const perChunk = Math.max(1, Math.ceil(points.length / MAX_CHUNKS));
  const chunks: Chunk[] = [];
  for (let i = 0; i < points.length - 1; i += perChunk) {
    const slice = points.slice(i, i + perChunk + 1);
    let speedSum = 0;
    let n = 0;
    const coords = slice.map((p) => {
      // derive speed from consecutive points where OS speed is missing
      return { latitude: p.lat, longitude: p.lon };
    });
    for (let j = 1; j < slice.length; j++) {
      const a = slice[j - 1];
      const b = slice[j];
      let kmh: number | null = null;
      if (b.speed != null && b.speed >= 0) kmh = b.speed * 3.6;
      else {
        const dt = (b.ts - a.ts) / 1000;
        if (dt > 0) {
          const dLat = ((b.lat - a.lat) * Math.PI) / 180;
          const dLon = ((b.lon - a.lon) * Math.PI) / 180;
          const h =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((a.lat * Math.PI) / 180) *
              Math.cos((b.lat * Math.PI) / 180) *
              Math.sin(dLon / 2) ** 2;
          kmh = ((2 * 6371000 * Math.asin(Math.sqrt(h))) / dt) * 3.6;
        }
      }
      if (kmh != null && kmh < 200) {
        speedSum += kmh;
        n++;
      }
    }
    chunks.push({ coords, color: speedColor(n > 0 ? speedSum / n : 0) });
  }
  return chunks;
}

export default function TrackMapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [points, setPoints] = useState<TrackPoint[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setPoints(await getTrackPoints(id));
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const chunks = useMemo(() => buildChunks(points), [points]);

  const region = useMemo(() => {
    if (points.length === 0) return undefined;
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    const pad = 1.3;
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2,
      latitudeDelta: Math.max(0.01, (maxLat - minLat) * pad),
      longitudeDelta: Math.max(0.01, (maxLon - minLon) * pad),
    };
  }, [points]);

  if (points.length === 0) {
    return (
      <View style={styles.center}>
        <Text>No track points.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView style={styles.map} initialRegion={region} mapType="standard">
        {chunks.map((c, i) => (
          <Polyline key={i} coordinates={c.coords} strokeColor={c.color} strokeWidth={4} />
        ))}
      </MapView>
      <View style={styles.legend}>
        <Text style={styles.legendText}>Blue slow → red fast</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  legend: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    backgroundColor: 'rgba(11,29,51,0.85)',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  legendText: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
