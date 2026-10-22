/* Lost Memories — phone app.
 *
 * Data comes from the PCs: each one writes snapshot-<pc>.json into Drive/SeriesTracker/data, and a
 * small Google Apps Script (the "bridge", in the user's own Google account) hands the newest one to
 * this app. Changes made here (+/−, "watched up to here") go into state-phone.json, which the PCs
 * merge like any other machine's state. When served from the PC itself (/m/ on 127.0.0.1) the app
 * reads the PC's live snapshot directly, for previewing.
 */
'use strict';
const VERSION = '1.5.1';
const $ = s => document.querySelector(s);
const fa = n => (n ?? '').toLocaleString('fa-IR');
const faYear = n => n ? Number(n).toLocaleString('fa-IR', { useGrouping: false }) : '';
const now = () => Date.now() / 1000;
// served by the PC app at /m/: read the PC's live data ("?bridge" forces the real bridge, for testing)
const PC_PREVIEW = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && location.pathname.startsWith('/m') &&
  !new URLSearchParams(location.search).has('bridge');

// ------------------------------------------------------------------ storage
const LS = {
  get(k, d) { try { const v = localStorage.getItem('lm.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lm.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// the snapshot is ~2 MB: IndexedDB, not localStorage
const IDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((ok, bad) => {
      const r = indexedDB.open('lost-memories', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
    return this.db;
  },
  async get(k) {
    try {
      const db = await this.open();
      return await new Promise(ok => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(undefined); });
    } catch { return undefined; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise(ok => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = ok; });
    } catch { /* storage unavailable: the app still works for this session */ }
  },
};

// ------------------------------------------------------------------ state
let snap = null;                                  // newest PC snapshot
let snapTime = 0;                                 // bridge: Drive modified time of that snapshot (ms)
let phone = { machine: 'phone', overrides: {}, wishlist: {} };  // changes made on the phone
let live = LS.get('live', { al: {}, tm: {}, at: 0 });   // fresh airing data fetched by the phone
let view = 'shows', filter = 'all', movieFilter = 'all', genre = '', detail = null;
let shows = [];                                   // derived from snap + phone + live
let kind = LS.get('kind', 'all');                 // series view: all / anime / series (like the desktop's type buttons)

const conn = () => LS.get('conn', { url: '', key: '' });

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const norm = t => String(t || '').toLowerCase().replace(/['’`]/g, '').replace(/[\s._\-:!?,()\[\]]+/g, ' ').trim();
const initials = t => (t || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const rtf = new Intl.RelativeTimeFormat('fa', { numeric: 'auto' });
function relTime(ts) {
  const d = ts - now(), a = Math.abs(d);
  if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
  if (a < 86400 * 45) return rtf.format(Math.round(d / 86400), 'day');
  return rtf.format(Math.round(d / (86400 * 30)), 'month');
}
const date = ts => ts ? new Date(ts * 1000).toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' }) : '';
const bytes = b => !b ? '' : b >= 2 ** 30 ? fa(+(b / 2 ** 30).toFixed(1)) + ' گیگ' : fa(Math.round(b / 2 ** 20)) + ' مگ';
function coverEl(url, title, cls) {
  const ph = () => h('div', { class: cls }, title === '🎬' ? '🎬' : initials(title));
  if (!url) return ph();
  return h('img', { class: cls, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: e => e.target.replaceWith(ph()) });
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  $('#toastText').textContent = text;
  t.hidden = true; void t.offsetWidth; t.hidden = false;          // restart the slide-in
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
// inline SVG icons (h() can't make SVG elements)
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m4.5 12.75 6 6 9-13.5"/>', reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  bell: '<path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"/>',
  alert: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.7 1.7-1.7h2c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2Z"/>',
};
function icon(name, size) {
  const sp = document.createElement('span');
  sp.style.display = 'inline-flex';
  // the inline ones above, else the app's Lucide sprite (the same icons the desktop uses)
  sp.innerHTML = `<svg viewBox="0 0 24 24" width="${size || 15}" height="${size || 15}" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || `<use href="icons.svg#${name}"/>`}</svg>`;
  return sp;
}
function srcLabel(src) {
  const s = (snap && snap.sources || []).find(x => x.source === src);
  if (!s) return src || '';
  if (s.kind === 'pc') return '🖥 سیستم ' + src;
  if (s.kind === 'adm') return '📱 ' + src;
  if (s.kind === 'telegram') return '✈️ ' + src;
  return src;
}
const srcKind = src => ((snap && snap.sources || []).find(x => x.source === src) || {}).kind;

// ------------------------------------------------------------------ deriving the view
// Applies the phone's own corrections and the live airing data on top of the PC snapshot, and
// recomputes "new episodes" the same way the PC does.
function derive() {
  if (!snap) { shows = []; return; }
  const written = snap.written_at || 0;
  shows = snap.shows.map(s => {
    const o = phone.overrides[s.sid];
    let pos = { idx: s.pos.idx, episode: s.pos.episode }, manual = s.override, mine = false;
    if (o && (o.updated || 0) > written) {           // changed on the phone after the PC's snapshot
      mine = true;
      if (o.cleared) {
        const top = (s.source_progress || [])[0];
        if (top) pos = { idx: top.idx, episode: top.episode };
        manual = false;
      } else { pos = { idx: o.idx, episode: o.episode }; manual = true; }
    }
    const seasons = s.seasons.map(se => liveSeason(s, se));
    let fresh = 0, upcoming = null;
    for (const se of seasons) {
      if (se.idx < pos.idx) continue;
      fresh += se.idx === pos.idx ? Math.max(0, (se.aired || 0) - pos.episode) : (se.aired || 0);
      if (se.next && !upcoming) upcoming = { label: se.label, episode: se.next.episode, at: se.next.at };
    }
    const last = seasons[seasons.length - 1];
    const airing = !!upcoming || seasons.some(se => se.status === 'RELEASING' || se.status === 'NOT_YET_RELEASED') ||
      ['Running', 'To Be Determined', 'In Development'].includes(s.show_status);
    const state = fresh ? (airing ? 'new' : 'behind') : airing ? 'waiting' : (last && last.status === 'FINISHED') ? 'done' : 'unknown';
    const cur = seasons.find(se => se.idx === pos.idx);
    return { ...s, seasons, pos: { ...pos, label: cur ? cur.label : 'S' + pos.idx, season_episodes: cur && cur.episodes, season_aired: cur && cur.aired },
      override: manual, mine, new: fresh, upcoming, state,
      _hay: norm([s.title, s.alt, s.native, ...(s.genres || []), ...(s.names || []), ...(s.episodes_owned || []).map(e => e.file)].join(' | ')) };
  });
  const order = { new: 0, behind: 1, waiting: 2, unknown: 3, done: 4 };
  shows.sort((a, b) => order[a.state] - order[b.state] || (b.active || 0) - (a.active || 0));
}

function liveSeason(s, se) {
  const [prov, id] = s.sid.split(':');
  if (prov === 'al' && se.media_id && live.al[se.media_id]) {
    const L = live.al[se.media_id];
    const aired = L.status === 'FINISHED' ? (L.episodes || se.aired) : L.next ? L.next.episode - 1 : se.aired;
    return { ...se, status: L.status || se.status, episodes: L.episodes || se.episodes, aired: Math.max(aired, 0), next: L.next || null };
  }
  if (prov === 'tm' && live.tm[id]) {
    const L = live.tm[id];
    const out = { ...se };
    if (L.prev && L.prev.season === se.season_num) out.aired = Math.max(se.aired || 0, L.prev.number);
    if (L.next && L.next.season === se.season_num) { out.next = { episode: L.next.number, at: L.next.at }; out.status = 'RELEASING'; }
    else if (out.next && out.next.at < now()) out.next = null;
    return out;
  }
  if (se.next && se.next.at < now() - 3600) {       // the PC's info is older than the episode: count it as out
    return { ...se, aired: Math.max(se.aired || 0, se.next.episode), next: null };
  }
  return se;
}

// ------------------------------------------------------------------ sync
async function bridge(action, extra) {
  const c = conn();
  const r = await fetch(c.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: c.key, action, ...extra }) });
  if (!r.ok) throw new Error('خطای اتصال (' + r.status + ')');
  const j = await r.json();
  if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'رمز اشتباهه' : (j.error || 'خطا'));
  return j;
}

// the bridge sends the snapshot gzip-compressed and base64-encoded (about ten times smaller)
async function gunzipJson(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

let syncing = false;
async function sync(silent) {
  if (syncing) return;
  syncing = true;
  $('#syncBtn').classList.add('spin');
  $('#syncDot').className = 'live-dot busy';
  let ok = false;
  try {
    if (PC_PREVIEW) {
      snap = await (await fetch('/api/snapshot')).json();
      snapTime = Date.now();
    } else {
      const c = conn();
      if (!c.url || !c.key) { showBanner('برای دیدن اطلاعات، توی «بیشتر» آدرس پل و رمز رو وارد کن.', true); return; }
      const j = await bridge('load', { have: snapTime || '', gz: 'DecompressionStream' in window ? 1 : 0 });
      LS.set('bridgeVer', j.bridge || 1);
      const fresh = j.snapshot_gz ? await gunzipJson(j.snapshot_gz) : j.snapshot;
      if (fresh) { snap = fresh; snapTime = j.snapshot_time; await IDB.set('snap', { snap, snapTime }); }
      if (j.phone && j.phone.overrides) mergePhone(j.phone);
    }
    LS.set('lastSync', now());
    if (LS.get('dirty', false)) await push();
    derive(); render();
    if (!silent) toast('اطلاعات به‌روز شد');
    ok = true;
    checkLive();
  } catch (e) {
    showBanner('همگام‌سازی نشد: ' + (e.message || e) + ' (اطلاعات قبلی نشون داده می‌شه)', true);
  } finally {
    syncing = false;
    $('#syncBtn').classList.remove('spin');
    $('#syncDot').className = 'live-dot' + (ok || PC_PREVIEW ? '' : ' off');
    updateSyncInfo();
  }
}

function mergePhone(remote) {
  for (const part of ['overrides', 'wishlist']) {
    phone[part] = phone[part] || {};
    for (const [k, o] of Object.entries(remote[part] || {})) {
      const mine = phone[part][k];
      if (!mine || (o.updated || 0) > (mine.updated || 0)) phone[part][k] = o;
    }
  }
  LS.set('phone', phone);
}

let pushTimer;
function queuePush() {
  LS.set('dirty', true);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push().catch(() => {}), 1500);
}
async function push() {
  if (PC_PREVIEW) { LS.set('dirty', false); return; }     // preview: changes stay in this browser
  const c = conn();
  if (!c.url || !c.key) return;
  phone.updated = now();
  await bridge('save_state', { state: phone });
  LS.set('dirty', false);
  updateSyncInfo();
}

function setOverride(s, idx, episode) {
  phone.overrides[s.sid] = { idx, episode: Math.max(0, episode), updated: now() };
  LS.set('phone', phone);
  queuePush(); derive(); render(); if (detail) renderDetail();
}
function clearOverride(s) {
  phone.overrides[s.sid] = { cleared: true, updated: now() };
  LS.set('phone', phone);
  queuePush(); derive(); render(); if (detail) renderDetail();
}

function updateSyncInfo() {
  const t = LS.get('lastSync', 0);
  const parts = [];
  if (snap) parts.push(`از سیستم ${snap.machine} · ${relTime(snap.written_at)}`);
  if (LS.get('dirty', false)) parts.push('تغییرات هنوز فرستاده نشده');
  else if (t) parts.push('همگام ' + relTime(t));
  $('#syncInfo').textContent = parts.join(' · ') || 'هنوز همگام نشده';
}

function showBanner(text, warn, jumps) {
  const b = $('#banner');
  b.className = 'banner' + (warn ? ' warn' : '');
  const ic = icon(warn ? 'alert' : 'bell', 18);
  ic.className = 'bell';
  if (warn) ic.style.color = 'var(--warn)';
  // (replaceChildren would print a null as the text "null")
  b.replaceChildren(...[h('div', { class: 'bhead' }, ic, h('span', {}, text), h('button', { class: 'bx', 'aria-label': 'بستن', onclick: () => { b.hidden = true; } }, '×')),
    jumps && jumps.length ? h('div', { class: 'jumps' }, jumps.map(s => h('button', { class: 'ltr', onclick: () => openDetail(s) }, s.title, h('b', {}, '+' + fa(s.new))))) : null].filter(Boolean));
  b.hidden = false;
}

// ------------------------------------------------------------------ live airing check (no server: AniList & TVmaze allow browser requests)
async function checkLive(force) {
  if (!snap || !navigator.onLine) return;
  if (!force && now() - (live.at || 0) < 3 * 3600) return;
  const candidates = shows.filter(s => s.state !== 'done');
  const alIds = new Set(), tmIds = new Set();
  for (const s of candidates) {
    const [prov, id] = s.sid.split(':');
    if (prov === 'al') {
      for (const se of s.seasons) if (se.media_id && (se.status === 'RELEASING' || se.status === 'NOT_YET_RELEASED' || se === s.seasons[s.seasons.length - 1])) alIds.add(se.media_id);
    } else if (prov === 'tm' && (s.state === 'new' || s.state === 'waiting' || s.show_status === 'Running')) tmIds.add(id);
  }
  const before = Object.fromEntries(shows.map(s => [s.sid, s.new]));
  let alDown = false;
  try {
    // AniList on its own: when it's down (it once switched its API off for days) the series still get checked
    try {
      const ids = [...alIds];
      for (let i = 0; i < ids.length; i += 50) {
        const r = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: 'query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id status episodes nextAiringEpisode{episode airingAt}}}}', variables: { ids: ids.slice(i, i + 50) } }) });
        const j = await r.json();
        if (!j.data) throw new Error('AniList');
        for (const m of j.data.Page.media || []) {
          live.al[m.id] = { status: m.status, episodes: m.episodes, next: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt } : null };
        }
      }
    } catch { alDown = alIds.size > 0; }
    const tms = [...tmIds];
    for (let i = 0; i < tms.length; i += 4) {
      await Promise.all(tms.slice(i, i + 4).map(async id => {
        try {
          const j = await (await fetch(`https://api.tvmaze.com/shows/${id}?embed[]=previousepisode&embed[]=nextepisode`)).json();
          const e = j._embedded || {};
          const pe = e.previousepisode, ne = e.nextepisode;
          live.tm[id] = {
            prev: pe ? { season: pe.season, number: pe.number } : null,
            next: ne ? { season: ne.season, number: ne.number, at: Date.parse(ne.airstamp) / 1000 } : null,
          };
        } catch { /* skip this show */ }
      }));
    }
    live.at = now();
    LS.set('live', live);
  } catch { return; }
  derive(); render(); if (detail) renderDetail();
  const grew = shows.filter(s => s.new > (before[s.sid] || 0));
  if (grew.length) notifyNew(grew);
  return alDown;
}

