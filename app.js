/* ═══════════════════════════════════════════════════════════════════════
   DSA·400 — CONSISTENCY TRACKER · app.js
   Patterns: Module (IIFE) · Facade over storage · Observer (pub-sub bus) ·
   data-driven rendering (single source of truth = TRACKER_DATA) ·
   delegated event handling · derived state (no duplication).
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';
document.documentElement.classList.add('js');           // progressive-enhancement flag
(() => {

/* ── Config ────────────────────────────────────────────────────────── */
const KEY   = 'd400-state-v1';
const THEMES = ['cyan','indigo','violet','emerald','lime','amber','orange','rose','blue','mono'];
const SWATCH = {cyan:'#06b6d4',indigo:'#6366f1',violet:'#8b5cf6',emerald:'#10b981',lime:'#84cc16',
                amber:'#f59e0b',orange:'#f97316',rose:'#f43f5e',blue:'#3b82f6',mono:'#a3a3a3'};

/* ── Model (generated from dsa400.md) ──────────────────────────────── */
const DATA = window.TRACKER_DATA;
const DAYS  = DATA.days;                       // [{id,sun,concept,phase,unit,items:[{n,j,u,p}]}]
const UNITS = DATA.units;                      // [{phase,title,days:[ids]}]
const PHASES = DATA.phases;                    // [{id,title,from,to}]
const byDay = id => DAYS[id - 1];
const N_DAYS = DAYS.length;

/* ── Store: Facade over localStorage (private-mode / sandbox safe) ─── */
const Store = {
  ok: true, mem: null,
  read() {
    try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; }
    catch (e) { this.ok = false; return this.mem; }
  },
  write(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (e) { this.ok = false; this.mem = s; }
  }
};

/* ── State ─────────────────────────────────────────────────────────── */
const defaults = () => ({ v: 1, currentDay: 1, sealed: {}, probs: {}, notes: {}, best: 0, startDate: null });
const state = Object.assign(defaults(), Store.read() || {});
state.sealed = state.sealed || {}; state.probs = state.probs || {};
state.notes = state.notes || {}; state.best = state.best || 0;

/* ── Remote persistence — immutable server ledger (server.js) ────────
   When the server answers, the client can only APPEND events (tick, seal,
   note…). The server stamps its own time, writes them to an append-only
   progress-log.jsonl and derives state.json — history cannot be rewritten
   and the plan anchor (Day 1 date) is fixed server-side. Without the
   server everything stays in localStorage, as before. */
const DEFAULT_ANCHOR = '2026-09-04';
const Remote = { on: false, anchor: null, note: 'checking…', queue: [], sending: false };
const canFetch = typeof fetch === 'function';

function logEvent(evt) {
  if (!Remote.on || !canFetch) return;
  Remote.queue.push(evt);
  flushEvents();
}
function flushEvents() {
  if (!Remote.on || Remote.sending || !Remote.queue.length || !canFetch) return;
  Remote.sending = true;
  const batch = Remote.queue.splice(0, Remote.queue.length);
  const resend = () => { Remote.queue.unshift(...batch); };
  try {
    fetch('api/events', { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }) })
      .then(r => { if (!r.ok) resend(); })
      .catch(resend)
      .then(() => { Remote.sending = false; setTimeout(flushEvents, 250); });
  } catch (_) { resend(); Remote.sending = false; }
}
addEventListener('pagehide', () => { if (Remote.queue.length) flushEvents(); });

function setStoreNote() {
  const sn = $('#storeNote');
  if (sn) sn.textContent = Remote.note + ' · ' +
    (Store.ok ? 'localStorage ✓' : 'in-memory (sandboxed)');
}
async function remoteBoot() {
  if (!canFetch) { Remote.note = 'local only · this device'; setStoreNote(); return; }
  try {
    const r = await fetch('api/progress', { cache: 'no-store' });
    if (!r.ok) throw new Error('no server');
    const data = await r.json();
    Remote.on = true;
    Remote.anchor = data.anchor || null;
    const sv = data.state || {};
    state.sealed = (sv.sealed && typeof sv.sealed === 'object') ? sv.sealed : {};
    state.probs  = (sv.probs  && typeof sv.probs  === 'object') ? sv.probs  : {};
    state.notes  = (sv.notes  && typeof sv.notes  === 'object') ? sv.notes  : {};
    state.best   = +sv.best || 0;
    state.currentDay = Math.max(1, Math.min(N_DAYS, +sv.currentDay || 1));
    if (Remote.anchor && /^\d{4}-\d{2}-\d{2}$/.test(Remote.anchor)) state.startDate = Remote.anchor;
    Remote.note = 'immutable ledger ✓ append-only · Day 1 = ' + state.startDate;
    persist(); renderAll();
    const di = $('#startDate');
    if (di) { di.value = state.startDate; di.disabled = true;
      di.title = 'Anchored by the server — immutable'; }
    const ln = $('#lockNote'); if (ln) ln.style.display = 'inline-flex';
    const rl = $('#rawLink');  if (rl) rl.style.display = '';
  } catch (_) { Remote.note = 'local only · this device'; setStoreNote(); }
}

