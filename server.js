#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   DSA·400 — immutable ledger backend. Zero dependencies. Node 18+.
   Run:   node server.js                    →  http://localhost:8787
   Env:   PORT=8787  DATA_DIR=/var/data  START_DATE=2026-09-04
   Files: $DATA_DIR/progress-log.jsonl   ← append-only event ledger (source of truth)
          $DATA_DIR/state.json           ← derived snapshot (rebuilt by replaying the log)

   Immutability model
   ───────────────────
   • Clients can only POST events: tick / untick / seal / unseal / note.
   • Every stored record gets a SERVER timestamp + sequence number — a client
     can never backdate or rewrite history.
   • `seal` is rejected for future days (dayDate > server today) and for
     already-sealed days: the recorded seal date is trustworthy.
   • The plan anchor (Day 1 date) is a server constant — the date sequence
     cannot be shifted by anyone.
   • Raw ledger is publicly readable:   GET /file      (pretty JSON)
                                       GET /file.txt  (raw JSONL)
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT       = __dirname;
const DATA_DIR   = process.env.DATA_DIR || ROOT;
const START_DATE = process.env.START_DATE || '2026-09-04';   /* Day 1 — immutable */
const PORT       = process.env.PORT || 8787;
const N_DAYS     = 400;
const LOG_FILE   = path.join(DATA_DIR, 'progress-log.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ── ledger state, derived by replaying the append-only log ────────── */
const emptyState = () => ({ sealed: {}, probs: {}, notes: {}, best: 0, currentDay: 1 });
let ledger = [];                       /* [{seq, ts, t, day, idx, text}]  */

function applyEvent(st, e) {
  const day = e.day;
  if (e.t === 'tick' && Number.isInteger(e.idx)) st.probs[day + ':' + e.idx] = 1;
  if (e.t === 'untick' && Number.isInteger(e.idx)) delete st.probs[day + ':' + e.idx];
  if (e.t === 'seal') st.sealed[day] = 1;
  if (e.t === 'unseal') delete st.sealed[day];
  if (e.t === 'note' && typeof e.text === 'string') st.notes[day] = e.text;
}

function deriveState() {
  const st = emptyState();
  for (const e of ledger) applyEvent(st, e);
  st.currentDay = N_DAYS;                        /* first unsealed day */
  for (let d = 1; d <= N_DAYS; d++) if (!st.sealed[d]) { st.currentDay = d; break; }
  let run = 0;                                   /* best streak */
  for (let d = 1; d <= N_DAYS; d++) {
    run = st.sealed[d] ? run + 1 : 0;
    if (run > st.best) st.best = run;
  }
  return st;
}

function replay() {
  if (!fs.existsSync(LOG_FILE)) return;
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try { ledger.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
  }
}
function persistState() {
  const snapshot = { anchor: START_DATE, savedAt: new Date().toISOString(), state: deriveState() };
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 1));
  fs.renameSync(tmp, STATE_FILE);                /* atomic */
}
function appendEvents(events) {
  let seq = ledger.length;
  const now = new Date().toISOString();
  const lines = events.map(e => {
    seq += 1;
    const rec = Object.assign({}, e, { seq, ts: e.ts || now });
    return JSON.stringify(rec);
  });
  fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n');   /* append-only */
  ledger.push(...events.map((e, i) => Object.assign({}, e, { seq: seq - lines.length + i + 1, ts: e.ts || now })));
  persistState();
}

/* ── validation: what the server will (and will never) accept ──────── */
const pad2 = n => String(n).padStart(2, '0');
function serverToday() {                         /* UTC — Render clocks run UTC */
  const t = new Date();
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}
function dayDate(day) {                          /* anchor + (day-1) — the immutable sequence */
  const [y, m, d] = START_DATE.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + day - 1));
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}
function sanitize(e, st) {
  if (!e || typeof e !== 'object') return { err: 'not an object' };
  const t = e.t;
  const day = +e.day;
  if (!['tick', 'untick', 'seal', 'unseal', 'note'].includes(t)) return { err: 'unknown type' };
  if (!Number.isInteger(day) || day < 1 || day > N_DAYS) return { err: 'day out of range' };

  if (t === 'tick' || t === 'untick') {
    const idx = +e.idx;
    if (!Number.isInteger(idx) || idx < 0 || idx > 63) return { err: 'idx out of range' };
    return { evt: { t, day, idx } };
  }
  if (t === 'seal') {
    if (st.sealed[day]) return { err: 'day already sealed' };
    if (dayDate(day) > serverToday()) return { err: 'cannot seal a future day' };
    return { evt: { t, day } };
  }
  if (t === 'unseal') {
    if (!st.sealed[day]) return { err: 'day not sealed' };
    return { evt: { t, day } };                  /* original seal ts stays in the log */
  }
  if (t === 'note') {
    const text = String(e.text == null ? '' : e.text).slice(0, 4000);
    return { evt: { t, day, text } };
  }
  return { err: 'unreachable' };
}

function counts(st) {
  const sealedN = Object.keys(st.sealed).length;
  const solvedN = Object.values(st.probs).filter(Boolean).length;
  return { sealedN, solvedN, totalDays: N_DAYS };
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  /* ── read models ──────────────────────────────────────────────────── */
  if (req.method === 'GET' && url.pathname === '/api/progress') {
    const st = deriveState();
    return send(res, 200, JSON.stringify({
      anchor: START_DATE, serverNow: new Date().toISOString(),
      counts: counts(st), state: st
    }));
  }
  if (req.method === 'GET' && url.pathname === '/file') {          /* raw ledger, pretty */
    const st = deriveState();
    return send(res, 200, JSON.stringify({
      anchor: START_DATE, serverNow: new Date().toISOString(),
      counts: counts(st), state: st, log: ledger
    }, null, 2));
  }
  if (req.method === 'GET' && url.pathname === '/file.txt') {      /* raw ledger, JSONL */
    const txt = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
    return send(res, 200, txt, 'text/plain; charset=utf-8');
  }

  /* ── append-only writes ───────────────────────────────────────────── */
  if (req.method === 'POST' && (url.pathname === '/api/event' || url.pathname === '/api/events')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const incoming = Array.isArray(parsed.events) ? parsed.events : [parsed];
        if (incoming.length > 500) return send(res, 413, JSON.stringify({ error: 'too many events' }));
        const st = deriveState();
        const valid = [], rejected = [];
        for (const e of incoming) {
          const r = sanitize(e, st);
          if (r.err) { rejected.push({ day: e && e.day, t: e && e.t, reason: r.err }); continue; }
          valid.push(r.evt);
          applyEvent(st, r.evt);                 /* validate the whole batch in order */
        }
        if (valid.length) appendEvents(valid.map(e => Object.assign({}, e)));
        send(res, 200, JSON.stringify({ ok: true, applied: valid.length, rejected }));
      } catch (_) { send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }
    });
    return;
  }

  /* ── static files ─────────────────────────────────────────────────── */
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
});

replay();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`DSA·400 tracker   →  http://localhost:${PORT}`);
  console.log(`raw ledger        →  http://localhost:${PORT}/file`);
  console.log(`anchor (immutable)→  Day 1 = ${START_DATE}`);
  console.log(`data dir          →  ${DATA_DIR} (log: ${ledger.length} events loaded)`);
});