function notifyNew(list) {
  const text = list.slice(0, 4).map(s => `${s.title} (${fa(s.new)})`).join('، ') + (list.length > 4 ? ' و…' : '');
  showBanner(`قسمت جدید اومده برای ${fa(list.length)} سریال`, false, list.slice(0, 8));
  if (LS.get('notify', false) && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification('Lost Memories: قسمت جدید', {
      body: text, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'fa', dir: 'rtl', tag: 'new-episodes' })).catch(() => {});
  }
}

// ------------------------------------------------------------------ render
const STATE = { new: 'قسمت جدید', behind: 'نیمه‌کاره', waiting: 'منتظر پخش', done: 'تموم‌شده', unknown: 'نامعلوم' };
const FILTERS = [['all', 'همه'], ['new', 'قسمت جدید'], ['behind', 'نیمه‌کاره'], ['waiting', 'منتظر پخش'], ['done', 'تموم‌شده'], ['wish', '📌 خواهم دید']];
let drawn = '';            // what the list showed last time: entrance animations only when that changes

function setDrawer(id, open) {
  $('#' + id).classList.toggle('open', open);
  syncToggles();
}
// the filters drawer: type (series view only) and genre; an active one shows as a dot and as a chip
const filtered = () => !!genre || (view === 'shows' && kind !== 'all');
const kindOk = s => kind === 'all' || (kind === 'anime') === (s.kind === 'anime');
function syncToggles() {
  $('#searchToggle').classList.toggle('on', $('#searchDrawer').classList.contains('open') || !!$('#q').value);
  $('#filterToggle').classList.toggle('on', $('#filterDrawer').classList.contains('open') || filtered());
  $('#filterDot').hidden = !filtered();
}
function drawKind() {
  $('#kindSeg').hidden = view !== 'shows';
  $('#kindSeg').replaceChildren(...[['all', 'همه'], ['anime', 'انیمه'], ['series', 'سریال']].map(([k, t]) =>
    h('button', { class: kind === k ? 'on' : '', onclick: () => setKind(k) }, t)));
}
function setKind(k) { kind = k; LS.set('kind', kind); render(); window.scrollTo(0, 0); }

