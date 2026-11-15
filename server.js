import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { parseGpx, verifyRun, sampleGpx, personalRoute, randomRoute, CHECKPOINTS, cellId } from './verify.js';

const PORT = process.env.PORT || 3000;
const RPC = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz';
const EXPLORER = process.env.EXPLORER || 'https://testnet.monadscan.com';
const CONTRACT = process.env.CONTRACT_ADDRESS;
const KEY = process.env.VERIFIER_PRIVATE_KEY; // server-side only, never sent to the browser
const DRY = !(CONTRACT && KEY);               // no keys => dry run (verifies, but no payout)
const ABI = [
  'function recordRun(address runner, bytes32 routeHash, uint16 score)',
  'function participationReward() view returns (uint256)',
];
let contract = null;
if (!DRY) contract = new ethers.Contract(CONTRACT, ABI, new ethers.Wallet(KEY, new ethers.JsonRpcProvider(RPC)));

// --- tiny file store: how often each street block has been run (seeded so scores vary) ---
const DB = './data.json';
let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { counts: {}, runs: [], seen: [] };
if (!Object.keys(db.counts).length) {
  const cells = verifyRun(parseGpx(sampleGpx('run'))).cells || [];
  cells.forEach((c, i) => { db.counts[c] = (i * 7 + 3) % 14; }); // demo baseline: some blocks common, some rare
}
db.entries = db.entries || {};
db.routes = db.routes || {};
const seedCount = c => { let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) % 997; return h % 14; };
const counts = new Proxy(db.counts, { get: (t, k) => (typeof k === 'string' ? (t[k] ?? seedCount(k)) : undefined) });
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
save();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

app.get('/api/config', (_q, r) => r.json({ dry: DRY, contract: CONTRACT || null, explorer: EXPLORER, checkpoints: CHECKPOINTS }));
const TIERS = [['common', 0], ['uncommon', 70], ['rare', 140], ['legendary', 220]];
app.get('/api/route', (q, r) => {
  const rid = String(q.query.rid || '').slice(0, 64);
  if (!rid) return r.status(400).json({ error: 'rid required' });
  if (q.query.fresh || !db.routes[rid]) {
    db.routes[rid] = randomRoute();
    const keys = Object.keys(db.routes); if (keys.length > 300) delete db.routes[keys[0]];
    save();
  }
  r.json(db.routes[rid]);
});
app.get('/api/sample-gpx', (q, r) => {
  const mode = q.query.mode || 'run';
  const tier = q.query.tier ? (TIERS.find(t => t[0] === q.query.tier) || TIERS[0]) : TIERS[Math.floor(Math.random() * TIERS.length)];
  const rt = db.routes[String(q.query.rid || '')];
  r.set('x-sample-tier', mode === 'run' ? tier[0] : mode);
  r.type('application/gpx+xml').send(sampleGpx(mode, mode === 'run' ? tier[1] : 0, (rt || randomRoute()).checkpoints));
});
app.get('/api/stats', (q, r) => {
  const me = String(q.query.runner || '').toLowerCase();
  const mine = db.runs.filter(x => x.addr === me);
  const paces = mine.map(x => x.pace).filter(Boolean);
  r.json({
    runs: mine.length,
    miles: +mine.reduce((t, x) => t + (x.miles || 0), 0).toFixed(2),
    earned: +mine.reduce((t, x) => t + (x.paid || 0), 0).toFixed(2),
    best: mine.reduce((m, x) => Math.max(m, x.score), 0),
    fastest: paces.length ? Math.min(...paces) : null,
    txs: mine.filter(x => x.tx).slice(-5).reverse().map(x => ({ tx: x.tx, paid: x.paid, at: x.at })),
  });
});
app.get('/api/leaderboard', (_q, r) => r.json(db.runs.slice().sort((a, b) => b.score - a.score).slice(0, 50)));

app.post('/api/submit', async (req, res) => {
  const { gpx, runner, rid } = req.body || {};
  if (!ethers.isAddress(runner || '')) return res.status(400).json({ error: 'Connect a wallet first.' });
  const digest = crypto.createHash('sha256').update(gpx || '').digest('hex');
  if (db.seen.includes(digest)) return res.status(409).json({ error: 'This exact file was already submitted.' });

  const rt = db.routes[String(rid || '')];
  const result = verifyRun(parseGpx(gpx || ''), counts, rt ? rt.checkpoints : []);
  if (!result.ok) return res.json({ verified: false, checks: result.checks });

  let tx = null, paid = null, payError = null;
  if (!DRY) {
    try {
      const sent = await contract.recordRun(runner, result.routeHash, result.score);
      const rcpt = await sent.wait();
      tx = rcpt.hash; paid = ethers.formatEther(await contract.participationReward());
    } catch (e) {
      payError = /already rewarded/.test(String(e.message)) ? 'You were already rewarded today. Run recorded, no second payout.' : 'Payout failed: ' + (e.shortMessage || e.message);
    }
  }
  result.cells.forEach(c => { db.counts[c] = (db.counts[c] ?? seedCount(c)) + 1; });
  db.seen.push(digest);
  db.runs.push({ runner: runner.slice(0, 6) + '…' + runner.slice(-4), addr: runner.toLowerCase(), score: result.score, pace: result.pace, miles: result.miles, paid: +paid || 0, tx, at: Date.now() });
  save();
  res.json({ verified: true, checks: result.checks, score: result.score, miles: result.miles, pace: result.pace, tx, paid, payError, dry: DRY, explorer: EXPLORER });
});