const persist = () => Store.write(state);

/* ── Observer bus ──────────────────────────────────────────────────── */
const bus = {
  m: new Map(),
  on(ev, fn) { (this.m.get(ev) || this.m.set(ev, []).get(ev)).push(fn); },
  emit(ev, d) { (this.m.get(ev) || []).forEach(f => f(d)); }
};

/* ── Derived selectors (single source of truth) ────────────────────── */
const pKey = (day, i) => day + ':' + i;
const probDone = (day, i) => !!state.probs[pKey(day, i)];
const allProbsDone = d => d.items.length > 0 && d.items.every((_, i) => probDone(d.id, i));
const dayDone = d => d.items.length ? (allProbsDone(d) || !!state.sealed[d.id]) : !!state.sealed[d.id];
const solvedCount = () => Object.values(state.probs).filter(Boolean).length;
const sealedCount = () => DAYS.filter(dayDone).length;

function currentStreak() {
  let i = state.currentDay, s = 0;
  if (!dayDone(byDay(i))) i--;                       // today still open → count up to yesterday
  while (i >= 1 && dayDone(byDay(i))) { s++; i--; }
  return s;
}

/* ── Tiny DOM helpers ──────────────────────────────────────────────── */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const gotoSec = id => { const el = document.getElementById(id);
  if (el && el.scrollIntoView) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {} } };

/* ── Date helpers (local time, DST-safe: dates normalised to noon) ─── */
const pad2 = n => String(n).padStart(2, '0');
const ymdLocal = dt => dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const dayDiff = (isoA, isoB) => Math.round((parseYmd(isoA) - parseYmd(isoB)) / 864e5);
const todayIso = () => ymdLocal(new Date());
const dateForDay = n => { const dt = parseYmd(state.startDate); dt.setDate(dt.getDate() + n - 1); return dt; };
const planDayOf = dt => {
  const diff = Math.round((parseYmd(ymdLocal(dt)) - parseYmd(state.startDate)) / 864e5) + 1;
  return diff >= 1 && diff <= N_DAYS ? diff : null;
};
const MN = ['January','February','March','April','May','June','July',
            'August','September','October','November','December'];