function render() {
  const q = norm($('#q').value);
  const listView = view === 'shows' || view === 'movies';
  $('.search').classList.toggle('has', !!q);
  for (const id of ['#searchToggle', '#filterToggle']) $(id).hidden = !listView;
  if (!listView) { setDrawer('searchDrawer', false); setDrawer('filterDrawer', false); }
  syncToggles();
  drawKind();
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  const nl = sentLinks().length;                     // links waiting from the PC: a badge on «سریال‌ها»
  $('#navLinks').hidden = !nl;
  $('#navLinks').textContent = fa(nl);
  $('#navWarn').hidden = !((snap && snap.health && snap.health.warnings) || []).length;
  const main = $('#main');
  const key = [view, filter, genre, q].join('|');
  main.classList.toggle('quiet', key === drawn);
  drawn = key;
  $('#genres').replaceChildren();
  if (view === 'more') { $('#chips').replaceChildren(); return main.replaceChildren(renderMore()); }
  if (!snap) {
    $('#chips').replaceChildren();
    return main.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'big' }, '🎞'),
      PC_PREVIEW ? 'در حال خوندن…' : 'هنوز اطلاعاتی نیومده. اگه اولین باره، از «بیشتر» اتصال رو تنظیم کن.'));
  }
  if (view === 'schedule') { $('#chips').replaceChildren(); return main.replaceChildren(renderSchedule()); }
  const words = q.split(' ').filter(Boolean);
  if (view === 'movies') {
    const all = (snap.movies || []).filter(m => !m.wish);
    genreChips(all);
    const mchip = (k, t, n) => h('button', { class: 'chip' + (movieFilter === k ? ' on' : ''), onclick: () => { movieFilter = k; render(); window.scrollTo(0, 0); } },
      t, h('span', { class: 'n' }, fa(n)));
    $('#chips').replaceChildren(...[...pinnedChips(), mchip('all', 'همه‌ی فیلم‌ها', all.length),
      mchip('seen', 'دیده‌شده', all.filter(m => m.files_deleted).length), mchip('have', 'فایلش هست', all.filter(m => m.files.length).length)].filter(Boolean));
    const ms = all.filter(m => hasGenre(m) && (movieFilter === 'all' || (movieFilter === 'seen' ? m.files_deleted : m.files.length)) && (!words.length || words.every(w => movieHay(m).includes(w))));
    return main.replaceChildren(ms.length ? h('div', { class: 'posters' }, ms.map(posterEl)) : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🎬'), 'فیلمی پیدا نشد.'));
  }
  const wishMovies = (snap.movies || []).filter(m => m.wish && !wishGone(m.key));
  const real = shows.filter(s => !s.wish && kindOk(s));
  const counts = { all: real.length, wish: shows.filter(s => s.wish && !wishGone(s.sid)).length + wishMovies.length + wishPending().length };
  for (const s of real) counts[s.state] = (counts[s.state] || 0) + 1;
  $('#chips').replaceChildren(...[...pinnedChips(), ...FILTERS.map(([k, t]) => h('button', { class: 'chip st-' + k + (filter === k && !words.length ? ' on' : ''),
    onclick: () => { filter = k; $('#q').value = ''; render(); window.scrollTo(0, 0); } },
    k === 'new' ? h('i', { class: 'd' }) : null, t, h('span', { class: 'n' }, fa(counts[k] || 0))))].filter(Boolean));
  // with the type on «همه», films matching a search or a genre get their own section below (they stay out of
  // the series list itself): a search for a film, or a film-only genre, must not look like "nothing found"
  const allFilms = kind === 'all' ? (snap.movies || []).filter(m => !m.wish) : [];
  genreChips([...shows.filter(s => kindOk(s) && (!s.wish || filter === 'wish')), ...allFilms]);
  if (filter === 'wish' && !words.length) return main.replaceChildren(renderWishPhone());
  const list = shows.filter(s => hasGenre(s) && kindOk(s) && (words.length ? words.every(w => s._hay.includes(w)) : (!s.wish && (filter === 'all' || s.state === filter))));
  const films = words.length || genre ? allFilms.filter(m => hasGenre(m) && words.every(w => movieHay(m).includes(w))) : [];
  main.replaceChildren(...[!words.length ? sentStrip() : null,
    list.length ? h('div', { class: 'list' }, list.map(card))
      : films.length ? h('div', { class: 'meta', style: 'margin:4px 2px 0' }, 'سریالی پیدا نشد.')
      : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🔎'), 'چیزی پیدا نشد.'),
    films.length ? [h('div', { class: 'section' }, `سینمایی (${fa(films.length)})`), h('div', { class: 'posters' }, films.map(posterEl))] : null].flat().filter(Boolean));
}

const movieHay = m => m._hay || (m._hay = norm([m.title, m.alt, m.year, ...(m.genres || []), ...m.files.map(f => f.file)].join(' ')));
// genres: chips in the genre drawer (only those present in the current view, most common first)
const hasGenre = x => !genre || (x.genres || []).includes(genre);
function genreChips(items) {
  const c = {};
  for (const x of items) for (const g of x.genres || []) c[g] = (c[g] || 0) + 1;
  const list = Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fa'));
  if (genre && !c[genre]) genre = '';
  $('#genres').replaceChildren(h('button', { class: 'chip' + (!genre ? ' on' : ''), onclick: () => pickGenre('') }, 'همه‌ی ژانرها'),
    ...list.map(([g, n]) => h('button', { class: 'chip' + (genre === g ? ' on' : ''), onclick: () => pickGenre(g) }, g, h('span', { class: 'n' }, fa(n)))));
}
// active filters stay visible in the main chip row while the drawer is closed (tap = remove)
function pinnedChips() {
  if ($('#filterDrawer').classList.contains('open')) return [];
  const x = () => h('span', { class: 'x', 'aria-label': 'برداشتن فیلتر' }, '×');
  return [view === 'shows' && kind !== 'all' ? h('button', { class: 'chip pinned', onclick: () => setKind('all') }, kind === 'anime' ? 'انیمه' : 'سریال', x()) : null,
    genre ? h('button', { class: 'chip pinned', onclick: () => pickGenre(genre) }, '🎭 ' + genre, x()) : null].filter(Boolean);
}
function pickGenre(g) {
  genre = genre === g ? '' : g;
  if ($('#sheet').open) closeSheet();
  if (view !== 'shows' && view !== 'movies') view = 'shows';
  render(); window.scrollTo(0, 0);
}
function genreTags(list, max) {
  const gs = (list || []).slice(0, max || 99);
  return gs.length ? h('div', { class: 'gtags' }, gs.map(g => h('button', { class: 'gtag' + (g === genre ? ' on' : ''),
    onclick: e => { e.stopPropagation(); pickGenre(g); } }, g))) : null;
}

function statusBadge(s) {
  if (s.state === 'new') return h('span', { class: 'badge new' }, `${fa(s.new)} قسمت جدید`);
  if (s.state === 'behind') return h('span', { class: 'badge behind' }, `${fa(s.new)} قسمت مونده`);
  if (s.state === 'waiting') return h('span', { class: 'badge waiting' }, s.upcoming ? `قسمت ${fa(s.upcoming.episode)} ${relTime(s.upcoming.at)}` : 'منتظر فصل بعد');
  if (s.state === 'done') return h('span', { class: 'badge done' }, 'تمومش کردی');
  return h('span', { class: 'badge' }, 'نامعلوم');
}
// the short version that sits on the poster
function posterBadge(s) {
  if (s.wish) return h('span', { class: 'ov-badge' }, '📌 خواهم دید');
  if (s.state === 'new') return h('span', { class: 'ov-badge new' }, h('i'), `${fa(s.new)} جدید`);
  if (s.state === 'behind') return h('span', { class: 'ov-badge behind' }, h('i'), `${fa(s.new)} مونده`);
  if (s.state === 'waiting') return h('span', { class: 'ov-badge waiting' }, h('i'), s.upcoming ? relTime(s.upcoming.at) : 'فصل بعد');
  if (s.state === 'done') return h('span', { class: 'ov-badge' }, '✓ تموم');
  return null;
}
const seasonNum = label => parseInt(String(label).replace(/^S/, '')) || 1;

function nextName(s) {
  const se = s.seasons.find(x => x.idx === s.pos.idx);
  let num = seasonNum(s.pos.label), ep = s.pos.episode + 1;
  if (se && se.episodes && ep > se.episodes) {
    const nx = s.seasons.find(x => x.idx > s.pos.idx);
    if (nx) { num = seasonNum(nx.label); ep = 1; }
  }
  return s.multi_season && s.kind !== 'anime' ? `${s.title} S${String(num).padStart(2, '0')}E${String(ep).padStart(2, '0')}`
    : s.multi_season && num > 1 ? `${s.title} Season ${num} ${ep}` : `${s.title} ${ep}`;
}
async function copyNext(s, btn) {
  const t = nextName(s);
  try { await navigator.clipboard.writeText(t); toast('کپی شد: ' + t); }
  catch { toast(t); }
  if (btn) {                                         // brief ✓ on the button itself
    const old = [...btn.childNodes];
    btn.classList.add('ok'); btn.replaceChildren(icon('check', 13), 'کپی شد');
    setTimeout(() => { btn.classList.remove('ok'); btn.replaceChildren(...old); }, 1500);
  }
}
let popSid = null;          // the card whose number just changed gets a small "pop"