// ---------- brand challenges: everyone races a different route of the same difficulty ----------
const CHALLENGES = [
  { id: 'sunset-dash', name: 'Sunset Dash', sponsor: 'Sample Running Co. (demo sponsor)', prize: '5 MON + gear voucher',
    blurb: 'Join, get your own 3-mile loop, run it, and race everyone else. Fastest pace-adjusted time wins.' },
  { id: 'first-light', name: 'First Light', sponsor: 'Corner Café (demo sponsor)', prize: '3 MON + a month of free coffee',
    blurb: 'An early-bird race with the same rules and a smaller prize.' },
];
const DEMO_RACERS = { 'sunset-dash': [['Maya T.', 25.9], ['Jon O.', 27.4], ['Ana R.', 28.8], ['Kenji L.', 30.1], ['Dee S.', 31.6]], 'first-light': [['Pat N.', 29.2], ['Sam W.', 31.0], ['Lu H.', 33.4]] };
const lk = a => String(a || '').toLowerCase();
function raceBoard(id) {
  const rows = (DEMO_RACERS[id] || []).map(([n, min]) => ({ n, min, demo: true }));
  Object.values(db.entries[id] || {}).forEach(e => { if (e.result) rows.push({ n: e.runner.slice(0, 6) + '…' + e.runner.slice(-4), k: lk(e.runner), min: e.result.min, pace: e.result.pace }); });
  return rows.sort((a, b) => a.min - b.min);
}
app.get('/api/challenges', (q, r) => {
  const me = lk(q.query.runner);
  r.json(CHALLENGES.map(c => { const ents = db.entries[c.id] || {}, mine = ents[me];
    return { ...c, entrants: Object.keys(ents).length + (DEMO_RACERS[c.id] || []).length, mine: mine ? { route: mine.route, result: mine.result } : null, board: raceBoard(c.id) }; }));
});
app.post('/api/challenges/:id/join', (q, r) => {
  const c = CHALLENGES.find(x => x.id === q.params.id), runner = q.body && q.body.runner;
  if (!c) return r.status(404).json({ error: 'No such challenge.' });
  if (!ethers.isAddress(runner || '')) return r.status(400).json({ error: 'Connect a wallet first.' });
  db.entries[c.id] = db.entries[c.id] || {};
  if (!db.entries[c.id][lk(runner)]) db.entries[c.id][lk(runner)] = { runner, route: personalRoute(), result: null };
  save(); r.json({ route: db.entries[c.id][lk(runner)].route });
});
app.get('/api/challenges/:id/sample', (q, r) => {
  const e = (db.entries[q.params.id] || {})[lk(q.query.runner)];
  if (!e) return r.status(400).send('Join the challenge first.');
  r.type('application/gpx+xml').send(sampleGpx('run', 0, e.route, 2.5 + Math.random() * 0.9));
});
app.post('/api/challenges/:id/submit', (q, r) => {
  const { gpx, runner } = q.body || {}, id = q.params.id, e = (db.entries[id] || {})[lk(runner)];
  if (!e) return r.status(400).json({ error: 'Join the challenge first.' });
  const digest = crypto.createHash('sha256').update(gpx || '').digest('hex');
  if (db.seen.includes(digest)) return r.status(409).json({ error: 'This exact file was already submitted.' });
  const result = verifyRun(parseGpx(gpx || ''), {}, e.route);
  if (!result.ok) return r.json({ verified: false, checks: result.checks });
  const min = +(result.pace * 3.0).toFixed(1);
  if (!e.result || min < e.result.min) e.result = { min, pace: result.pace, at: Date.now() };
  db.seen.push(digest); save();
  const board = raceBoard(id);
  r.json({ verified: true, checks: result.checks, min, pace: result.pace, rank: board.findIndex(x => x.k === lk(runner)) + 1, of: board.length, board });
});

app.listen(PORT, () => console.log(`Primo on http://localhost:${PORT}  [${DRY ? 'DRY RUN: no payouts' : 'LIVE: paying from ' + CONTRACT}]`));
