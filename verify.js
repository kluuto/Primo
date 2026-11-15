// Pure verification + scoring logic (no network, no chain).
import crypto from 'crypto';

export const CHECKPOINTS = [
  { name: 'Start / finish (9th Ave & Judah)', lat: 37.7621, lon: -122.4660 },
  { name: 'South turn',                        lat: 37.7539, lon: -122.4660 },
  { name: 'West turn',                         lat: 37.7539, lon: -122.4831 },
  { name: 'North turn',                        lat: 37.7621, lon: -122.4831 },
  { name: 'Finish',                            lat: 37.7621, lon: -122.4660 },
];
export const RULES = { radiusM: 45, minMi: 2.7, maxMi: 3.6, minPaceMinPerMi: 5.0, maxPaceMinPerMi: 18.0, maxSegSpeedMs: 8.0 };

const R = 6371000;
const rad = d => d * Math.PI / 180;
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function parseGpx(xml) {
  const pts = [];
  const re = /<trkpt\b[^>]*?lat="([^"]+)"[^>]*?lon="([^"]+)"[^>]*?>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = re.exec(xml))) {
    const t = /<time>([^<]+)<\/time>/.exec(m[3]);
    pts.push({ lat: +m[1], lon: +m[2], t: t ? Date.parse(t[1]) : NaN });
  }
  return pts;
}

export function cellId(p) { return Math.floor(p.lat / 0.001) + ':' + Math.floor(p.lon / 0.001); }

export function verifyRun(points, cellCounts = {}, checkpoints = []) {
  const free = checkpoints.length === 0;   // runner drew their own route: no fixed checkpoints
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  if (points.length < 20 || points.some(p => !isFinite(p.lat) || !isFinite(p.lon) || !isFinite(p.t))) {
    add('GPX has timed track points', false, 'Need at least 20 points with lat, lon and time');
    return { ok: false, checks };
  }
  add('GPX has timed track points', true, points.length + ' points');

  let dist = 0, fastSeg = false, backwards = false;
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]), dt = (points[i].t - points[i - 1].t) / 1000;
    if (dt <= 0) { backwards = true; continue; }
    dist += d;
    if (d / dt > RULES.maxSegSpeedMs && dt < 120) fastSeg = true;
  }
  const mi = dist / 1609.344, mins = (points.at(-1).t - points[0].t) / 60000, pace = mins / mi;
  add('Timestamps move forward', !backwards, backwards ? 'Found out-of-order times' : 'ok');
  if (free) add('Distance is a real run (1 to 8 mi)', mi >= 1 && mi <= 8, mi.toFixed(2) + ' mi');
  else add('Distance is about 3 miles', mi >= RULES.minMi && mi <= RULES.maxMi, mi.toFixed(2) + ' mi');
  add('Pace is plausible for running', pace >= RULES.minPaceMinPerMi && pace <= RULES.maxPaceMinPerMi && !fastSeg,
      isFinite(pace) ? pace.toFixed(1) + ' min/mi' + (fastSeg ? ' (vehicle-speed segment)' : '') : 'n/a');

  let next = 0;
  for (const p of points) {
    if (next < checkpoints.length && haversine(p, checkpoints[next]) <= RULES.radiusM) next++;
  }
  if (!free) add('Passed every checkpoint in order', next === checkpoints.length, next + ' of ' + checkpoints.length);
  else add('Track stays continuous (no teleporting)', !points.some((p, i) => i && haversine(points[i - 1], p) > 400), 'ok');

  const ok = checks.every(c => c.ok);
  let score = 0, cells = [];
  if (ok) {
    cells = [...new Set(points.map(cellId))].sort();
    const mean = cells.reduce((s, c) => s + 1 / (1 + (cellCounts[c] || 0) / 4), 0) / cells.length;
    score = Math.round(mean * 100);
  }
  add('Rarity score calculated', ok, ok ? 'score ' + score + ' across ' + cells.length + ' street blocks' : 'skipped');
  const routeHash = '0x' + crypto.createHash('sha256').update(JSON.stringify(cells)).digest('hex');
  return { ok, checks, score, miles: +mi.toFixed(2), pace: +pace.toFixed(1), cells, routeHash };
}

