import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  createSession,
  getActiveSession,
  getSession,
  insertTrackPoint,
  updateSessionStatus,
  replaceSegments,
  getTrackPoints,
} from './db';
import { classify } from './classifier';

export const LOCATION_TASK = 'ski-tracker-bg-location';

/** Adaptive sampling regimes (FR-2.1). Interval = ms between GPS fixes. */
const REGIMES = {
  moving: { timeInterval: 1000, distanceInterval: 3 }, // skiing
  lift: { timeInterval: 5000, distanceInterval: 10 }, // on a lift
  stationary: { timeInterval: 30000, distanceInterval: 25 }, // stopped
} as const;

type Regime = keyof typeof REGIMES;

const MAX_ACCURACY_M = 25; // FR-2.3: discard fixes worse than 25 m

let currentRegime: Regime | null = null;
let currentSessionId: string | null = null;

function regimeForSpeedKmh(speedKmh: number): Regime {
  if (speedKmh < 2) return 'stationary';
  if (speedKmh <= 20) return 'lift';
  return 'moving';
}

async function applyRegime(regime: Regime): Promise<void> {
  if (regime === currentRegime) return;
  currentRegime = regime;
  const r = REGIMES[regime];
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: r.timeInterval,
    distanceInterval: r.distanceInterval,
    // iOS: let the OS defer delivery while backgrounded to save battery
    deferredUpdatesInterval: r.timeInterval,
    deferredUpdatesDistance: r.distanceInterval,
    activityType: Location.ActivityType.Fitness,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Ski Tracker',
      notificationBody: 'Recording your ski day…',
    },
  });
}

// Must be defined at top-level scope so the OS can wake it.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[recorder] background task error', error);
    return;
  }
  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;

  // Resolve the session inside the task — robust across JS contexts.
  if (!currentSessionId) {
    const active = await getActiveSession();
    if (!active || active.status !== 'recording') return;
    currentSessionId = active.id;
  }

  let lastSpeedKmh = 0;
  for (const loc of locations) {
    const { latitude, longitude, altitude, speed, accuracy } = loc.coords;
    if (accuracy != null && accuracy > MAX_ACCURACY_M) continue; // FR-2.3
    const speedKmh = speed != null && speed >= 0 ? speed * 3.6 : 0;
    lastSpeedKmh = speedKmh;
    await insertTrackPoint({
      sessionId: currentSessionId,
      ts: loc.timestamp,
      lat: latitude,
      lon: longitude,
      altitude: altitude ?? null,
      speed: speed ?? null,
      accuracy: accuracy ?? null,
    });
  }

  // Adaptive sampling: only restart updates when the regime changes.
  try {
    await applyRegime(regimeForSpeedKmh(lastSpeedKmh));
  } catch (e) {
    console.warn('[recorder] regime switch failed', e);
  }
});

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** Request foreground then background location permission. Returns background status. */
export async function ensurePermissions(): Promise<PermissionState> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'denied';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'denied';
  return 'granted';
}

export async function hasPermissions(): Promise<boolean> {
  const fg = await Location.getForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();
  return fg.status === 'granted' && bg.status === 'granted';
}

function newSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function startRecording(): Promise<string> {
  const existing = await getActiveSession();
  if (existing) throw new Error('A session is already active');
  const perm = await ensurePermissions();
  if (perm !== 'granted') throw new Error('Location permission not granted');
  const id = newSessionId();
  await createSession(id, Date.now());
  currentSessionId = id;
  currentRegime = null;
  await applyRegime('moving'); // starts the background task
  return id;
}

export async function pauseRecording(): Promise<void> {
  const active = await getActiveSession();
  if (!active) return;
  await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
  currentRegime = null;
  await updateSessionStatus(active.id, 'paused');
}

export async function resumeRecording(): Promise<void> {
  const active = await getActiveSession();
  if (!active || active.status !== 'paused') throw new Error('No paused session to resume');
  const perm = await hasPermissions();
  if (!perm) throw new Error('Location permission not granted');
  currentSessionId = active.id;
  currentRegime = null;
  await updateSessionStatus(active.id, 'recording');
  await applyRegime('moving');
}

export async function stopRecording(): Promise<string> {
  const active = await getActiveSession();
  if (!active) throw new Error('No active session');
  await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
  currentRegime = null;
  currentSessionId = null;
  const endedAt = Date.now();
  await updateSessionStatus(active.id, 'done', endedAt);
  // Auto-classify the day's trace into runs/lifts (FR-3).
  try {
    const points = await getTrackPoints(active.id);
    const classified = classify(points);
    await replaceSegments(
      active.id,
      classified.map((s) => ({ kind: s.kind, startTs: s.startTs, endTs: s.endTs, label: null, manual: 0 }))
    );
  } catch (e) {
    console.warn('[recorder] auto-classify failed', e);
  }
  return active.id;
}

/** FR-1.3: detect an interrupted session (e.g. OS killed the app) needing resume. */
export async function checkInterruptedSession(): Promise<string | null> {
  const active = await getActiveSession();
  if (!active || active.status !== 'recording') return null;
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  return running ? null : active.id;
}

export async function isRecordingNow(): Promise<boolean> {
  const active = await getActiveSession();
  if (!active || active.status !== 'recording') return false;
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

export async function getSessionStatus(id: string) {
  return getSession(id);
}