let toastT;
function toast(html) {
  const t = $('#toast');
  t.innerHTML = html; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

const JUDGE_CLS = { LC: 'j-lc', GFG: 'j-gfg', CSES: 'j-cses', CF: 'j-cf', SPOJ: 'j-spoj' };

/* ════════════════════════════════════════════════════════════════════
   VIEW · hero chain (400 cells)
   ════════════════════════════════════════════════════════════════════ */
function renderChain() {
  const g = $('#chainGrid');
  const frag = [];
  for (let i = 1; i <= N_DAYS; i++) {
    const d = byDay(i);
    frag.push(`<button class="cell${d.sun ? ' sun' : ''}" data-cell="${i}" role="listitem"
      title="Day ${i}${d.sun ? ' · Sunday review' : ''} — ${esc(d.unit)}" style="animation-delay:${Math.min(i * 1.6, 700)}ms"></button>`);
  }
  g.innerHTML = frag.join('');
  updateChain();
}
function updateChain() {
  $$('#chainGrid .cell').forEach(c => {
    const id = +c.dataset.cell, d = byDay(id);
    c.classList.toggle('done', dayDone(d));
    c.classList.toggle('today', id === state.currentDay);
    c.classList.toggle('past', id < state.currentDay && !dayDone(d));
  });
}
$('#chainGrid').addEventListener('click', e => {
  const c = e.target.closest('[data-cell]'); if (!c) return;
  setDay(+c.dataset.cell, true);
});
$('#chainGrid').addEventListener('mouseover', e => {
  const c = e.target.closest('[data-cell]'); if (!c) return;
  const d = byDay(+c.dataset.cell);
  const st = dayDone(d) ? ' · sealed ✓' : (+c.dataset.cell === state.currentDay ? ' · today' : '');
  $('#chainFoot').innerHTML = `Day <b>${c.dataset.cell}</b> · ${esc(d.unit)} · ` +
    `${d.items.length ? esc(d.concept) + (d.sun ? '' : ` — ${d.items.length} question${d.items.length > 1 ? 's' : ''}`) : esc(d.concept)}${st}`;
});

/* ════════════════════════════════════════════════════════════════════
   VIEW · today radar
   ════════════════════════════════════════════════════════════════════ */
function itemLi(d, it, i, compact) {
  const done = probDone(d.id, i);
  const judge = it.j
    ? `<span class="judge ${JUDGE_CLS[it.j] || 'j-drill'}">${it.j}</span>` +
      (it.p ? '<span class="prem" title="LeetCode Premium question">★</span>' : '')
    : '<span class="judge j-drill" title="Practice / drill item — no fixed link in the plan">drill</span>';
  const name = it.u
    ? `<a class="pi-name" href="${esc(it.u)}" target="_blank" rel="noopener noreferrer">${esc(it.n)}</a>`
    : `<span class="pi-name">${esc(it.n)}</span>`;
  return `<li class="pi${done ? ' done' : ''}${it.u ? ' link' : ''}" data-pi="${i}"${it.u ? ` data-url="${esc(it.u)}"` : ''}>
    <span class="pi-ck" data-act="prob" data-day="${d.id}" data-idx="${i}" role="checkbox"
      aria-checked="${done}" tabindex="0" title="Mark solved">✓</span>${name}${judge}</li>`;
}

function renderToday() {
  const d = byDay(state.currentDay);
  const done = dayDone(d);
  const dn = d.items.filter((_, i) => probDone(d.id, i)).length;
  const ph = PHASES.find(p => p.id === d.phase);

  $('#todayCard').innerHTML = `
    <div class="today-top">
      <span class="today-dayno">Day ${d.id}</span>
      ${d.sun ? '<span class="chip chip-warn">Sunday · review</span>' : '<span class="chip">Practice day</span>'}
      <span class="chip chip-neutral">Phase ${ph.id} · ${esc(ph.title)}</span>
      <span class="today-unit">${esc(d.unit)} · Days ${ph.from}–${ph.to}</span>
    </div>
    <div class="today-concept">${esc(d.concept)}</div>
    ${d.items.length ? `
      <ul class="item-list">${d.items.map((it, i) => itemLi(d, it, i, false)).join('')}</ul>
      <div class="row" style="margin-top:8px;font-family:var(--font-mono);font-size:10px;
        letter-spacing:.16em;text-transform:uppercase;color:var(--text-mute)">
        ${dn}/${d.items.length} solved today
      </div>` : `
      <p class="card-d" style="margin-top:12px">No fixed question set — ${d.sun ? 'review, re-solve the week’s hardest, run a timed set.' : 'consolidation day: redo your hardest problems unaided.'}
      Mark it sealed once done.</p>`}
    <div class="today-actions">
      <button class="btn ${done ? 'btn-soft' : 'btn-primary'}" data-act="seal" data-day="${d.id}">
        ${done ? '✓ Day sealed' : 'Seal Day ' + d.id}</button>
      <span class="sealed-note">sealed — see you tomorrow →</span>
    </div>
    <textarea class="note-ta" id="noteTa" placeholder="Pattern notes for Day ${d.id} — the one insight you want to keep…"
      aria-label="Pattern notes for day ${d.id}">${esc(state.notes[d.id] || '')}</textarea>
    <div class="day-nav">
      <button class="btn btn-ghost btn-sm" data-act="prev-day" ${d.id === 1 ? 'disabled' : ''}>‹ Prev</button>
      <input class="jump-in" id="jumpIn" type="number" min="1" max="${N_DAYS}" value="${d.id}" aria-label="Go to day"/>
      <button class="btn btn-ghost btn-sm" data-act="next-day" ${d.id === N_DAYS ? 'disabled' : ''}>Next ›</button>
      <span class="spacer"></span>
      <button class="btn btn-soft btn-sm" data-act="sync-pointer">↺ Back to first open day</button>
    </div>`;

  /* revisit card (the 1h rule) */
  const prev = d.id > 1 ? byDay(d.id - 1) : null;
  $('#revisitCard').innerHTML = d.id === 1
    ? `<div class="side-lbl">The 1h revisit rule</div><div class="revisit-t">The streak starts <b>today</b>.
       From tomorrow this card points at yesterday’s toughest problem.</div>`
    : `<div class="side-lbl">Revisit · yesterday’s toughest · 1h</div>
       <div class="revisit-t"><b>Day ${prev.id} — ${esc(prev.concept)}</b><br>
       ${prev.items.length ? esc(prev.items[0].n) + (prev.items.length > 1 ? ' <em style="color:var(--text-mute)">+ ' + (prev.items.length - 1) + ' more</em>' : '') : 'Re-solve your hardest pick from that set, unaided.'}</div>
       <button class="btn btn-soft btn-sm" style="margin-top:10px" data-act="goto-day" data-day="${prev.id}">Open Day ${prev.id}</button>`;
}

/* targeted update after a checkbox flip (no full re-render → keeps textarea focus) */
function updateTodayBits() {
  const d = byDay(state.currentDay), done = dayDone(d);
  const dn = d.items.filter((_, i) => probDone(d.id, i)).length;
  const card = $('#todayCard');
  card.classList.toggle('is-sealed', done);
  const sealBtn = card.querySelector('[data-act="seal"]');
  if (sealBtn) { sealBtn.textContent = done ? '✓ Day sealed' : 'Seal Day ' + d.id;
    sealBtn.classList.toggle('btn-primary', !done); sealBtn.classList.toggle('btn-soft', done); }
  const cnt = card.querySelector('.row span, .row');
  if (d.items.length && cnt) cnt.textContent = `${dn}/${d.items.length} solved today`;
}

function setDay(n, scroll) {
  n = Math.max(1, Math.min(N_DAYS, n | 0));
  state.currentDay = n; persist();
  renderToday(); updateChain(); updateCalendar(); updateHero(); updateProgress();
  if (scroll) gotoSec('today');
}

/* ════════════════════════════════════════════════════════════════════
   VIEW · plan (units × day cards)
   ════════════════════════════════════════════════════════════════════ */
const filters = { judge: 'all', status: 'all', q: '' };

function dayCardHTML(d) {
  return `<article class="day${d.sun ? ' sun' : ''}${d.items.length ? '' : ' noitems'}" data-day-card="${d.id}">
    <div class="day-top"><span class="day-no">Day ${d.id}</span>
      ${d.sun ? '<span class="chip chip-warn">Sun</span>' : ''}
      <button class="open-chip" data-act="goto-day" data-day="${d.id}"
        title="Open Day ${d.id} in Today" aria-label="Open day ${d.id} in Today">OPEN →</button></div>
    <div class="day-concept">${esc(d.concept)}</div>
    ${d.items.length ? `<ul class="day-items">${d.items.map((it, i) => itemLi(d, it, i, true)).join('')}</ul>`
      : '<div class="card-d" style="font-size:11.8px">Consolidation / review — seal when done.</div>'}
  </article>`;
}

function renderPlan() {
  const firstOpen = DAYS.find(d => !dayDone(d));
  const root = [];
  UNITS.forEach((u, ui) => {
    const ph = PHASES.find(p => p.id === u.phase);
    const days = u.days.map(byDay);
    const doneN = days.filter(dayDone).length;
    const open = firstOpen && u.days.includes(firstOpen.id);
    root.push(`<details class="unit" data-unit="${ui}"${open ? ' open' : ''}>
      <summary class="unit-sum">
        <span class="u-caret">▶</span>
        <span><span class="u-title">${esc(u.title)}</span><br>
          <span class="u-range">Phase ${ph.id} · Days ${u.days[0]}–${u.days[u.days.length - 1]}</span></span>
        <span class="u-meta"><span class="u-bar"><i data-ubar="${ui}"></i></span>
          <span class="u-count" data-ucount="${ui}">${doneN}/${days.length}</span></span>
      </summary>
      <div class="u-days">${days.map(dayCardHTML).join('')}</div>
    </details>`);
  });
  $('#planRoot').innerHTML = root.join('');
  updateUnitBars();
  applyFilters();
}

function updateUnitBars() {
  UNITS.forEach((u, ui) => {
    const days = u.days.map(byDay), doneN = days.filter(dayDone).length;
    const bar = document.querySelector(`[data-ubar="${ui}"]`);
    const cnt = document.querySelector(`[data-ucount="${ui}"]`);
    if (bar) bar.style.width = (100 * doneN / days.length) + '%';
    if (cnt) cnt.textContent = `${doneN}/${days.length}`;
  });
}

function dayMatches(d) {
  if (filters.judge !== 'all' && !d.items.some(it => it.j === filters.judge)) return false;
  const done = dayDone(d);
  if (filters.status === 'open' && done) return false;
  if (filters.status === 'done' && !done) return false;
  if (filters.q) {
    const hay = (d.concept + ' ' + d.unit + ' day ' + d.id + ' ' +
      d.items.map(i => i.n).join(' ')).toLowerCase();
    if (!hay.includes(filters.q)) return false;
  }
  return true;
}

function applyFilters() {
  let shown = 0;
  $$('#planRoot [data-day-card]').forEach(el => {
    const ok = dayMatches(byDay(+el.dataset.dayCard));
    el.classList.toggle('hide', !ok); if (ok) shown++;
  });
  $$('#planRoot details.unit').forEach(u => {
    u.style.display = u.querySelector('[data-day-card]:not(.hide)') ? '' : 'none';
  });
  $('#planStats').textContent = `${shown} / ${N_DAYS} days shown`;
}
$('#searchBox').addEventListener('input', debounce(e => { filters.q = e.target.value.trim().toLowerCase(); applyFilters(); }, 120));
$('#judgeFilters').addEventListener('click', e => {
  const b = e.target.closest('[data-judge]'); if (!b) return;
  $$('#judgeFilters .chip').forEach(c => c.classList.toggle('on', c === b));
  filters.judge = b.dataset.judge; applyFilters();
});
$('#statusFilters').addEventListener('click', e => {
  const b = e.target.closest('[data-status]'); if (!b) return;
  $$('#statusFilters .chip').forEach(c => c.classList.toggle('on', c === b));
  filters.status = b.dataset.status; applyFilters();
});

/* ════════════════════════════════════════════════════════════════════
   VIEW · calendar — the plan projected onto real dates (transparent glass)
   ════════════════════════════════════════════════════════════════════ */
const cal = { y: null, m: null };
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function calInit() {
  const t = new Date();
  const anchor = planDayOf(t) !== null ? t : parseYmd(state.startDate);
  cal.y = anchor.getFullYear(); cal.m = anchor.getMonth();
}

function renderCalendar() {
  $('#calWeek').innerHTML = WD.map(w => `<span>${w}</span>`).join('');
  const y = cal.y, m = cal.m;
  const first = new Date(y, m, 1, 12);
  const lead = first.getDay();                       /* 0 = Sunday start */
  const nDays = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let dd = lead; dd >= 1; dd--) cells.push(new Date(y, m, 1 - dd, 12));
  for (let d = 1; d <= nDays; d++) cells.push(new Date(y, m, d, 12));
  for (let d = 1; cells.length % 7; d++) cells.push(new Date(y, m + 1, d, 12));

  const tIso = todayIso();
  let min = null, max = null, sealedN = 0, missedN = 0;
  const html = cells.map(dt => {
    const iso = ymdLocal(dt);
    const pd = planDayOf(dt);
    if (pd === null)
      return `<button class="cal-cell outside${iso === tIso ? ' realtoday' : ''}" data-iso="${iso}" tabindex="-1"
        title="${iso} — outside the 400-day plan"><span class="dnum">${dt.getDate()}</span></button>`;
    if (min === null || pd < min) min = pd;
    if (max === null || pd > max) max = pd;
    const d = byDay(pd);
    const cls = ['cal-cell'];
    if (d.sun) cls.push('psun');
    if (dayDone(d)) { cls.push('sealed'); sealedN++; }
    else if (dayDiff(iso, tIso) < 0) { cls.push('missed'); missedN++; }
    if (pd === state.currentDay) cls.push('ptoday');
    if (iso === tIso) cls.push('realtoday');
    return `<button class="${cls.join(' ')}" data-iso="${iso}" data-plan="${pd}"
      title="${iso} · Day ${pd} — ${esc(d.concept)}"><span class="dnum">${dt.getDate()}</span><span class="pday">D${pd}</span></button>`;
  });
  $('#calGrid').innerHTML = html.join('');
  $('#calTitle').textContent = `${MN[m]} ${y}`;
  $('#calRange').textContent = min === null
    ? 'outside the 400-day plan'
    : `days ${min}–${max} this month · ${sealedN} sealed · ${missedN} missed`;
}
const updateCalendar = renderCalendar;