function card(s) {
  const p = s.pos;
  const total = p.season_episodes || p.season_aired;
  const pct = total ? Math.min(100, p.episode / total * 100) : 0;
  const alt = [...new Set([s.alt, s.native])].filter(t => t && t.toLowerCase() !== s.title.toLowerCase()).join(' · ');
  const stop = e => e.stopPropagation();
  const step = d => { popSid = s.sid; if (navigator.vibrate) navigator.vibrate(10); setOverride(s, p.idx, p.episode + d); };
  const pop = popSid === s.sid;
  if (pop) setTimeout(() => { popSid = null; }, 0);
  return h('div', { class: 'card st-' + s.state, onclick: () => openDetail(s) },
    h('div', { class: 'poster-col' }, coverEl(s.cover, s.title, 'cover'), posterBadge(s)),
    h('div', { class: 'cbody' },
      h('div', { class: 'title ltr' }, s.title),
      alt ? h('div', { class: 'alt ltr' }, alt) : null,
      genreTags(s.genres, 3),
      s.mine || s.override ? h('div', { class: 'badges' }, h('span', { class: 'badge mine' }, s.mine ? 'تغییر گوشی' : 'دستی')) : null,
      h('div', { class: 'meter-row' }, total ? h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })) : h('div', { class: 'meter-gap' }),
        h('small', {}, [s.multi_season ? `فصل ${fa(seasonNum(p.label))}` : null, total ? `${fa(p.episode)}/${fa(total)}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'card-foot' },
        h('div', { class: 'pos' + (pop ? ' pop' : '') }, ...(s.wish ? ['هنوز شروع نکردی'] : ['تا ', h('b', {}, `قسمت ${fa(p.episode)}`)])),
        h('div', { class: 'stepper', onclick: stop },
          h('button', { 'aria-label': 'یه قسمت عقب‌تر', onclick: () => step(-1) }, icon('minus')),
          h('button', { class: 'plus', 'aria-label': 'یه قسمت جلوتر', onclick: () => step(1) }, icon('plus')),
          s.new ? h('i', { class: 'sep' }) : null,
          s.new ? h('button', { class: 'copy-next', title: 'کپی اسم قسمت بعد', onclick: e => copyNext(s, e.currentTarget) }, icon('copy', 13), 'قسمت بعد') : null))));
}

function posterEl(m) {
  return h('div', { class: 'poster', role: 'button', tabindex: '0', onclick: () => openMovie(m) },
    h('div', { class: 'img' }, m.cover ? h('img', { class: 'img', src: m.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      onerror: e => e.target.remove() }) : '🎬',
      m.year ? h('span', { class: 'yr' }, faYear(m.year)) : null,
      m.files_deleted ? h('span', { class: 'tag' }, '✓ دیده‌شده') : null),
    h('div', { class: 't ltr' }, m.title),
    genreTags(m.genres, 2));
}

// ------------------------------------------------------------------ links sent from the PC (for ADM)
// The PC fetches download links (it holds the DigiMoviez / NineAnime logins) and queues them in its
// snapshot; here they're handed to ADM: an Android intent opens ADM with the link, or copy / share.
const ADM_PKG = { free: 'com.dv.adm', pro: 'com.dv.adm.pay' };
const BRIDGE_WANTED = 3;          // Code.gs version this app expects (film search for «خواهم دید»)
const dismissed = () => LS.get('dismissedLinks', {});
function sentLinks() {
  const all = (snap && snap.phone_links) || {}, gone = dismissed();
  return Object.entries(all).filter(([k, v]) => (v.items || []).length && gone[k] !== v.sent_at && (v.expires || v.sent_at + 4 * 86400) > now() - 3600)
    .sort((a, b) => b[1].sent_at - a[1].sent_at);
}
function admHref(url) {
  const m = /^(https?):\/\/(.*)$/.exec(url);
  if (!m) return url;
  const pkg = ADM_PKG[LS.get('admPkg', 'free')] || ADM_PKG.free;
  return `intent://${m[2]}#Intent;scheme=${m[1]};package=${pkg};S.browser_fallback_url=${encodeURIComponent(url)};end`;
}
async function copyLinks(urls) {
  try { await navigator.clipboard.writeText(urls.join('\n')); toast(urls.length > 1 ? `${fa(urls.length)} لینک کپی شد؛ توی ADM «افزودن لینک» رو بزن` : 'لینک کپی شد'); }
  catch { toast('کپی نشد'); }
}
async function shareLinks(urls, title) {
  if (navigator.share) { try { await navigator.share({ title, text: urls.join('\n') }); return; } catch { return; } }
  copyLinks(urls);
}
const openGroups = new Set();                     // sent-link groups the user expanded
function linkGroup(key, v, withTitle) {
  const urls = v.items.map(i => i.url);
  const until = v.expires || v.sent_at + 4 * 86400;
  const left = until - now();
  // the group header already says the title: rows keep only "فصل ۴ · قسمت ۱"
  const label = i => withTitle && i.label && i.label.startsWith(v.title + ' · ') ? i.label.slice(v.title.length + 3) : (i.label || v.title);
  const SHORT = 6, long = v.items.length > SHORT + 2 && !openGroups.has(key);
  const items = long ? v.items.slice(0, SHORT) : v.items;
  return h('div', { class: 'lgroup' },
    h('div', { class: 'lhead' },
      withTitle ? h('b', { class: 'ltr' }, v.title) : h('b', {}, '📥 لینک‌های فرستاده‌شده'),
      h('span', { class: 'meta' }, `${relTime(v.sent_at)} · ${left > 0 ? 'لینک‌ها ' + relTime(until) + ' منقضی می‌شن' : 'لینک‌ها منقضی شدن؛ از کامپیوتر دوباره بفرست'}`)),
    h('div', { class: 'lrows' }, items.map(i => h('div', { class: 'lrow' },
      h('div', { class: 'lt' }, h('span', {}, label(i)), h('small', {}, [i.quality, i.size, i.dubbed ? 'دوبله' : null].filter(Boolean).join(' · '))),
      h('a', { class: 'adm', href: admHref(i.url), title: i.file }, '⬇ ADM'),
      h('button', { class: 'lc', 'aria-label': 'کپی لینک', onclick: () => copyLinks([i.url]) }, icon('copy', 14)))),
      long ? h('button', { class: 'btn lmore', onclick: () => { openGroups.add(key); render(); refreshSheet(); } },
        `نمایش همه (${fa(v.items.length)})`) : null),
    h('div', { class: 'lact' },
      urls.length > 1 ? h('button', { class: 'btn primary', onclick: () => copyLinks(urls) }, `📋 کپی همه (${fa(urls.length)})`) : null,
      h('button', { class: 'btn', onclick: () => shareLinks(urls, v.title) }, '📤 اشتراک'),
      h('button', { class: 'btn', onclick: () => { const d = dismissed(); d[key] = v.sent_at; LS.set('dismissedLinks', d); render(); refreshSheet(); } }, 'برداشتن')));
}
// one line at the top of the list; the links themselves open in a sheet (they used to fill the first screen)
function sentStrip() {
  const list = sentLinks();
  if (!list.length) return null;
  const n = list.reduce((a, [, v]) => a + v.items.length, 0);
  return h('button', { class: 'sent-strip', onclick: openSent }, icon('download', 17),
    h('span', {}, `${fa(n)} لینک دانلود از سیستم`, h('small', {}, list.map(([, v]) => v.title).slice(0, 3).join('، ') + (list.length > 3 ? ' و…' : ''))),
    h('b', {}, 'باز کردن'));
}
function openSent() { detail = { sent: true }; openSheet('لینک‌های فرستاده‌شده از سیستم'); renderSent(); }
function renderSent() {
  const list = sentLinks();
  setBody(h('div', { class: 'meta', style: 'margin:12px 2px' }, '«ADM» لینک رو مستقیم توی ADM باز می‌کنه؛ «کپی همه» برای افزودن چندتا با هم. لینک‌ها چند روز بعد منقضی می‌شن.'),
    list.length ? list.map(([k, v]) => h('div', { class: 'box' }, linkGroup(k, v, true))) : h('div', { class: 'empty' }, h('span', { class: 'big' }, '📥'), 'لینکی نمونده.'));
}
const refreshSheet = () => { if (!detail) return; if (detail.sent) renderSent(); else renderDetail(); };

// ------------------------------------------------------------------ «خواهم دید» (wishlist)
// Shows and films added here (on the PC or on this phone) wait in their own list; a "+" or the first
// downloaded file moves a show to the main list. The phone saves what it adds in state-phone.json;
// the PC fills in the full show (seasons, episodes, links) from AniList / TVmaze.
const wishGone = key => (phone.wishlist[key] || {}).removed;
// a wishlist / search key may be a later season's AniList id; the PC keeps the show under the franchise root
function showFor(key) {
  const exact = shows.find(s => s.sid === key);
  if (exact || !key.startsWith('al:')) return exact;
  const id = +key.slice(3);
  return shows.find(s => s.sid.startsWith('al:') && s.seasons.some(se => se.media_id === id));
}
// added on this phone but not in the PC's snapshot yet
function wishPending() {
  const movies = new Set(((snap && snap.movies) || []).map(m => m.key));
  return Object.entries(phone.wishlist || {}).filter(([k, w]) => !w.removed && !movies.has(k) && !showFor(k));
}
function renderWishPhone() {
  const ws = shows.filter(s => s.wish && !wishGone(s.sid));
  const wm = ((snap && snap.movies) || []).filter(m => m.wish && !wishGone(m.key));
  const pend = wishPending();
  return h('div', {},
    h('div', { class: 'wish-top' }, h('span', { class: 'meta' }, 'با «+» یا وقتی اولین فایلش پیدا بشه، خودش می‌ره توی لیست اصلی.'),
      h('button', { class: 'btn primary', onclick: openWishAdd }, '➕ افزودن')),
    !ws.length && !wm.length && !pend.length ? h('div', { class: 'empty' }, h('span', { class: 'big' }, '📌'), 'هنوز چیزی اضافه نکردی.') : null,
    ws.length ? h('div', { class: 'list' }, ws.map(card)) : null,
    wm.length ? [h('div', { class: 'section' }, 'سینمایی'), h('div', { class: 'posters' }, wm.map(posterEl))] : null,
    pend.length ? [h('div', { class: 'section' }, 'تازه اضافه شده (بعد از همگام شدن با کامپیوتر کامل می‌شه)'),
      h('div', { class: 'list' }, pend.map(([k, w]) => h('div', { class: 'card' },
        h('div', { class: 'poster-col' }, coverEl(w.cover, w.title, 'cover')),
        h('div', { class: 'cbody' }, h('div', { class: 'title ltr' }, w.title),
          h('div', { class: 'meta' }, [KIND_FA[w.kind], faYear(w.year)].filter(Boolean).join(' · ')),
          h('div', { class: 'card-foot' }, h('span', {}), h('button', { class: 'btn', onclick: e => { e.stopPropagation(); wishRemove(k); } }, '🗑 حذف'))))))] : null);
}
const KIND_FA = { anime: 'انیمه', series: 'سریال', movie: 'سینمایی' };
function wishRemove(key) {
  phone.wishlist[key] = { removed: true, updated: now() };
  // the phone may have added it under another season's id: drop that entry too
  const s = shows.find(x => x.sid === key);
  if (s) for (const se of s.seasons) {
    const k = 'al:' + se.media_id;
    if (se.media_id && k !== key && phone.wishlist[k] && !phone.wishlist[k].removed) phone.wishlist[k] = { removed: true, updated: now() };
  }
  LS.set('phone', phone); queuePush(); render();
  if ($('#sheet').open) closeSheet();
  toast('از «خواهم دید» برداشته شد');
}
let wishKind = 'all';
function openWishAdd() {
  detail = { wish: true };
  openSheet('➕ افزودن به «خواهم دید»');
  const input = h('input', { type: 'search', placeholder: 'اسم انیمه، سریال یا فیلم…', enterkeyhint: 'search', class: 'wish-q' });
  const res = h('div', { class: 'wish-res' });
  const kinds = h('div', { class: 'seg' });
  const drawKinds = () => kinds.replaceChildren(...[['all', 'همه'], ['anime', 'انیمه'], ['series', 'سریال'], ['movie', 'فیلم']].map(([k, t]) =>
    h('button', { class: wishKind === k ? 'on' : '', onclick: () => { wishKind = k; drawKinds(); go(); } }, t)));
  const go = async () => {
    const q = input.value.trim();
    if (!q) return;
    res.replaceChildren(h('div', { class: 'meta' }, 'در حال جستجو…'));
    const out = await discoverPhone(q, wishKind);
    res.replaceChildren(...(r_err && out.length ? [h('div', { class: 'meta', style: 'color:var(--warn)' }, r_err)] : []), ...(out.length ? out.map(r => {
      const sh = showFor(r.key);
      const have = !!sh && !sh.wish || ((snap && snap.movies) || []).some(m => !m.wish && (m.key === r.key || (r.imdb && m.imdb === r.imdb)));
      const wished = !have && ((phone.wishlist[r.key] && !phone.wishlist[r.key].removed) || (!!sh && sh.wish));
      const b = h('button', { class: 'btn' + (have || wished ? '' : ' primary'), disabled: have || wished ? '' : null }, have ? '✓ توی آرشیو' : wished ? '✓ اضافه شده' : '+ افزودن');
      b.onclick = () => {
        phone.wishlist[r.key] = { kind: r.kind, title: r.title, cover: r.cover, year: r.year, imdb: r.imdb, anilist: r.anilist,
          url: r.url, added: now(), updated: now() };
        LS.set('phone', phone); queuePush();
        b.disabled = true; b.textContent = '✓ اضافه شد'; b.classList.remove('primary');
        toast(`«${r.title}» رفت توی خواهم دید`);
      };
      return h('div', { class: 'wish-item' }, coverEl(r.cover, r.title, 'cover'),
        h('div', { class: 'cbody' }, h('div', { class: 'title ltr' }, r.title), r.alt ? h('div', { class: 'alt ltr' }, r.alt) : null,
          h('div', { class: 'meta' }, [KIND_FA[r.kind], r.year ? faYear(r.year) : null, r.info].filter(Boolean).join(' · ')), b));
    }) : [h('div', { class: 'meta' }, r_err || 'چیزی پیدا نشد. اسم انگلیسی یا ژاپنی رو امتحان کن.')]));
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  drawKinds();
  setBody(h('div', { class: 'box' }, input, h('div', { class: 'theme-picker', style: 'margin-top:10px' }, kinds),
    h('div', { class: 'meta', style: 'margin-top:8px' }, 'انیمه از AniList، سریال از TVmaze، فیلم از IMDb.')), res);
  setTimeout(() => input.focus(), 100);
}
let r_err = '';
async function discoverPhone(q, kind) {
  r_err = '';
  const out = [];
  const jobs = [];
  // a catalogue that doesn't answer is named (AniList once switched its API off for days), not passed off as "nothing found"
  const down = name => e => { r_err = [r_err, `${name} فعلاً جواب نمی‌ده${e && e.message ? ' (' + e.message + ')' : ''}`].filter(Boolean).join(' · '); };
  if (kind === 'all' || kind === 'anime' || kind === 'movie') jobs.push((async () => {
    const r = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: 'query($q:String){Page(perPage:10){media(search:$q,type:ANIME,sort:SEARCH_MATCH){id format episodes seasonYear title{english romaji} coverImage{large}}}}', variables: { q } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.data) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'HTTP ' + r.status);
    for (const m of (j.data && j.data.Page.media) || []) {
      const movie = m.format === 'MOVIE';
      if ((kind === 'anime' && movie) || (kind === 'movie' && !movie)) continue;
      out.push({ key: movie ? 'wm:al:' + m.id : 'al:' + m.id, kind: movie ? 'movie' : 'anime', title: m.title.english || m.title.romaji,
        alt: m.title.english ? m.title.romaji : null, year: m.seasonYear, cover: m.coverImage && m.coverImage.large, anilist: movie ? m.id : null,
        url: 'https://anilist.co/anime/' + m.id, info: [m.format, m.episodes ? fa(m.episodes) + ' قسمت' : null].filter(Boolean).join(' · ') });
    }
  })().catch(down('AniList')));
  if (kind === 'all' || kind === 'series') jobs.push((async () => {
    const r = await fetch('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q));
    if (r.status === 502) return;                   // TVmaze's way of saying "nothing found"
    if (!r.ok) throw new Error('HTTP ' + r.status);
    for (const hit of await r.json()) {
      const t = hit.show;
      out.push({ key: 'tm:' + t.id, kind: 'series', title: t.name, year: t.premiered ? +t.premiered.slice(0, 4) : null,
        cover: t.image && t.image.medium, url: t.url, info: [t.type, t.status].filter(Boolean).join(' · ') });
    }
  })().catch(down('TVmaze')));
  if ((kind === 'all' || kind === 'movie') && !PC_PREVIEW) jobs.push((async () => {
    try {
      const j = await bridge('imdb_search', { q });
      for (const m of j.items || []) out.push({ key: 'wm:imdb:' + m.id, kind: 'movie', title: m.title, year: m.year, cover: m.cover,
        imdb: m.id, url: `https://www.imdb.com/title/${m.id}/`, info: m.stars });
    } catch (e) {
      r_err = /unknown action/.test(e.message || '') ? 'برای جستجوی فیلم، پل (Code.gs) باید یه بار دوباره دیپلوی بشه؛ تا اون موقع فیلم‌ها رو از کامپیوتر اضافه کن.'
        : 'جستجوی فیلم نشد: ' + (e.message || e);
    }
  })());
  await Promise.all(jobs.map(p => p.catch(() => {})));
  return out;
}

// ------------------------------------------------------------------ schedule
function renderSchedule() {
  const items = [];
  for (const s of shows) {
    for (const se of s.seasons) {
      if (se.next && se.next.at > now() - 3600 && se.next.at < now() + 8 * 86400) items.push({ s, se, ...se.next });
    }
  }
  items.sort((a, b) => a.at - b.at);
  const ready = shows.filter(s => s.state === 'new' && !s.wish);
  const readyRow = ready.length ? h('div', { class: 'ready' },
    h('div', { class: 'section' }, icon('sparkles', 14), ` قسمت جدیدش اومده (${fa(ready.length)} سریال)`),
    h('div', { class: 'ready-row' }, ready.map(s => h('button', { class: 'rmini', onclick: () => openDetail(s) },
      coverEl(s.cover, s.title, s.cover ? '' : 'ph'), h('span', { class: 'ltr' }, s.title), h('small', {}, `${fa(s.new)} قسمت جدید`))))) : null;
  if (!items.length) return h('div', {}, readyRow, h('div', { class: 'empty' }, h('span', { class: 'big' }, '📅'), 'تا یه هفته‌ی دیگه قسمت جدیدی از سریال‌هات پخش نمی‌شه.'));
  const days = new Map();
  for (const it of items) {
    const d = new Date(it.at * 1000);
    const key = d.toDateString();
    if (!days.has(key)) days.set(key, { d, list: [] });
    days.get(key).list.push(it);
  }
  const today = new Date().toDateString(), tomorrow = new Date(Date.now() + 86400000).toDateString();
  return h('div', {}, readyRow, h('div', { class: 'section' }, 'تا یه هفته‌ی دیگه (به وقت گوشی)'),
    [...days.values()].map(({ d, list }) => h('div', { class: 'day' },
      h('h3', {}, h('b', { class: d.toDateString() === today ? 'today' : '' },
        d.toDateString() === today ? 'امروز' : d.toDateString() === tomorrow ? 'فردا' : d.toLocaleDateString('fa-IR', { weekday: 'long' })),
        h('span', {}, d.toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' }) + ` · ${fa(list.length)} قسمت`)),
      h('div', { class: 'slots' }, list.map(it => h('div', { class: 'slot', onclick: () => openDetail(it.s) },
        coverEl(it.s.cover, it.s.title, it.s.cover ? '' : 'ph'),
        h('div', { class: 'info' }, h('span', { class: 'ltr' }, it.s.title),
          h('div', { class: 'meta' }, `قسمت ${fa(it.episode)}` + (it.s.multi_season ? ` · ${it.se.label}` : ''))),
        h('div', { style: 'display:flex; flex-direction:column; align-items:flex-end; gap:4px' },
          h('div', { class: 'time' }, new Date(it.at * 1000).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })),
          h('span', { class: 'cd' }, relTime(it.at)))))))));
}

// ------------------------------------------------------------------ details
function ranges(nums) {
  const n = [...new Set(nums)].sort((a, b) => a - b), out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(i === j ? fa(n[i]) : `${fa(n[i])}–${fa(n[j])}`);
    i = j;
  }
  return out.length > 6 ? `${fa(n.length)} قسمت بین ${fa(n[0])} و ${fa(n[n.length - 1])}` : out.join('، ');
}

const setBody = (...nodes) => $('#sheetBody').replaceChildren(...nodes.flat().filter(n => n != null && n !== false));

function openSheet(title) {
  $('#sheetTitle').textContent = title;
  const d = $('#sheet');
  if (!d.open) { d.showModal(); history.pushState({ sheet: 1 }, ''); }
  $('#sheetBody').scrollTop = 0;
}
function closeSheet() { if ($('#sheet').open) history.back(); }
window.addEventListener('popstate', () => { if ($('#sheet').open) { $('#sheet').close(); detail = null; } });

function openDetail(s) { detail = { sid: s.sid, idx: s.pos.idx, ep: null }; openSheet(s.title); renderDetail(); }

// blurred cover behind the top of a details sheet
function hero(cover, ...kids) {
  return h('div', { class: 'hero' }, cover ? h('div', { class: 'bgimg', style: `background-image:url("${cover.replace(/"/g, '')}")` }) : null, ...kids);
}
// how far a position is into the whole show (for the per-source bars)
function absEp(s, idx, ep) {
  return s.seasons.filter(x => x.idx < idx).reduce((a, x) => a + (x.episodes || x.aired || 0), 0) + ep;
}

function renderDetail() {
  if (!detail || detail.movie) return;
  const s = shows.find(x => x.sid === detail.sid);
  if (!s) return;
  const se = s.seasons.find(x => x.idx === detail.idx) || s.seasons[0];
  const owned = (s.episodes_owned || []).filter(e => e.idx === se.idx);
  const byEp = {};
  for (const e of owned) (byEp[e.episode] = byEp[e.episode] || []).push(e);
  const total = Math.max(se.episodes || 0, se.aired || 0, ...owned.map(e => e.episode), 0);
  const seenUpTo = s.pos.idx > se.idx ? Infinity : s.pos.idx === se.idx ? s.pos.episode : 0;
  const missing = [];
  for (let e = 1; e <= Math.min(total, se.aired || total); e++) if (!byEp[e]) missing.push(e);
  const alt = [...new Set([s.alt, s.native])].filter(t => t && t.toLowerCase() !== s.title.toLowerCase()).join(' · ');

  const tiles = [];
  for (let e = 1; e <= total; e++) {
    const c = byEp[e] || [];
    const cls = ['tile', c.some(x => srcKind(x.source) === 'pc') ? 'pc' : c.length ? 'phone' : 'none', e <= seenUpTo ? 'seen' : '', detail.ep === e ? 'sel' : ''].join(' ');
    tiles.push(h('button', { class: cls, onclick: () => { detail.ep = e; renderDetail(); } }, fa(e)));
  }
  let panel = null;
  if (detail.ep) {
    const c = byEp[detail.ep] || [];
    panel = h('div', { class: 'box copies' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, `قسمت ${fa(detail.ep)}` + (s.multi_season ? ` · ${se.label}` : '')),
        h('button', { class: 'btn primary', onclick: () => setOverride(s, se.idx, detail.ep) }, 'تا اینجا دیدم')),
      c.length ? c.map(x => h('div', { class: 'copy' }, h('span', {}, srcLabel(x.source) + (x.size ? ' · ' + bytes(x.size) : '') + (x.mtime ? ' · ' + date(x.mtime) : '')),
        h('span', { class: 'f' }, x.file))) : h('div', { class: 'meta' }, 'این قسمت رو هیچ‌جا نداری.'));
  }
  const aired = s.seasons.reduce((a, x) => a + (x.aired || x.episodes || 0), 0);
  const sp = s.source_progress || [];

  setBody(
    hero(s.cover, h('div', { class: 'dhead' }, coverEl(s.cover, s.title, 'cover'),
      h('div', { style: 'min-width:0' },
        h('h2', { class: 'ltr' }, s.title), alt ? h('div', { class: 'alt ltr' }, alt) : null,
        h('div', { class: 'pos', style: 'margin-top:6px' }, 'تا ', h('b', {}, `قسمت ${fa(s.pos.episode)}`), s.multi_season ? ` · فصل ${fa(seasonNum(s.pos.label))}` : ''),
        h('div', { class: 'badges', style: 'margin-top:6px' }, statusBadge(s), h('span', { class: 'badge' }, s.kind === 'anime' ? 'انیمه' : 'سریال')),
        genreTags(s.genres),
        s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'meta', style: 'display:inline-block; margin-top:6px' }, 'صفحه‌ی سریال ↗') : null))),
    s.wish ? h('div', { class: 'steps' },
      h('button', { class: 'btn primary', onclick: () => setOverride(s, s.pos.idx, 1) }, '▶ شروع کردم (قسمت ۱)'),
      h('button', { class: 'btn', onclick: () => wishRemove(s.sid) }, '🗑 حذف از خواهم دید')) : null,
    s.wish ? null : nextBar(s),
    s.wish ? null : h('div', { class: 'steps' },
      h('span', { class: 'meta' }, 'جایی که هستی:'),
      h('button', { class: 'step plus', 'aria-label': 'یه قسمت جلوتر', onclick: () => setOverride(s, s.pos.idx, s.pos.episode + 1) }, '+'),
      h('button', { class: 'step', 'aria-label': 'یه قسمت عقب‌تر', onclick: () => setOverride(s, s.pos.idx, s.pos.episode - 1) }, '−'),
      s.override || s.mine ? h('button', { class: 'step txt', onclick: () => clearOverride(s) }, '↺ خودکار') : null),
    (() => { const v = ((snap && snap.phone_links) || {})[s.sid]; return v && (v.items || []).length ? h('div', { class: 'box' }, linkGroup(s.sid, v, false)) : null; })(),
    h('div', { class: 'box' }, h('h3', {}, 'کجا تا کجا'),
      sp.length ? h('div', { class: 'srcs' }, sp.map((x, i) => {
        const mine = owned.filter(e => e.source === x.source).map(e => e.episode);
        const pct = aired ? Math.min(100, absEp(s, x.idx, x.episode) / aired * 100) : 0;
        return h('div', { class: 'src-card' + (i === 0 && sp.length > 1 ? ' lead' : '') },
          h('div', { class: 'top' }, h('span', { class: 'who' }, srcLabel(x.source)),
            i === 0 && sp.length > 1 ? h('span', { class: 'star' }, '★ جلوترین') : null,
            h('span', {}, `تا قسمت ${fa(x.episode)}` + (s.multi_season ? ` (${x.label})` : ''))),
          h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })),
          h('div', { class: 'r' }, mine.length ? 'این فصل: ' + ranges(mine) : 'از این فصل چیزی نداره'));
      })) : h('div', { class: 'meta' }, 'فایل‌هاش برای آزاد کردن فضا پاک شده؛ جایی که رسیده بودی حفظ شده.')),
    s.seasons.length > 1 ? h('div', { class: 'seasons' }, s.seasons.map(x => h('button', { class: x.idx === se.idx ? 'on' : '',
      onclick: () => { detail.idx = x.idx; detail.ep = null; renderDetail(); } }, x.label + (x.episodes ? ` · ${fa(x.episodes)}` : '')))) : null,
    h('div', { class: 'meta' }, `دارم: ${fa(Object.keys(byEp).length)} از ${fa(total)}` + (missing.length ? ` · ندارم: ${ranges(missing)}` : '')),
    h('div', { class: 'legend' },
      h('span', {}, h('i', { style: 'background:var(--accent)' }), 'روی کامپیوتر'),
      h('span', {}, h('i', { style: 'background:var(--accent-soft);border:1px solid var(--accent)' }), 'فقط گوشی / تلگرام'),
      h('span', {}, h('i', { style: 'border:1px dashed var(--muted)' }), 'ندارم'),
      h('span', {}, h('i', { style: 'width:7px;height:7px;border-radius:50%;background:var(--new)' }), 'دیده‌شده')),
    total ? h('div', { class: 'tiles' }, tiles) : h('div', { class: 'empty' }, 'از این فصل چیزی نیست.'),
    panel);
}

