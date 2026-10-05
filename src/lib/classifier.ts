import type { TrackPoint, SegmentKind } from './db';

/**
 * Run/lift classifier (FR-3).
 *
 * Classifies a GPS trace into runs, lifts, stationary periods and
 * unclassified segments using speed + vertical-rate signatures over
 * sliding windows. All thresholds live in ClassifierParams so the
 * model can be tuned on real on-hill data later.
 */

export interface ClassifierParams {
  /** minimum mean speed for a run window (km/h) */
  minRunSpeedKmh: number;
  /** maximum mean speed for a lift window (km/h) */
  maxLiftSpeedKmh: number;
  /** vertical rate below which a window counts as downhill (m/s, negative) */
  downhillRateThreshold: number;
  /** vertical rate above which a window counts as uphill (m/s, positive) */
  uphillRateThreshold: number;
  /** mean speed below which a window counts as stationary (km/h) */
  stationarySpeedKmh: number;
  /** classification window length (s) */
  windowSeconds: number;
  /** segments shorter than this are absorbed into neighbours (s) */
  minSegmentSeconds: number;
  /** stationary gap inside a run that does NOT split it (s) */
  maxStopInRunSeconds: number;
}

export const DEFAULT_PARAMS: ClassifierParams = {
  minRunSpeedKmh: 10,
  maxLiftSpeedKmh: 20,
  downhillRateThreshold: -1.0,
  uphillRateThreshold: 0.3,
  stationarySpeedKmh: 2,
  windowSeconds: 15,
  minSegmentSeconds: 45,
  maxStopInRunSeconds: 60,
};

export interface ClassifiedSegment {
  kind: SegmentKind;
  startTs: number;
  endTs: number;
}

interface EnrichedPoint {
  ts: number;
  lat: number;
  lon: number;
  alt: number; // smoothed altitude (m)
  speedKmh: number;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Enrich raw points: derive speed where missing, smooth altitude. */
function enrich(points: TrackPoint[]): EnrichedPoint[] {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const out: EnrichedPoint[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    let speedKmh: number;
    if (p.speed != null && p.speed >= 0) {
      speedKmh = p.speed * 3.6;
    } else if (i > 0) {
      const prev = sorted[i - 1];
      const dt = (p.ts - prev.ts) / 1000;
      speedKmh = dt > 0 ? (haversineM(prev.lat, prev.lon, p.lat, p.lon) / dt) * 3.6 : 0;
    } else {
      speedKmh = 0;
    }
    out.push({ ts: p.ts, lat: p.lat, lon: p.lon, alt: p.altitude ?? 0, speedKmh });
  }
  // moving-average altitude smoothing (window 5) to tame baro/GPS noise
  const smoothed = out.map((pt, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(out.length - 1, i + 2); j++) {
      sum += out[j].alt;
      n++;
    }
    return { ...pt, alt: sum / n };
  });
  return smoothed;
}

type WindowLabel = 'run' | 'lift' | 'stationary' | 'unclassified';

function labelWindow(
  pts: EnrichedPoint[],
  bearings: number[],
  params: ClassifierParams
): WindowLabel {
  if (pts.length === 0) return 'unclassified';
  const meanSpeed = pts.reduce((s, p) => s + p.speedKmh, 0) / pts.length;
  const dt = (pts[pts.length - 1].ts - pts[0].ts) / 1000;
  const vertRate = dt > 0 ? (pts[pts.length - 1].alt - pts[0].alt) / dt : 0;

  if (meanSpeed < params.stationarySpeedKmh) return 'stationary';
  if (vertRate < params.downhillRateThreshold && meanSpeed >= params.minRunSpeedKmh) return 'run';
  if (vertRate > params.uphillRateThreshold && meanSpeed <= params.maxLiftSpeedKmh) return 'lift';

  // soft signal: steady heading + slight uphill but slow => likely a surface lift
  if (bearings.length > 2 && meanSpeed <= params.maxLiftSpeedKmh) {
    const mean = bearings.reduce((s, b) => s + b, 0) / bearings.length;
    const variance = bearings.reduce((s, b) => s + (b - mean) ** 2, 0) / bearings.length;
    if (variance < 400 && vertRate > 0) return 'lift';
  }
  return 'unclassified';
}

/** Debug helper: returns the raw per-window labels (useful when tuning). */
export function classifyWindows(
  points: TrackPoint[],
  params: ClassifierParams = DEFAULT_PARAMS
): { label: string; startTs: number; endTs: number }[] {
  const pts = enrich(points).filter((p) => p.ts > 0);
  if (pts.length < 2) return [];
  const winMs = params.windowSeconds * 1000;
  const start = pts[0].ts;
  const end = pts[pts.length - 1].ts;
  const out: { label: string; startTs: number; endTs: number }[] = [];
  for (let wStart = start; wStart < end; wStart += winMs) {
    const wEnd = wStart + winMs;
    const wPts = pts.filter((p) => p.ts >= wStart && p.ts < wEnd);
    if (wPts.length < 2) {
      out.push({ label: '(skipped)', startTs: wStart, endTs: wEnd });
      continue;
    }
    const bearings: number[] = [];
    for (let i = 1; i < wPts.length; i++) {
      bearings.push(bearingDeg(wPts[i - 1].lat, wPts[i - 1].lon, wPts[i].lat, wPts[i].lon));
    }
    out.push({ label: labelWindow(wPts, bearings, params), startTs: wStart, endTs: wEnd });
  }
  return out;
}