/* ════════════════════════════════════════════════════════════════════
   VIEW · progress
   ════════════════════════════════════════════════════════════════════ */
function renderProgress() {
  $('#progMetrics').innerHTML = `
    <div class="card metric"><div class="ml">Journey</div><div class="mv">${Math.round(100 * sealedCount() / N_DAYS)}<small>%</small></div></div>
    <div class="card metric"><div class="ml">Days sealed</div><div class="mv">${sealedCount()}<small>/${N_DAYS}</small></div></div>
    <div class="card metric"><div class="ml">Questions solved</div><div class="mv">${solvedCount()}</div></div>
    <div class="card metric"><div class="ml">Current streak</div><div class="mv">${currentStreak()}<small> d</small></div></div>
    <div class="card metric"><div class="ml">Best streak</div><div class="mv">${state.best}<small> d</small></div></div>`;

  $('#phaseList').innerHTML = PHASES.map(p => {
    const days = DAYS.filter(d => d.phase === p.id);
    const n = days.filter(dayDone).length;
    const pct = Math.round(100 * n / days.length);
    return `<div class="phase-row">
      <div class="phase-name">Phase ${p.id} · ${esc(p.title)}
        <small>Days ${p.from}–${p.to} · ${n}/${days.length} sealed</small></div>
      <div class="phase-bar"><i style="width:${pct}%"></i></div>
      <div class="phase-pct">${pct}%</div></div>`;
  }).join('');

  $('#unitMap').innerHTML = UNITS.map((u, ui) => {
    const days = u.days.map(byDay), n = days.filter(dayDone).length;
    const pct = Math.round(100 * n / days.length);
    return `<button class="ub" data-act="open-unit" data-unit="${ui}" title="${esc(u.title)}">
      <span class="ub-n">${n}/${days.length}</span>
      <div class="ub-t">${esc(u.title)}</div>
      <div class="ub-b"><i style="width:${pct}%"></i></div></button>`;
  }).join('');

  setStoreNote();
}