// the next episode in our numbering (a finished season rolls over to the next); null when the show is all seen
function nextOf(s) {
  const se = s.seasons.find(x => x.idx === s.pos.idx);
  if (se && se.episodes && s.pos.episode + 1 > se.episodes) {
    const nx = s.seasons.find(x => x.idx > s.pos.idx);
    return nx ? { idx: nx.idx, episode: 1, label: nx.label } : null;
  }
  return { idx: s.pos.idx, episode: s.pos.episode + 1, label: se ? se.label : s.pos.label };
}
// what to do next: where that episode is, a link the PC sent for it, copy its name, "seen it"
function nextBar(s) {
  const n = nextOf(s);
  if (!n) return h('div', { class: 'nextbar done' }, icon('check', 16), h('span', {}, 'همه‌ی قسمت‌ها رو دیدی.'));
  const se = s.seasons.find(x => x.idx === n.idx) || {};
  const aired = (se.aired || 0) >= n.episode || (!se.aired && !se.next);
  const owned = (s.episodes_owned || []).filter(e => e.idx === n.idx && e.episode === n.episode);
  const v = ((snap && snap.phone_links) || {})[s.sid];
  // the PC labels a sent link "... · قسمت 7" (that source's numbering): only an unambiguous match gets a button
  const hits = v && sentLinks().some(([k]) => k === s.sid) ? (v.items || []).filter(i => +((/قسمت (\d+)$/.exec(i.label || '') || [])[1]) === n.episode) : [];
  const link = hits.length === 1 ? hits[0] : null;
  const where = owned.length ? 'داری: ' + [...new Set(owned.map(e => srcLabel(e.source)))].join('، ')
    : !aired ? (se.next && se.next.episode === n.episode ? 'پخش ' + relTime(se.next.at) : 'هنوز پخش نشده')
    : link ? 'لینکش از سیستم اومده' : 'پخش شده؛ هنوز نداریش';
  return h('div', { class: 'nextbar' + (aired && !owned.length ? ' fresh' : '') },
    h('div', { class: 'nb-t' }, h('span', { class: 'meta' }, 'قسمت بعدی'),
      h('b', {}, (s.multi_season ? `فصل ${fa(seasonNum(n.label))} · ` : '') + `قسمت ${fa(n.episode)}`), h('small', {}, where)),
    h('div', { class: 'nb-acts' },
      link ? h('a', { class: 'btn primary', href: admHref(link.url), title: link.file }, icon('download', 15), 'ADM') : null,
      h('button', { class: 'btn', onclick: e => copyNext(s, e.currentTarget) }, icon('copy', 14), 'کپی اسم'),
      aired ? h('button', { class: 'btn', onclick: () => setOverride(s, n.idx, n.episode) }, icon('check', 14), 'دیدمش') : null));
}

