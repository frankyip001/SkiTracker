import * as SQLite from 'expo-sqlite';

export type SessionStatus = 'recording' | 'paused' | 'done';

export interface Session {
  id: string;
  startedAt: number; // epoch ms
  endedAt: number | null;
  resortTag: string | null;
  status: SessionStatus;
}

export interface TrackPoint {
  id: number;
  sessionId: string;
  ts: number; // epoch ms
  lat: number;
  lon: number;
  altitude: number | null; // meters
  speed: number | null; // m/s (as reported by OS, may be null)
  accuracy: number | null; // meters
}

export type SegmentKind = 'run' | 'lift' | 'stationary' | 'unclassified' | 'ignored';

export interface Segment {
  id: number;
  sessionId: string;
  kind: SegmentKind;
  startTs: number;
  endTs: number;
  label: string | null;
  manual: number; // 1 = user edited, 0 = auto
}

export interface NamedRun {
  id: number;
  name: string;
  bestDurationMs: number;
  bestSessionId: string;
  bestTs: number;
}

export interface ManualTimer {
  id: number;
  sessionId: string;
  label: string;
  startTs: number;
  endTs: number | null;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('skitracker.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          resort_tag TEXT,
          status TEXT NOT NULL DEFAULT 'recording'
        );
        CREATE TABLE IF NOT EXISTS track_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          altitude REAL,
          speed REAL,
          accuracy REAL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_points_session_ts ON track_points(session_id, ts);
        CREATE TABLE IF NOT EXISTS segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER NOT NULL,
          label TEXT,
          manual INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id, start_ts);
        CREATE TABLE IF NOT EXISTS named_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          best_duration_ms INTEGER NOT NULL,
          best_session_id TEXT NOT NULL,
          best_ts INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS manual_timers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          label TEXT NOT NULL,
          start_ts INTEGER NOT NULL,
          end_ts INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
      `);
      return db;
    })();
  }
  return dbPromise;
}

// ---------- sessions ----------

export async function createSession(id: string, startedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO sessions (id, started_at, status) VALUES (?, ?, ?)',
    id,
    startedAt,
    'recording'
  );
}

export async function getSession(id: string): Promise<Session | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>('SELECT * FROM sessions WHERE id = ?', id);
  return row ? mapSession(row) : null;
}

export async function getActiveSession(): Promise<Session | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    "SELECT * FROM sessions WHERE status IN ('recording','paused') ORDER BY started_at DESC LIMIT 1"
  );
  return row ? mapSession(row) : null;
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    "SELECT * FROM sessions WHERE status = 'done' ORDER BY started_at DESC"
  );
  return rows.map(mapSession);
}

export async function updateSessionStatus(
  id: string,
  status: SessionStatus,
  endedAt: number | null = null
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?', status, endedAt, id);
}

export async function setSessionResortTag(id: string, tag: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sessions SET resort_tag = ? WHERE id = ?', tag, id);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM track_points WHERE session_id = ?', id);
  await db.runAsync('DELETE FROM segments WHERE session_id = ?', id);
  await db.runAsync('DELETE FROM manual_timers WHERE session_id = ?', id);
  await db.runAsync('DELETE FROM sessions WHERE id = ?', id);
}

function mapSession(row: any): Session {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    resortTag: row.resort_tag ?? null,
    status: row.status,
  };
}

// ---------- track points ----------

export async function insertTrackPoint(p: Omit<TrackPoint, 'id'>): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO track_points (session_id, ts, lat, lon, altitude, speed, accuracy) VALUES (?,?,?,?,?,?,?)',
    p.sessionId,
    p.ts,
    p.lat,
    p.lon,
    p.altitude,
    p.speed,
    p.accuracy
  );
}

export async function getTrackPoints(sessionId: string): Promise<TrackPoint[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM track_points WHERE session_id = ? ORDER BY ts ASC',
    sessionId
  );
  return rows.map((r: any) => ({
    id: r.id,
    sessionId: r.session_id,
    ts: r.ts,
    lat: r.lat,
    lon: r.lon,
    altitude: r.altitude ?? null,
    speed: r.speed ?? null,
    accuracy: r.accuracy ?? null,
  }));
}

export async function deleteTrackPointsInRange(
  sessionId: string,
  fromTs: number,
  toTs: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM track_points WHERE session_id = ? AND ts >= ? AND ts < ?',
    sessionId,
    fromTs,
    toTs
  );
}

// ---------- segments ----------

export async function replaceSegments(
  sessionId: string,
  segments: Omit<Segment, 'id' | 'sessionId'>[]
): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM segments WHERE session_id = ?', sessionId);
  for (const s of segments) {
    await db.runAsync(
      'INSERT INTO segments (session_id, kind, start_ts, end_ts, label, manual) VALUES (?,?,?,?,?,?)',
      sessionId,
      s.kind,
      s.startTs,
      s.endTs,
      s.label,
      s.manual
    );
  }
}

export async function getSegments(sessionId: string): Promise<Segment[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM segments WHERE session_id = ? ORDER BY start_ts ASC',
    sessionId
  );
  return rows.map((r: any) => ({
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    startTs: r.start_ts,
    endTs: r.end_ts,
    label: r.label ?? null,
    manual: r.manual,
  }));
}

// ---------- named runs / personal bests ----------

export async function updateSegmentLabel(
  sessionId: string,
  segmentId: number,
  label: string | null
): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE segments SET label = ?, manual = 1 WHERE id = ? AND session_id = ?', label, segmentId, sessionId);
}

export async function getNamedRun(name: string): Promise<NamedRun | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>('SELECT * FROM named_runs WHERE name = ?', name);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    bestDurationMs: row.best_duration_ms,
    bestSessionId: row.best_session_id,
    bestTs: row.best_ts,
  };
}

export async function upsertPersonalBest(
  name: string,
  durationMs: number,
  sessionId: string,
  ts: number
): Promise<boolean> {
  // returns true if this is a new best
  const db = await getDb();
  const existing = await getNamedRun(name);
  if (!existing || durationMs < existing.bestDurationMs) {
    await db.runAsync(
      `INSERT INTO named_runs (name, best_duration_ms, best_session_id, best_ts)
       VALUES (?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET best_duration_ms=excluded.best_duration_ms, best_session_id=excluded.best_session_id, best_ts=excluded.best_ts`,
      name,
      durationMs,
      sessionId,
      ts
    );
    return true;
  }
  return false;
}

// ---------- manual timers ----------

export async function startManualTimer(
  sessionId: string,
  label: string,
  startTs: number
): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    'INSERT INTO manual_timers (session_id, label, start_ts) VALUES (?,?,?)',
    sessionId,
    label,
    startTs
  );
  return res.lastInsertRowId;
}

export async function stopManualTimer(id: number, endTs: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE manual_timers SET end_ts = ? WHERE id = ?', endTs, id);
}

export async function getOpenManualTimer(sessionId: string): Promise<ManualTimer | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM manual_timers WHERE session_id = ? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1',
    sessionId
  );
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    label: row.label,
    startTs: row.start_ts,
    endTs: null,
  };
}

export async function getManualTimers(sessionId: string): Promise<ManualTimer[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM manual_timers WHERE session_id = ? ORDER BY start_ts ASC',
    sessionId
  );
  return rows.map((r: any) => ({
    id: r.id,
    sessionId: r.session_id,
    label: r.label,
    startTs: r.start_ts,
    endTs: r.end_ts ?? null,
  }));
}