function updateProgress() { renderProgress(); updateNavRing(); updateHero(); }

/* ════════════════════════════════════════════════════════════════════
   ACTIONS (the only place state mutates)
   ════════════════════════════════════════════════════════════════════ */
function bumpBest() {
  const s = currentStreak();
  if (s > state.best) { state.best = s; }
}

function sealDay(id, on) {
  const d = byDay(id);
  if (on) {
    state.sealed[id] = 1;
    logEvent({ t: 'seal', day: id });
    if (id === state.currentDay && id < N_DAYS) {
      state.currentDay = id + 1;                          // the chain advances
      toast(`<b>Day ${id} sealed.</b> Day ${id + 1} is live — don’t break the chain.`);
    } else {
      toast(`<b>Day ${id} sealed.</b>`);
    }
    bumpBest();
  } else {
    delete state.sealed[id];
    logEvent({ t: 'unseal', day: id });
  }
  persist();
  renderToday(); updateChain(); updateCalendar(); updateUnitBars(); updateProgress(); applyFilters();
}

function toggleProb(day, idx, on) {
  const d = byDay(day);
  if (on) state.probs[pKey(day, idx)] = 1; else delete state.probs[pKey(day, idx)];
  logEvent({ t: on ? 'tick' : 'untick', day, idx });
  if (d.items.length && d.items.every((_, i) => probDone(d.id, i)) && !state.sealed[day]) {
    state.sealed[day] = 1;
    if (day === state.currentDay && day < N_DAYS) state.currentDay = day + 1;
    bumpBest();
    logEvent({ t: 'seal', day });
    toast(`<b>Day ${day} sealed</b> — all ${d.items.length} questions done. The chain grows.`);
    persist();
    renderToday();                                   // radar advances to the new day
    updateChain(); updateCalendar(); updateUnitBars(); updateProgress(); applyFilters();
    return;
  } else if (!on && state.sealed[day] && !allProbsDone(d) && d.items.length) {
    delete state.sealed[day];                             // un-seal automatically
    logEvent({ t: 'unseal', day });
  }
  persist();
  /* targeted UI updates */
  const li = document.querySelector(`#todayCard [data-pi="${idx}"]`);
  if (li && day === state.currentDay) { li.classList.toggle('done', on);
    li.querySelector('.pi-ck').setAttribute('aria-checked', on); }
  const pli = document.querySelector(`[data-day-card="${day}"] [data-pi="${idx}"]`);
  if (pli) pli.classList.toggle('done', on);
  updateTodayBits(); updateChain(); updateCalendar(); updateUnitBars(); updateProgress(); applyFilters();
}

