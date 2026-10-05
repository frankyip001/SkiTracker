import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import type { TrackPoint } from './db';

/**
 * GPX export (FR-10.2): writes the day's track to a .gpx file and
 * opens the OS share sheet. Useful for debugging and user trust.
 */
export async function exportSessionGpx(
  sessionId: string,
  points: TrackPoint[],
  label: string
): Promise<void> {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const trkpts = points
    .map((p) => {
      const ele = p.altitude != null ? `<ele>${p.altitude.toFixed(1)}</ele>` : '';
      const time = new Date(p.ts).toISOString();
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}<time>${time}</time></trkpt>`;
    })
    .join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ski Tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(label)}</name></metadata>
  <trk><name>${esc(label)}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
  const file = new File(Paths.cache, `skitracker_${sessionId}.gpx`);
  file.write(gpx);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(file.uri, { mimeType: 'application/gpx+xml' });
}