function openMovie(m) {
  detail = { movie: m.key };
  openSheet(m.title);
  setBody(
    hero(m.cover, h('div', { class: 'dhead' }, coverEl(m.cover, '🎬', 'cover'),
      h('div', { style: 'min-width:0' }, h('h2', { class: 'ltr' }, m.title), m.alt ? h('div', { class: 'alt ltr' }, m.alt) : null,
        h('div', { class: 'meta', style: 'margin-top:6px' }, [faYear(m.year), m.stars].filter(Boolean).join(' · ')),
        genreTags(m.genres),
        m.files_deleted || m.seen ? h('div', { class: 'badges', style: 'margin-top:6px' }, h('span', { class: 'badge new' }, '✓ دیده‌شده')) : null,
        m.wish ? h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'badge mine' }, '📌 خواهم دید'),
          h('button', { class: 'btn', onclick: () => wishRemove(m.key) }, '🗑 حذف')) : null,
        m.url ? h('a', { href: m.url, target: '_blank', rel: 'noopener', class: 'meta', style: 'display:inline-block; margin-top:6px' }, 'صفحه‌ی فیلم ↗') : null))),
    (() => { const v = ((snap && snap.phone_links) || {})['mv:' + m.key]; return v && (v.items || []).length ? h('div', { class: 'box' }, linkGroup('mv:' + m.key, v, false)) : null; })(),
    h('div', { class: 'box' }, h('h3', {}, 'کجا دارمش'),
      m.files.length ? m.files.map(f => h('div', { class: 'copy' }, h('span', {}, srcLabel(f.source) + (f.size ? ' · ' + bytes(f.size) : '') + (f.mtime ? ' · ' + date(f.mtime) : '')),
        h('span', { class: 'f' }, f.file))) : h('div', { class: 'meta' }, m.wish ? 'هنوز فایلش رو نداری؛ از کامپیوتر لینکش رو بفرست به گوشی.' : 'دیده‌شده؛ فایلش برای آزاد کردن فضا پاک شده.')));
}