/* ════════════════════════════════════════════════════════════════════
   GLOBAL DELEGATED EVENTS
   ════════════════════════════════════════════════════════════════════ */
document.addEventListener('click', e => {
  const ck = e.target.closest('[data-act]');
  const nav = e.target.closest('[data-goto]');

  if (nav) { gotoSec(nav.dataset.goto === 'hero' ? 'hero' : nav.dataset.goto);
    $('#navLinks').classList.remove('open');
    $$('.nav-link').forEach(l => l.classList.toggle('on', l === nav)); return; }

  /* calendar date cell → open that plan day in Today */
  const calCell = e.target.closest('.cal-cell[data-plan]');
  if (calCell) { setDay(+calCell.dataset.plan, true); return; }

  /* problem row (touch target) → land directly on the question */
  const piRow = e.target.closest('.pi.link');
  if (piRow && !e.target.closest('.pi-ck') && !e.target.closest('a') && piRow.dataset.url) {
    window.open(piRow.dataset.url, '_blank', 'noopener'); return;
  }

  if (!ck) return;
  const act = ck.dataset.act, day = +ck.dataset.day;

  switch (act) {
    case 'prob': {
      const idx = +ck.dataset.idx;
      toggleProb(day, idx, !probDone(day, idx));
      break;
    }
    case 'seal':   sealDay(day, !dayDone(byDay(day))); break;
    case 'prev-day': setDay(state.currentDay - 1); break;
    case 'next-day': setDay(state.currentDay + 1); break;
    case 'goto-day': setDay(+ck.dataset.day, true); break;
    case 'sync-pointer': {
      const first = DAYS.find(d => !dayDone(d));
      setDay(first ? first.id : N_DAYS, false);
      toast(`Pointer set to first open day — <b>Day ${state.currentDay}</b>.`);
      break;
    }
    case 'open-unit': {
      const u = document.querySelector(`details.unit[data-unit="${ck.dataset.unit}"]`);
      if (u) { u.open = true; if (u.scrollIntoView) { try { u.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {} } }
      break;
    }
    case 'cal-prev': cal.m--; if (cal.m < 0) { cal.m = 11; cal.y--; } renderCalendar(); break;
    case 'cal-next': cal.m++; if (cal.m > 11) { cal.m = 0; cal.y++; } renderCalendar(); break;
    case 'cal-today': calInit(); renderCalendar(); break;
  }
});

/* keyboard toggles for the custom checkboxes */
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.pi-ck')) {
    e.preventDefault(); e.target.click();
  }
});