// Sample GPX following the loop (for demos and tests).
// mode: 'run' | 'drive' | 'short'.  amp = sideways bulge in metres between checkpoints (more bulge = streets fewer people run).
export function sampleGpx(mode = 'run', amp = 0, checkpoints = CHECKPOINTS, speedOverride = 0) {
  const path = checkpoints;
  const speed = speedOverride || (mode === 'drive' ? 12 : 2.8); // m/s
  const stepS = 5, out = [];
  const mLat = 111000, mLon = 111000 * Math.cos(rad(37.76));
  let t = Date.now() - 40 * 60000;
  const segs = mode === 'short' ? path.slice(0, 3) : path;
  for (let s = 0; s < segs.length - 1; s++) {
    const a = segs[s], b = segs[s + 1], len = haversine(a, b), n = Math.max(1, Math.round(len / (speed * stepS)));
    const dx = (b.lon - a.lon) * mLon, dy = (b.lat - a.lat) * mLat, L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L, side = Math.random() < 0.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const f = i / n, jitter = (Math.random() - .5) * 0.00003, off = amp * side * Math.sin(Math.PI * f);
      out.push({ lat: a.lat + (b.lat - a.lat) * f + jitter + ny * off / mLat, lon: a.lon + (b.lon - a.lon) * f + jitter + nx * off / mLon, t });
      t += stepS * 1000;
    }
  }
  const last = segs.at(-1); out.push({ lat: last.lat, lon: last.lon, t });
  return '<?xml version="1.0"?>\n<gpx version="1.1" creator="primo-demo"><trk><trkseg>\n' +
    out.map(p => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n') +
    '\n</trkseg></trk></gpx>';
}

// A personal loop for challenge races: same shape and distance as the base loop, shifted and maybe reversed,
// so every runner gets a different route of the same difficulty.
export function personalRoute() {
  const mLat = 111000, mLon = 111000 * Math.cos(rad(37.76));
  const dx = (Math.random() - .5) * 600, dy = (Math.random() - .5) * 500, ccw = Math.random() < 0.5;
  const c = CHECKPOINTS.map(p => ({ name: 'Checkpoint', lat: p.lat + dy / mLat, lon: p.lon + dx / mLon }));
  return ccw ? [c[0], c[3], c[2], c[1], c[4]] : c;
}

// A fresh random ~3 mile loop for the main Run tab. Anchors are the north-west corner of each loop;
// loops extend east and south from the anchor, which keeps them on land. Demo geometry, not street-snapped.
const ANCHORS = [['Inner Sunset', 37.7621, -122.4660], ['Haight', 37.7690, -122.4470], ['Mission', 37.7599, -122.4148],
  ['Castro and Noe Valley', 37.7600, -122.4350], ['Richmond', 37.7800, -122.4850], ['Bernal Heights', 37.7410, -122.4150]];
export function randomRoute() {
  const mLat = 111000, mLon = 111000 * Math.cos(rad(37.76));
  const [name, la, lo] = ANCHORS[Math.floor(Math.random() * ANCHORS.length)];
  const lat = la + (Math.random() - .5) * 300 / mLat, lon = lo + (Math.random() - .5) * 300 / mLon;
  const W = 700 + Math.random() * 1000, H = 2415 - W;          // perimeter about 4830 m = 3 mi
  const c0 = { name: 'Start', lat, lon }, c1 = { name: 'East', lat, lon: lon + W / mLon },
        c2 = { name: 'South-east', lat: lat - H / mLat, lon: lon + W / mLon }, c3 = { name: 'South-west', lat: lat - H / mLat, lon };
  const cw = Math.random() < 0.5;
  return { name, checkpoints: cw ? [c0, c1, c2, c3, c0] : [c0, c3, c2, c1, c0] };
}
