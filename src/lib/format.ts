export function formatDuration(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Run-time display per BRD: m:ss (FR-4.4). */
export function formatRunTime(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, '0')}`;
}

export function formatSpeedKmh(kmh: number): string {
  return `${kmh.toFixed(0)} km/h`;
}

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export function formatVertical(m: number): string {
  return `${Math.round(m).toLocaleString('en-US')} m`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Signed delta, e.g. "-0:07" / "+0:12" for personal-best comparisons. */
export function formatDelta(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  return `${sign}${formatRunTime(Math.abs(ms))}`;
}

/** Map speed (km/h) to a color for the track polyline (slow=blue → fast=red). */
export function speedColor(kmh: number): string {
  if (kmh < 10) return '#3b82f6';
  if (kmh < 25) return '#22c55e';
  if (kmh < 45) return '#eab308';
  if (kmh < 65) return '#f97316';
  return '#ef4444';
}