/* notes: debounced persist */
document.addEventListener('input', e => {
  if (e.target.id === 'noteTa') {
    const v = e.target.value, day = state.currentDay;
    debounce(() => {
      if (state.notes[day] === v) return;
      state.notes[day] = v; persist();
      logEvent({ t: 'note', day, text: v });
    }, 350)();
  }
  if (e.target.id === 'jumpIn') {
    const n = +e.target.value;
    if (n >= 1 && n <= N_DAYS) debounce(() => setDay(n), 500)();
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'jumpIn') setDay(+e.target.value || state.currentDay);
  if (e.target.id === 'startDate') {
    if (Remote.on) { e.target.value = state.startDate;
      toast('The anchor is <b>locked by the server</b> — the date sequence is immutable.'); return; }
    const v = e.target.value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      state.startDate = v; persist();
      calInit(); renderCalendar();
      toast(`Day 1 anchored to <b>${v}</b> — all 400 days re-aligned.`);
    }
  }
});

/* ════════════════════════════════════════════════════════════════════
   THEME / MODE  (token-layer pattern: swap [data-theme] on <html>)
   ════════════════════════════════════════════════════════════════════ */
function renderSwatches() {
  $('#themeSwatches').innerHTML = THEMES.map(t =>
    `<button class="swatch${document.documentElement.dataset.theme === t ? ' on' : ''}"
       data-theme="${t}" title="${t}" style="background:${SWATCH[t]}"
       aria-label="${t} theme"></button>`).join('');
}
$('#themeSwatches').addEventListener('click', e => {
  const s = e.target.closest('.swatch'); if (!s) return;
  document.documentElement.dataset.theme = s.dataset.theme;
  try { localStorage.setItem('d400-theme', s.dataset.theme); } catch (_) {}
  renderSwatches();
});
$('#modeBtn').addEventListener('click', () => {
  const d = document.documentElement;
  d.dataset.mode = d.dataset.mode === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('d400-mode', d.dataset.mode); } catch (_) {}
});
$('#burger').addEventListener('click', () => $('#navLinks').classList.toggle('open'));
$('#brandHome').addEventListener('click', () => gotoSec('hero'));
$('#ctaToday').addEventListener('click', () => gotoSec('today'));
$('#ctaPlan').addEventListener('click', () => gotoSec('plan'));
/* ════════════════════════════════════════════════════════════════════
   EXPORT / IMPORT
   ════════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════════
   NAV RING · HERO STATS · REVEAL · SPOTLIGHT
   ════════════════════════════════════════════════════════════════════ */