export function classify(
  points: TrackPoint[],
  params: ClassifierParams = DEFAULT_PARAMS
): ClassifiedSegment[] {
  const pts = enrich(points).filter((p) => p.ts > 0);
  if (pts.length < 2) return [];

  // 1. window the trace
  const winMs = params.windowSeconds * 1000;
  const start = pts[0].ts;
  const end = pts[pts.length - 1].ts;
  const windows: { label: WindowLabel; startTs: number; endTs: number }[] = [];
  for (let wStart = start; wStart < end; wStart += winMs) {
    const wEnd = wStart + winMs;
    const wPts = pts.filter((p) => p.ts >= wStart && p.ts < wEnd);
    if (wPts.length < 2) continue;
    const bearings: number[] = [];
    for (let i = 1; i < wPts.length; i++) {
      bearings.push(bearingDeg(wPts[i - 1].lat, wPts[i - 1].lon, wPts[i].lat, wPts[i].lon));
    }
    windows.push({ label: labelWindow(wPts, bearings, params), startTs: wStart, endTs: wEnd });
  }
  if (windows.length === 0) return [];

  // 2. merge consecutive same-label windows
  const merged: ClassifiedSegment[] = [];
  let cur = { kind: windows[0].label as SegmentKind, startTs: windows[0].startTs, endTs: windows[0].endTs };
  for (let i = 1; i < windows.length; i++) {
    const w = windows[i];
    if (w.label === cur.kind) {
      cur.endTs = w.endTs;
    } else {
      merged.push(cur);
      cur = { kind: w.label as SegmentKind, startTs: w.startTs, endTs: w.endTs };
    }
  }
  merged.push(cur);

  // 3. absorb stationary/unclassified gaps inside runs (mid-run stops).
  //    A maximal run of gap segments between two runs is absorbed when the
  //    total gap duration is within maxStopInRunSeconds.
  const maxGapMs = params.maxStopInRunSeconds * 1000;
  const isGap = (k: SegmentKind) => k === 'stationary' || k === 'unclassified';
  const pass1: ClassifiedSegment[] = [];
  let i = 0;
  while (i < merged.length) {
    const seg = merged[i];
    const prev = pass1[pass1.length - 1];
    if (prev && prev.kind === 'run' && isGap(seg.kind)) {
      // collect the maximal gap run
      let j = i;
      let gapEnd = seg.endTs;
      while (j + 1 < merged.length && isGap(merged[j + 1].kind)) {
        j++;
        gapEnd = merged[j].endTs;
      }
      const next = merged[j + 1];
      if (next && next.kind === 'run' && gapEnd - seg.startTs <= maxGapMs) {
        prev.endTs = next.endTs; // absorb gap + next run
        i = j + 2;
        continue;
      }
    }
    pass1.push(seg);
    i++;
  }

  // 4. absorb tiny segments into the longer neighbour
  const minMs = params.minSegmentSeconds * 1000;
  const pass2: ClassifiedSegment[] = [];
  for (const seg of pass1) {
    const prev = pass2[pass2.length - 1];
    if (prev && seg.endTs - seg.startTs < minMs) {
      // extend whichever neighbour is longer; default to previous
      prev.endTs = seg.endTs;
    } else {
      pass2.push({ ...seg });
    }
  }

  return pass2;
}

/** Compute headline stats for points within [startTs, endTs). */
export function segmentStats(points: TrackPoint[], startTs: number, endTs: number) {
  const pts = points.filter((p) => p.ts >= startTs && p.ts < endTs).sort((a, b) => a.ts - b.ts);
  let distanceM = 0;
  let verticalDescM = 0;
  let maxSpeedKmh = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    distanceM += haversineM(a.lat, a.lon, b.lat, b.lon);
    if (a.altitude != null && b.altitude != null && b.altitude < a.altitude) {
      verticalDescM += a.altitude - b.altitude;
    }
    const dt = (b.ts - a.ts) / 1000;
    if (dt > 0) {
      const s = (haversineM(a.lat, a.lon, b.lat, b.lon) / dt) * 3.6;
      if (s > maxSpeedKmh) maxSpeedKmh = s;
    }
  }
  return {
    distanceM,
    verticalDescM,
    maxSpeedKmh,
    durationMs: pts.length > 1 ? pts[pts.length - 1].ts - pts[0].ts : 0,
    pointCount: pts.length,
  };
}