// ------------------------------------------------------------------ more / settings
const moreOpen = () => LS.get('moreOpen', {});
function moreSection(id, ic, title, status, open, ...body) {
  const isOpen = moreOpen()[id] ?? open;
  const d = h('details', { class: 'mbox', open: isOpen ? '' : null },
    h('summary', {}, icon(ic, 18), h('b', {}, title), status ? h('span', { class: 'ms' }, status) : null, icon('chevron-down', 16)),
    h('div', { class: 'mbody' }, ...body));
  d.addEventListener('toggle', () => { const o = moreOpen(); o[id] = d.open; LS.set('moreOpen', o); });
  return d;
}
const devName = n => n === 'phone' ? 'گوشی' : 'سیستم ' + n;
function renderMore() {
  const c = conn();
  const url = h('input', { type: 'url', value: c.url, placeholder: 'https://script.google.com/macros/s/…/exec', inputmode: 'url' });
  const key = h('input', { type: 'password', value: c.key, placeholder: 'رمز پل', autocomplete: 'off' });
  const status = h('div', { class: 'meta', style: 'margin-top:8px' });
  const save = async () => {
    LS.set('conn', { url: url.value.trim(), key: key.value.trim() });
    status.textContent = 'در حال امتحان…';
    try { await bridge('load', { have: 'x' }); status.textContent = '✓ اتصال برقراره'; snapTime = 0; sync(); }
    catch (e) { status.textContent = '✗ ' + (e.message || e); }
  };
  const admInput = h('input', { type: 'file', accept: '.db,application/octet-stream,application/x-sqlite3', hidden: '' });
  const admBar = h('div', { class: 'progress', hidden: '' }, h('i'));
  const admStatus = h('div', { class: 'meta', style: 'margin-top:6px' });
  admInput.addEventListener('change', () => uploadAdm(admInput.files[0], admBar, admStatus));
  const notifyOn = LS.get('notify', false) && 'Notification' in window && Notification.permission === 'granted';
  const H = (snap && snap.health) || null;
  const bv = LS.get('bridgeVer', 0);
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v));
  const pkg = LS.get('admPkg', 'free');
  return h('div', {},
    H && H.warnings.length ? h('div', { class: 'box warnbox' }, icon('triangle-alert', 18), h('div', {}, ...H.warnings.map(w =>
      h('div', {}, h('b', {}, `اطلاعات ${devName(w.device)} ${fa(w.days)} روزه به Drive نرسیده.`),
        h('div', { class: 'meta' }, 'اگه این چند روز اونجا کار کردی، Google Drive اون سیستم رو چک کن.'))))) : null,
    PC_PREVIEW
      ? moreSection('conn', 'smartphone', 'پیش‌نمایش روی کامپیوتر', null, false,
        h('div', { class: 'meta' }, 'این صفحه از روی کامپیوتر باز شده و اطلاعات رو مستقیم از همین سیستم می‌خونه. تغییرات اینجا فقط توی همین مرورگر می‌مونه.'))
      : moreSection('conn', 'external-link', 'اتصال به اطلاعات', c.url && c.key ? 'وصل' : 'تنظیم نشده', !(c.url && c.key),
        h('div', { class: 'meta' }, 'آدرس Web App و رمزی که موقع راه‌اندازی پل Apps Script نشون داده شد.'),
        h('label', {}, 'آدرس پل'), url, h('label', {}, 'رمز'), key,
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: save }, 'ذخیره و امتحان')), status),
    moreSection('sync', 'refresh-cw', 'همگام‌سازی', LS.get('lastSync', 0) ? relTime(LS.get('lastSync', 0)) : null, false,
      kv('اطلاعات از', snap ? `سیستم ${snap.machine} · ${relTime(snap.written_at)}` : '—'),
      kv('تغییرات گوشی', LS.get('dirty', false) ? 'در صف فرستادن' : 'فرستاده شده'),
      kv('بررسی زنده‌ی پخش', live.at ? relTime(live.at) : '—'),
      ...(H ? H.devices.map(d => kv(devName(d.name), d.last ? relTime(d.last) + (d.stale ? ' ⚠' : '') : '—')) : []),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', onclick: () => sync() }, 'همگام‌سازی'),
        h('button', { class: 'btn', onclick: () => checkLive(true).then(alDown => toast(alDown ? 'سریال‌ها بررسی شد؛ AniList فعلاً جواب نمی‌ده و انیمه‌ها از اطلاعات کامپیوتر می‌آن' : 'بررسی شد')) }, 'بررسی قسمت‌های جدید'))),
    moreSection('look', 'palette', 'ظاهر و تم', null, false, LMTheme.picker()),
    moreSection('adm', 'download', 'ADM (دانلود روی گوشی)', pkg === 'pro' ? 'ADM Pro' : 'ADM معمولی', false,
      h('div', { class: 'meta' }, 'لینک‌هایی که از کامپیوتر می‌فرستی، با «ADM» مستقیم توی ADM باز می‌شن. نسخه‌ی ADM گوشیت:'),
      h('div', { class: 'theme-picker', style: 'margin-top:8px' }, h('div', { class: 'seg' }, [['free', 'ADM معمولی'], ['pro', 'ADM Pro']].map(([k, t]) =>
        h('button', { class: pkg === k ? 'on' : '', onclick: () => { LS.set('admPkg', k); render(); } }, t)))),
      PC_PREVIEW ? null : h('div', {}, h('label', {}, 'فرستادن پشتیبان ADM'),
        h('div', { class: 'meta' }, 'توی ADM از منو، پشتیبان بگیر (فایل ADM.db). اینجا انتخابش کن تا بره توی Drive؛ دفعه‌ی بعد که کامپیوتر «آپدیت» کنه، دانلودهای گوشی وارد می‌شن.'),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', onclick: () => admInput.click() }, 'انتخاب فایل ADM.db')),
        admInput, admBar, admStatus)),
    moreSection('notify', 'bell', 'اعلان قسمت جدید', notifyOn ? 'روشن' : 'خاموش', false,
      h('div', { class: 'meta' }, 'هر بار اپ رو باز کنی، پخش سریال‌ها بررسی می‌شه و اگه قسمت جدیدی اومده باشه خبرت می‌کنه.'),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: toggleNotify }, notifyOn ? 'خاموش کردن اعلان' : 'روشن کردن اعلان'))),
    moreSection('about', 'circle-help', 'درباره', `نسخه‌ی ${VERSION}`, false,
      kv('نسخه‌ی اپ', VERSION),
      PC_PREVIEW ? null : kv('نسخه‌ی پل', bv >= BRIDGE_WANTED ? `${fa(bv)} ✓` : bv ? `${fa(bv)} — قدیمیه؛ Code.gs رو دوباره دیپلوی کن` : '—'),
      kv('کتابخونه', snap ? `${fa(shows.filter(s => !s.wish).length)} سریال · ${fa((snap.movies || []).length)} فیلم` : '—')));
}