function updateNavRing() {
  const pct = sealedCount() / N_DAYS, C = 97.4;
  $('#navRingFg').style.strokeDashoffset = (C * (1 - pct)).toFixed(1);
  $('#navRingPct').textContent = Math.round(pct * 100) + '%';
}
function updateHero() {
  $('#statDays').textContent = sealedCount();
  $('#statProblems').textContent = solvedCount();
  $('#statStreak').textContent = currentStreak();
  $('#ctaDay').textContent = state.currentDay;
  $('#chainDayNo') && ($('#chainDayNo').textContent = state.currentDay);
}

/* reveal-on-scroll (motion on entry, not on idle) */
const io = new IntersectionObserver(es => es.forEach(x => {
  if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); }
}), { threshold: 0.12 });

/* active nav link follows the section in view */
const secIO = new IntersectionObserver(es => es.forEach(x => {
  if (x.isIntersecting) {
    const id = x.target.id === 'hero' ? 'hero' : x.target.id;
    $$('.nav-link').forEach(l => l.classList.toggle('on', l.dataset.goto === id));
  }
}), { rootMargin: '-45% 0px -50% 0px' });

/* spotlight cards (one rAF-throttled listener) */
let sx = 0, sy = 0, sTick = false;
document.addEventListener('mousemove', e => {
  const c = e.target.closest && e.target.closest('.card.spot');
  if (!c) return;
  const r = c.getBoundingClientRect();
  sx = e.clientX - r.left; sy = e.clientY - r.top;
  if (!sTick) { sTick = true; requestAnimationFrame(() => {
    c.style.setProperty('--mx', sx + 'px'); c.style.setProperty('--my', sy + 'px'); sTick = false;
  }); }
});

/* nav condenses on scroll */
addEventListener('scroll', () => $('#nav').classList.toggle('small', scrollY > 40), { passive: true });

/* ════════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════════ */
/* re-render everything from state (used after the remote ledger adopts a boot) */
function renderAll() {
  renderToday(); updateChain(); renderPlan(); updateCalendar();
  updateProgress(); updateNavRing(); updateHero(); applyFilters();
}

function boot() {
  if (state.currentDay < 1 || state.currentDay > N_DAYS) state.currentDay = 1;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.startDate || '')) state.startDate = DEFAULT_ANCHOR;
  $('#statLinks').textContent = DAYS.reduce((a, d) => a + d.items.filter(i => i.u).length, 0);
  renderSwatches();
  renderChain();
  renderToday();
  renderPlan();
  calInit(); renderCalendar();
  $('#startDate').value = state.startDate;
  renderProgress();
  updateNavRing();
  updateHero();
  $$('.rv').forEach(el => io.observe(el));
  $$('main section[id]').forEach(s => secIO.observe(s));
  remoteBoot();                                        /* sync to progress.json if server.js runs */
}
boot();

})();
