import { getTrackPoints, getSegments, type Segment } from './db';
import { segmentStats } from './classifier';

export interface RunSummary {
  segment: Segment;
  durationMs: number;
  distanceM: number;
  verticalDescM: number;
  maxSpeedKmh: number;
}

export interface DayStats {
  verticalM: number;
  distanceM: number;
  maxSpeedKmh: number;
  runCount: number;
  liftCount: number;
  elapsedMs: number;
  pointCount: number;
  runs: RunSummary[];
}

/** Headline stats for a session. Ignored segments are excluded. */
export async function computeDayStats(sessionId: string): Promise<DayStats> {
  const [points, segments] = await Promise.all([
    getTrackPoints(sessionId),
    getSegments(sessionId),
  ]);
  const active = segments.filter((s) => s.kind !== 'ignored');
  const runs = active.filter((s) => s.kind === 'run');

  let verticalM = 0;
  let distanceM = 0;
  let maxSpeedKmh = 0;
  const runSummaries: RunSummary[] = [];

  for (const seg of active) {
    const st = segmentStats(points, seg.startTs, seg.endTs);
    verticalM += st.verticalDescM;
    distanceM += st.distanceM;
    if (st.maxSpeedKmh > maxSpeedKmh) maxSpeedKmh = st.maxSpeedKmh;
    if (seg.kind === 'run') {
      runSummaries.push({
        segment: seg,
        durationMs: st.durationMs,
        distanceM: st.distanceM,
        verticalDescM: st.verticalDescM,
        maxSpeedKmh: st.maxSpeedKmh,
      });
    }
  }

  const elapsedMs =
    points.length > 1 ? points[points.length - 1].ts - points[0].ts : 0;

  return {
    verticalM,
    distanceM,
    maxSpeedKmh,
    runCount: runs.length,
    liftCount: active.filter((s) => s.kind === 'lift').length,
    elapsedMs,
    pointCount: points.length,
    runs: runSummaries,
  };
}