async function toggleNotify() {
  if (LS.get('notify', false) && Notification.permission === 'granted') { LS.set('notify', false); return render(); }
  if (!('Notification' in window)) return toast('این مرورگر اعلان نداره');
  const p = await Notification.requestPermission();
  LS.set('notify', p === 'granted');
  toast(p === 'granted' ? 'اعلان روشن شد' : 'اجازه‌ی اعلان داده نشد');
  render();
}

async function uploadAdm(file, bar, status) {
  if (!file) return;
  bar.hidden = false; bar.firstChild.style.width = '10%';
  status.textContent = `در حال خوندن ${file.name} (${bytes(file.size)})…`;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...buf.slice(0, 15)) !== 'SQLite format 3') throw new Error('این فایل پشتیبان ADM نیست');
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    bar.firstChild.style.width = '40%';
    status.textContent = 'در حال فرستادن به Drive…';
    const r = await bridge('upload_adm', { base64: btoa(bin) });
    bar.firstChild.style.width = '100%';
    status.textContent = `✓ ذخیره شد: ${r.saved}. دفعه‌ی بعد که کامپیوتر «آپدیت» کنه وارد می‌شه.`;
  } catch (e) {
    status.textContent = '✗ ' + (e.message || e);
  }
}

// ------------------------------------------------------------------ boot
document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => {
  view = b.dataset.view; render(); window.scrollTo(0, 0);
}));
$('#q').addEventListener('input', () => render());
$('#qClear').addEventListener('click', () => { $('#q').value = ''; render(); $('#q').focus(); });
$('#searchToggle').addEventListener('click', () => {
  const open = !$('#searchDrawer').classList.contains('open');
  setDrawer('searchDrawer', open);
  if (open) setTimeout(() => $('#q').focus(), 60);
  else if ($('#q').value) { $('#q').value = ''; render(); }
});
$('#filterToggle').addEventListener('click', () => { setDrawer('filterDrawer', !$('#filterDrawer').classList.contains('open')); render(); });
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && (view === 'shows' || view === 'movies')) {
    e.preventDefault(); setDrawer('searchDrawer', true); $('#q').focus();
  }
});
$('#syncBtn').addEventListener('click', () => sync());
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheet').addEventListener('cancel', e => { e.preventDefault(); closeSheet(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && now() - LS.get('lastSync', 0) > 600) sync(true); });
window.addEventListener('online', () => sync(true));

(async function boot() {
  phone = LS.get('phone', phone);
  phone.overrides = phone.overrides || {};
  phone.wishlist = phone.wishlist || {};
  if (!PC_PREVIEW) {
    const cached = await IDB.get('snap');
    if (cached) { snap = cached.snap; snapTime = cached.snapTime; }
  }
  derive(); render(); updateSyncInfo();
  if ('serviceWorker' in navigator && !PC_PREVIEW) navigator.serviceWorker.register('sw.js').catch(() => {});
  sync(true);
})();
