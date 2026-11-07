// Flat Hunt web UI. Ported from the approved prototype (docs/prototype-index.html); the claude.ai
// storage layer is replaced by a small API client with optimistic updates and periodic refetch.
// No inline styles or scripts anywhere (CSP): dynamic sizes are set through element.style.

/* ---------- small pure helpers (mirrors of src/core/logic.js) ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normText = t => String(t || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function parseJsonText(txt) {
  txt = String(txt || '').trim(); if (!txt) return null;
  try { return JSON.parse(txt); } catch { /* JSON lines? */ }
  const arr = [];
  for (const l of txt.split(/\n/).map(l => l.trim()).filter(Boolean)) { try { arr.push(JSON.parse(l)); } catch { return null; } }
  return arr;
}
function itemsFromJson(data) {
  if (Array.isArray(data)) return { items: data, source: 'scraper' };
  if (data && Array.isArray(data.posts)) return { items: data.posts, source: data.source === 'phone-scan' ? 'phone' : 'scraper' };
  if (data && Array.isArray(data.items)) return { items: data.items, source: 'scraper' };
  if (data && typeof data === 'object') return { items: [data], source: 'scraper' };
  return { items: [], source: 'scraper' };
}
const safeUrl = u => /^https:\/\//i.test(String(u || '')) ? String(u) : '';

/* ---------- icons ---------- */
const I = {
  review: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="16" rx="3"/><path d="M8 21h8"/></svg>',
  keep: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  pass: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  undo: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  later: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  shortlist: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  passed: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/></svg>',
  phone: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  photo: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  filter: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  cards: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="16" rx="2"/></svg>',
  list: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  wa: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z"/></svg>',
  more: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
};

/* ---------- state ---------- */
const STAGES = ['To call', 'Called – waiting', 'Visit booked', 'Visited', 'Negotiating', 'Token paid'];
const DEFAULT_F = { bhk: 'any', type: 'any', max: '', nobroker: false, seek: false, area: 'all' };
const state = {
  listings: [], areas: [], settings: null, runs: [], screen: 'review', mode: 'cards', f: { ...DEFAULT_F }, qShort: '', qPassed: '', sortShort: 'stage',
  loaded: false, stale: false, authProblem: null, lastSync: 0, pending: new Map(), open: null, later: new Map(), laterSeq: 0, front: null, undo: [],
  tally: { reviewed: 0, kept: 0, passed: 0 }, dragging: false, pendingRender: false, menu: null, menuDel: null, confirmDel: null, confirmWipe: false,
  confirmAreaDel: null, groupsDraft: null, enter: null, hinted: false, wiggled: false, suppressClick: false, lastReport: null, busy: false,
};
try { const s = JSON.parse(localStorage.getItem('flat-hunt-prefs') || 'null'); if (s) { Object.assign(state.f, s.f || {}); state.mode = s.mode || 'cards'; state.sortShort = s.sortShort || 'stage'; state.hinted = !!s.hinted; } } catch { /* private mode */ }
function savePrefs() { try { localStorage.setItem('flat-hunt-prefs', JSON.stringify({ f: state.f, mode: state.mode, sortShort: state.sortShort, hinted: state.hinted })); } catch { /* ignore */ } }
const $ = (s, r = document) => r.querySelector(s);
const byId = id => state.listings.find(l => l.id === id);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wide = () => matchMedia('(min-width:1100px)').matches;
const areaName = id => state.areas.find(a => a.id === id)?.name || '';
const activeAreas = () => state.areas.filter(a => a.active);
const placeOf = l => areaName((l.areas || [])[0]) || activeAreas()[0]?.name || 'your area';

/* ---------- API client ---------- */
class ApiError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
async function api(method, path, body) {
  let r;
  try { r = await fetch(path, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { throw new ApiError(0, 'network', 'Can’t reach the server. Check your connection.'); }
  if (r.status === 204) return null;
  let data = null; try { data = await r.json(); } catch { /* non-JSON */ }
  if (r.status === 401) { goLogin(); throw new ApiError(401, 'unauthenticated', 'Please log in again.'); }
  if (r.status === 503 && data?.error === 'auth_not_configured') { state.authProblem = data.message; render(); throw new ApiError(503, data.error, data.message); }
  if (!r.ok) throw new ApiError(r.status, data?.error || 'http_' + r.status, data?.message || 'Request failed (' + r.status + ').');
  return data;
}
let leaving = false;
function goLogin() { if (leaving) return; leaving = true; location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash); }

async function loadAll() {
  try {
    const [l, a, s, r] = await Promise.all([api('GET', '/api/listings'), api('GET', '/api/areas'), api('GET', '/api/settings'), api('GET', '/api/runs')]);
    state.listings = l.listings; state.lastSync = l.now; state.areas = a.areas; state.settings = s; state.runs = r.runs;
    state.loaded = true; state.stale = false;
  } catch (e) { if (e.status !== 401) { state.loaded = true; state.stale = true; } }
  render(); if (state.open) renderSheet();
}
/** Incremental refresh: changed listings since the last sync, plus the id list to drop deletions. */
async function refresh({ full = false } = {}) {
  if (!state.loaded || leaving) return;
  try {
    const since = Math.max(0, state.lastSync - 3000);
    const res = await api('GET', `/api/listings?since=${since}`);
    const ids = new Set(res.ids);
    const map = new Map(state.listings.filter(l => ids.has(l.id) || state.pending.has(l.id)).map(l => [l.id, l]));
    for (const l of res.listings) if (!state.pending.has(l.id)) map.set(l.id, l);
    state.listings = [...map.values()]; state.lastSync = res.now; state.stale = false;
    if (full) {
      const [a, s, r] = await Promise.all([api('GET', '/api/areas'), api('GET', '/api/settings'), api('GET', '/api/runs')]);
      state.areas = a.areas; state.settings = s; state.runs = r.runs;
    }
  } catch (e) { if (e.status !== 401) state.stale = true; }
  if (state.dragging || document.activeElement?.matches('input,textarea,select')) { renderNav(); return; }
  render(); if (state.open && state.open.kind !== 'settings' && state.open.kind !== 'import') renderSheet();
}

/* ---------- toast / announce / format ---------- */
function toast(msg, opts = {}) {
  const t = $('#toast'); t.innerHTML = `<span>${esc(msg)}</span>${opts.action ? `<button type="button" id="toast-act">${esc(opts.action)}</button>` : ''}`; t.hidden = false;
  if (opts.action) $('#toast-act').onclick = () => { t.hidden = true; opts.onAction(); };
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, opts.ms || (opts.action ? 6000 : 2600));
}
function announce(msg) { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 30); }
const inr = n => n == null ? '' : '₹' + Number(n).toLocaleString('en-IN');
const inrShort = n => { if (n == null) return ''; if (n >= 100000) return '₹' + (+(n / 100000).toFixed(2)) + 'L'; if (n >= 1000) return '₹' + (+(n / 1000).toFixed(1)) + 'k'; return '₹' + n; };
function ago(ts) { if (!ts) return ''; const d = Date.now() - ts; if (d < 60e3) return 'just now'; if (d < 36e5) return Math.round(d / 6e4) + 'm ago'; if (d < 864e5) return Math.round(d / 36e5) + 'h ago'; if (d < 7 * 864e5) return Math.round(d / 864e5) + 'd ago'; return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
const bhkLabel = b => b == null ? '' : b === '1RK' ? '1 RK' : b + ' BHK';
const typeLabel = t => ({ flat: 'Whole flat', flatmate: 'Flatmate room', pg: 'PG' }[t] || '');
const furnLabel = f => ({ fully: 'Fully furnished', semi: 'Semi-furnished', unfurnished: 'Unfurnished' }[f] || '');
const SOURCE_LABEL = { apify: 'Apify', scraper: 'Scraper file', phone: 'Phone scan', manual: 'Pasted', sample: 'Samples', screenshot: 'Screenshots' };
let hlCache = { key: '', re: null };
function highlight(text) {
  const h = esc(text);
  const kws = [...new Set(activeAreas().flatMap(a => a.keywords).map(normText).filter(Boolean))].sort((a, b) => b.length - a.length);
  const key = kws.join('|');
  if (hlCache.key !== key) hlCache = { key, re: kws.length ? new RegExp('(' + kws.map(k => k.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')).join('|') + ')', 'gi') : null };
  return hlCache.re ? h.replace(hlCache.re, '<mark>$1</mark>') : h;
}

/* ---------- persistence (optimistic) ---------- */
const writeChains = new Map();
function upsertLocal(l) { const i = state.listings.findIndex(x => x.id === l.id); if (i >= 0) state.listings[i] = l; else state.listings.push(l); }
const SERVER_FIELDS = ['status', 'stage', 'notes', 'decidedAt', 'hasUpdate'];
async function updateListing(id, patch, opts = {}) {
  const cur = byId(id); if (!cur) return;
  const prev = { ...cur };
  upsertLocal({ ...cur, ...patch, updatedAt: Date.now() });
  if (!opts.silent) { render(); if (state.open?.kind === 'detail' && state.open.id === id) renderSheet(); }
  const body = {}; for (const k of SERVER_FIELDS) if (k in patch) body[k] = patch[k];
  state.pending.set(id, (state.pending.get(id) || 0) + 1);
  const chain = (writeChains.get(id) || Promise.resolve()).catch(() => {}).then(() => api('PATCH', `/api/listings/${encodeURIComponent(id)}`, body));
  writeChains.set(id, chain);
  try {
    const saved = await chain;
    const n = state.pending.get(id) - 1; if (n > 0) state.pending.set(id, n); else state.pending.delete(id);
    if (saved && !state.pending.has(id)) { upsertLocal(saved); if (!opts.silent) render(); }
  } catch (e) {
    const n = state.pending.get(id) - 1; if (n > 0) state.pending.set(id, n); else state.pending.delete(id);
    if (e.status === 404) { state.listings = state.listings.filter(l => l.id !== id); render(); toast('That listing was deleted elsewhere.'); return; }
    upsertLocal(prev); render(); if (state.open?.kind === 'detail' && state.open.id === id) renderSheet();
    handleWriteError(e);
  }
}
async function deleteListing(id) {
  const prev = byId(id); state.listings = state.listings.filter(l => l.id !== id); render();
  try { await api('DELETE', `/api/listings/${encodeURIComponent(id)}`); }
  catch (e) { if (e.status !== 404 && prev) { upsertLocal(prev); render(); handleWriteError(e); } }
}
function handleWriteError(e) { if (e.status === 401) return; toast(e.status === 0 ? 'Couldn’t save that change. Check your connection and try again.' : (e.message || 'Couldn’t save that change.'), { ms: 5000 }); }

/* ---------- queues ---------- */
function inArea(l) { return state.f.area === 'all' || (l.areas || []).includes(+state.f.area); }
function passesFilters(l) {
  const f = state.f; const max = parseInt(String(f.max).replace(/\D/g, ''), 10);
  if (!f.seek && l.kind === 'seeking') return false;
  if (!inArea(l)) return false;
  if (f.bhk !== 'any') { const b = l.bhk === '1RK' ? 1 : l.bhk; if (b == null) return false; if (f.bhk === '3' ? b < 3 : Math.floor(b) !== +f.bhk) return false; }
  if (f.type === 'flat' && l.type !== 'flat') return false;
  if (f.type === 'flatmate' && !(l.type === 'flatmate' || l.type === 'pg')) return false;
  if (max && l.rent && l.rent > max) return false;
  if (f.nobroker && l.brokerage !== 'no') return false;
  return true;
}
const isNew = l => (l.status || 'new') === 'new';
function reviewAll() { return state.listings.filter(l => isNew(l) && (state.f.seek || l.kind !== 'seeking')); }
function reviewQueue() {
  return state.listings.filter(l => isNew(l) && passesFilters(l)).sort((a, b) => {
    if (a.id === state.front) return -1; if (b.id === state.front) return 1;
    const la = state.later.get(a.id) || 0, lb = state.later.get(b.id) || 0;
    if (la !== lb) return la - lb;
    return (b.lastPostedAt || 0) - (a.lastPostedAt || 0);
  });
}
function counts() { return { review: reviewAll().filter(inArea).length, shortlist: state.listings.filter(l => l.status === 'approved' && inArea(l)).length, passed: state.listings.filter(l => l.status === 'rejected' && inArea(l)).length }; }

/* ---------- nav ---------- */
const SCREENS = [['review', 'Review', I.review], ['shortlist', 'Shortlist', I.shortlist], ['passed', 'Passed', I.passed]];
function renderNav() {
  const c = counts();
  $('#rail-nav').innerHTML = SCREENS.map(([k, t, ic]) => `<a class="nav" href="#${k}" ${state.screen === k ? 'aria-current="page"' : ''}>${ic}${t}<span class="badge ${k === 'review' && c.review ? 'hot' : ''}">${c[k]}</span></a>`).join('');
  $('#tabbar').innerHTML = SCREENS.map(([k, t, ic]) => `<a href="#${k}" ${state.screen === k ? 'aria-current="page"' : ''}>${ic}<span>${t}</span>${c[k] ? `<span class="badge ${k === 'review' ? 'hot' : ''}">${c[k]}</span>` : ''}</a>`).join('');
  const names = activeAreas().map(a => a.name);
  const label = names.length > 2 ? `${names.length} areas` : names.join(' · ');
  document.querySelectorAll('.brand-area').forEach(el => { el.textContent = label; });
}
function route() { const h = (location.hash || '').slice(1); state.screen = SCREENS.some(s => s[0] === h) ? h : 'review'; state.menu = null; render(); window.scrollTo(0, 0); }
window.addEventListener('hashchange', route);

/* ---------- render ---------- */
let lastScreen = null;
function render() {
  if (state.dragging) { state.pendingRender = true; return; }
  state.pendingRender = false;
  renderNav();
  const scr = state.screen;
  const html = scr === 'review' ? reviewHTML() : scr === 'shortlist' ? shortlistHTML() : passedHTML();
  $('#main').innerHTML = `<div class="${lastScreen !== scr ? 'screen' : ''}">${html}</div>`;
  lastScreen = scr;
  document.querySelectorAll('#main [data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  if (scr === 'review') afterReview();
}
function bannersHTML() {
  const b = [];
  if (state.authProblem) b.push(`<div class="banner warn">${esc(state.authProblem)}</div>`);
  else if (state.stale) b.push('<div class="banner warn">Can’t reach the server right now. What you see may be out of date.</div>');
  if (state.listings.some(l => l.isSample)) b.push('<div class="banner"><span>Sample posts are loaded so you can try swiping and merging.</span><span class="spacer"></span><button class="btn small" type="button" id="btn-clear-samples">Remove samples</button></div>');
  return b.join('');
}
function chipList(l, max = 4) {
  const c = [];
  if (l.kind === 'seeking') c.push(['amber', 'Looking for a place']);
  if (l.brokerage === 'no') c.push(['keep', 'No brokerage']); else if (l.brokerage === 'yes') c.push(['brok', l.brokerageAmount ? 'Brokerage ' + inrShort(l.brokerageAmount) : 'Brokerage']);
  if (state.areas.length > 1) for (const id of (l.areas || []).slice(0, 2)) if (areaName(id)) c.push(['area', areaName(id)]);
  if (l.furnishing) c.push(['', furnLabel(l.furnishing)]);
  if (l.gender && l.gender !== 'any') c.push(['', l.gender === 'female' ? 'Women only' : 'Men only']);
  if (l.availableFrom) c.push(['', 'From ' + l.availableFrom]);
  if (l.outsideWatched) c.push(['info', 'Not in watched groups']);
  if (l.hasUpdate) c.push(['amber', 'Reposted']);
  return c.slice(0, max).map(([k, t]) => `<span class="chip ${k}">${esc(t)}</span>`).join('') + (c.length > max ? `<span class="chip">+${c.length - max}</span>` : '');
}
function money2(l) { return [l.maintenance ? '+' + inrShort(l.maintenance) + ' maint' : '', l.deposit ? inrShort(l.deposit) + ' deposit' : l.depositMonths ? l.depositMonths + ' mo deposit' : ''].filter(Boolean).join(' · '); }
const postImages = l => [...new Set((l.posts || []).flatMap(p => p.images || []))].map(safeUrl).filter(Boolean);
function scardHTML(l, pos) {
  const p = (l.posts || [])[0] || {}; const g = l.groups || []; const fresh = l.lastPostedAt && Date.now() - l.lastPostedAt < 3 * 36e5;
  const hero = postImages(l)[0];
  const label = `${l.rent ? inr(l.rent) + ' a month' : 'Rent not stated'}, ${bhkLabel(l.bhk)} ${typeLabel(l.type)}, posted ${ago(l.lastPostedAt)} in ${g[0] || 'an unknown group'}`;
  return `<article class="scard ${pos}${hero ? ' has-hero' : ''}" data-id="${esc(l.id)}" ${pos === 'top' ? `tabindex="0" aria-roledescription="listing" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>
    ${pos === 'top' ? '<span class="stamp keep" aria-hidden="true">SHORTLIST</span><span class="stamp pass" aria-hidden="true">PASS</span>' : ''}
    ${hero ? `<img class="hero" src="${esc(hero)}" alt="" draggable="false" referrerpolicy="no-referrer" loading="lazy">` : ''}
    <div class="cmeta">${fresh ? '<span class="fresh" title="Posted in the last 3 hours"></span>' : ''}<span>${esc(ago(l.lastPostedAt))}</span><span class="grp">${esc(g[0] || 'Group not detected')}</span>${g.length > 1 ? `<span>+${g.length - 1}</span>` : ''}${(l.seenCount || 1) > 1 ? `<span>· Seen ${l.seenCount}×</span>` : ''}<span class="spacer"></span>${pos === 'top' ? `<button class="info-btn" type="button" data-open="${esc(l.id)}" aria-label="Full details">${I.info}</button>` : ''}</div>
    <div class="board"><span class="plate">TO-LET</span>
      ${l.rent ? `<span class="rentbig">${esc(inr(l.rent))}<small>/mo</small></span>` : '<span class="rentbig none">Rent not stated</span>'}
      <div class="kind">${esc([bhkLabel(l.bhk), typeLabel(l.type)].filter(Boolean).join(' · ') || 'Details in post')}</div>
      ${money2(l) ? `<div class="money2">${esc(money2(l))}</div>` : ''}</div>
    <div class="chips">${chipList(l)}</div>
    <div class="ptext"><p>${highlight(p.text || '')}</p></div>
    <div class="cfoot"><span class="${(l.phones || []).length ? 'on' : ''}" title="Phone number">${I.phone}</span><span class="${(l.mapLinks || []).length ? 'on' : ''}" title="Map link">${I.pin}</span><span class="${postImages(l).length ? 'on' : ''}" title="Photos">${I.photo}</span><span class="spacer"></span><span>Tap for full post</span></div>
  </article>`;
}
function emptyFirstRun() {
  if (!state.areas.length) {
    return `<div class="caught"><div class="board"><span class="plate">TO-LET</span><span class="rentbig">Where are you looking?</span><div class="kind">Add the area you want to live in</div></div>
      <p>Posts are kept only when they mention one of your areas. Type a neighbourhood or layout name; keyword variants (spacing, typos, “layout” dropped) are generated for you and can be edited in Settings.</p>
      <form class="inline-form" id="first-area-form"><label class="sr" for="first-area">Area name</label><input id="first-area" class="input" placeholder="e.g. Green Glen Layout" autocomplete="off" required><button class="btn primary" type="submit">Add area</button></form></div>`;
  }
  return `<div class="caught"><div class="board"><span class="plate">TO-LET</span><span class="rentbig">No listings yet</span><div class="kind">${esc(activeAreas().map(a => a.name).join(' · ') || 'All areas paused')}</div></div>
    <p>New posts arrive automatically every few hours once Apify is connected (Settings). You can also import a scraper file, a phone scan or a pasted post. Only posts that mention your areas are kept, and reposts merge into one card.</p>
    <div class="btns"><button class="btn primary" type="button" data-go="import">Import posts</button><button class="btn" type="button" id="btn-samples">Try with sample posts</button></div>
    <p class="help">Sample posts are from Green Glen Layout, Bellandur.</p></div>`;
}
function activeFilterCount() { const f = state.f; return (f.bhk !== 'any') + (f.type !== 'any') + (!!f.max) + (!!f.nobroker) + (!!f.seek) + (f.area !== 'all'); }
function reviewHTML() {
  const q = reviewQueue(); const all = reviewAll(); const hidden = Math.max(0, all.length - q.length);
  const done = state.tally.reviewed; const total = done + q.length; const fc = activeFilterCount();
  const head = `<div class="shead"><h1>Review</h1><span class="sub">${q.length} new</span><span class="spacer"></span>
    <button class="btn small" type="button" data-go="filters">${I.filter}Filters${fc ? ` · ${fc}` : ''}</button>
    <div class="seg" role="group" aria-label="View"><button type="button" data-mode="cards" aria-pressed="${state.mode === 'cards'}">${I.cards}<span>Cards</span></button><button type="button" data-mode="list" aria-pressed="${state.mode === 'list'}">${I.list}<span>List</span></button></div></div>
    ${total ? `<div class="progress" aria-hidden="true"><i data-w="${Math.round(100 * done / total)}"></i></div>` : ''}
    ${hidden ? `<p class="note">${hidden} hidden by filters. <button type="button" id="btn-show-all">Show all</button></p>` : ''}
    ${bannersHTML()}`;
  if (!state.loaded) return head + '<div class="deck"><div class="scard top skel"><div class="bar w40"></div><div class="bar big"></div><div class="bar w70"></div><div class="bar"></div><div class="bar w85"></div></div></div>';
  if (!state.listings.length) return head + emptyFirstRun();
  if (!q.length) return head + caughtHTML();
  if (state.mode === 'list') return head + `<div class="rows">${q.map(l => rowHTML(l, 'review')).join('')}</div>`;
  const top = q[0]; const pane = wide();
  const cards = q.slice(0, 3).map((l, i) => scardHTML(l, ['top', 'b1', 'b2'][i])).reverse().join('');
  return head + `<div class="review-grid${pane ? ' with-pane' : ''}"><div class="deck-col">
    <div class="deck" id="deck">${cards}</div>
    <div class="deck-btns">
      <button class="rb sm" type="button" data-deck="undo" aria-label="Undo last decision" aria-keyshortcuts="Z" ${state.undo.length ? '' : 'disabled'}>${I.undo}</button>
      <button class="rb lg passb" type="button" data-deck="rejected" aria-label="Pass" aria-keyshortcuts="ArrowLeft">${I.pass}</button>
      <button class="rb sm" type="button" data-deck="later" aria-label="Decide later" aria-keyshortcuts="ArrowDown">${I.later}</button>
      <button class="rb lg keepb" type="button" data-deck="approved" aria-label="Shortlist" aria-keyshortcuts="ArrowRight">${I.keep}</button>
    </div>
    <div class="kbd-hints"><span><kbd>←</kbd> pass</span><span><kbd>→</kbd> shortlist</span><span><kbd>↓</kbd> later</span><span><kbd>Z</kbd> undo</span><span><kbd>Enter</kbd> details</span></div>
    ${!state.hinted ? '<p class="hint">Swipe right to shortlist, left to pass. Tap the card for the full post.</p>' : ''}
  </div>${pane ? `<aside class="pane" aria-label="Details of the top listing">${detailHTML(top, 'pane')}</aside>` : ''}</div>`;
}
function caughtHTML() {
  const t = state.tally; const lastRun = state.runs[0]; const sc = counts().shortlist;
  return `<div class="caught"><div class="board"><span class="plate">TO-LET</span><span class="rentbig">All caught up</span><div class="kind">${t.reviewed ? `${t.reviewed} reviewed · ${t.kept} shortlisted · ${t.passed} passed` : 'Nothing new to review'}</div>${lastRun ? `<div class="money2">Last import ${esc(ago(lastRun.at))}</div>` : ''}</div>
    <div class="btns"><button class="btn primary" type="button" data-go="import">Import new posts</button>${sc ? `<a class="btn" href="#shortlist">Open shortlist (${sc})</a>` : ''}${state.undo.length ? `<button class="btn ghost" type="button" data-deck="undo">${I.undo}Undo last</button>` : ''}</div></div>`;
}
function afterReview() {
  const top = $('#deck .scard.top'); if (!top) return;
  if (state.enter && state.enter.id === top.dataset.id && !reduceMotion()) {
    const dir = state.enter.dir; top.style.transition = 'none'; top.style.transform = `translateX(${dir * 110}%) rotate(${dir * 12}deg)`;
    requestAnimationFrame(() => requestAnimationFrame(() => { top.style.transition = 'transform 420ms var(--spring)'; top.style.transform = ''; }));
  }
  state.enter = null;
  if (!state.hinted && !reduceMotion() && !state.wiggled) { state.wiggled = true; top.classList.add('wiggle'); top.addEventListener('animationend', () => top.classList.remove('wiggle'), { once: true }); }
}

/* ---------- swipe ---------- */
let drag = null, raf = 0;
document.addEventListener('pointerdown', e => {
  const card = e.target.closest('#deck .scard.top'); if (!card || e.button > 0 || e.target.closest('button,a')) return;
  const r = card.getBoundingClientRect();
  drag = { card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, pts: [{ x: e.clientX, t: performance.now() }], axis: null, pid: e.pointerId, w: r.width, flip: (e.clientY - r.top) > r.height * 0.66, hit: false };
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.dx = e.clientX - drag.x0; drag.dy = e.clientY - drag.y0;
  if (!drag.axis && Math.hypot(drag.dx, drag.dy) > 8) {
    drag.axis = Math.abs(drag.dx) > Math.abs(drag.dy) ? 'x' : 'y';
    if (drag.axis === 'y') { drag = null; return; }
    try { drag.card.setPointerCapture(drag.pid); } catch { /* ignore */ }
    state.dragging = true; drag.card.classList.add('dragging'); drag.card.classList.remove('wiggle');
  }
  if (drag.axis !== 'x') return;
  e.preventDefault();
  drag.pts.push({ x: e.clientX, t: performance.now() }); if (drag.pts.length > 6) drag.pts.shift();
  if (!raf) raf = requestAnimationFrame(paintDrag);
}, { passive: false });
function paintDrag() {
  raf = 0; if (!drag) return;
  const { dx, dy, card } = drag; const thr = Math.min(120, drag.w * 0.3); const p = Math.min(1, Math.abs(dx) / thr);
  const rot = reduceMotion() ? 0 : Math.max(-12, Math.min(12, dx / drag.w * 12)) * (drag.flip ? -1 : 1);
  card.style.transform = `translate(${dx}px,${dy * 0.12}px) rotate(${rot}deg)`;
  const keep = card.querySelector('.stamp.keep'), pass = card.querySelector('.stamp.pass');
  keep.style.opacity = dx > 0 ? p : 0; pass.style.opacity = dx < 0 ? p : 0;
  const hit = p >= 1;
  if (hit && !drag.hit) { const s = dx > 0 ? keep : pass; s.classList.remove('hit'); void s.offsetWidth; s.classList.add('hit'); try { navigator.vibrate && navigator.vibrate(8); } catch { /* ignore */ } }
  drag.hit = hit;
  const b1 = $('#deck .scard.b1'); if (b1) { b1.style.transition = 'none'; b1.style.transform = `translateY(${10 - 10 * p}px) scale(${0.95 + 0.05 * p})`; }
  const kb = $('.rb.keepb'), pb = $('.rb.passb');
  if (kb) kb.style.transform = dx > 0 ? `scale(${1 + 0.12 * p})` : ''; if (pb) pb.style.transform = dx < 0 ? `scale(${1 + 0.12 * p})` : '';
}
function resetDragVisuals(card) {
  const b1 = $('#deck .scard.b1'); if (b1) { b1.style.transition = ''; b1.style.transform = ''; }
  const kb = $('.rb.keepb'), pb = $('.rb.passb'); if (kb) kb.style.transform = ''; if (pb) pb.style.transform = '';
  card.querySelectorAll('.stamp').forEach(s => { s.style.opacity = 0; });
}
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  if (d.axis !== 'x') return;
  state.suppressClick = true; setTimeout(() => { state.suppressClick = false; }, 60);
  const a = d.pts[0], b = d.pts[d.pts.length - 1]; const vx = (b.x - a.x) / Math.max(1, b.t - a.t);
  const thr = Math.min(120, d.w * 0.3);
  const commit = e.type !== 'pointercancel' && (Math.abs(d.dx) > thr || (Math.abs(vx) > 0.6 && Math.abs(d.dx) > 40 && Math.sign(vx) === Math.sign(d.dx)));
  d.card.classList.remove('dragging');
  if (commit) flyOut(d.card, Math.sign(d.dx), d.dy, d.dx > 0 ? 'approved' : 'rejected');
  else {
    d.card.style.transition = 'transform 420ms var(--spring)'; d.card.style.transform = ''; resetDragVisuals(d.card);
    state.dragging = false; if (state.pendingRender) setTimeout(render, 430);
  }
}
document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
function flyOut(card, dir, dy, status) {
  state.dragging = true;
  const id = card.dataset.id;
  const st = card.querySelector(dir > 0 ? '.stamp.keep' : '.stamp.pass'); if (st) st.style.opacity = 1;
  if (reduceMotion()) { card.style.transition = 'opacity 120ms'; card.style.opacity = 0; }
  else { const dist = window.innerWidth + card.offsetWidth; card.style.transition = 'transform 280ms cubic-bezier(.2,.7,.3,1),opacity 280ms'; card.style.transform = `translate(${dir * dist}px,${(dy || 0) + 40}px) rotate(${dir * 20}deg)`; }
  const b1 = $('#deck .scard.b1'); if (b1) { b1.style.transition = 'transform 280ms var(--ease)'; b1.style.transform = 'translateY(0) scale(1)'; }
  setTimeout(() => { state.dragging = false; decide(id, status, dir); }, reduceMotion() ? 120 : 250);
}
function deckAction(kind) {
  if (kind === 'undo') { undo(); return; }
  const top = $('#deck .scard.top');
  if (!top || state.dragging) return;
  if (kind === 'later') {
    state.dragging = true; top.style.transition = 'transform 240ms var(--ease),opacity 240ms'; top.style.transform = 'translateY(40px) scale(.96)'; top.style.opacity = 0;
    setTimeout(() => { state.dragging = false; const id = top.dataset.id; state.later.set(id, ++state.laterSeq); if (state.front === id) state.front = null; announce('Moved to the back of the queue.'); render(); }, reduceMotion() ? 60 : 220);
    return;
  }
  flyOut(top, kind === 'approved' ? 1 : -1, 0, kind);
}
async function decide(id, status, dir) {
  const l = byId(id); if (!l) return;
  state.undo.push({ id, status: l.status || 'new', stage: l.stage || '', decidedAt: l.decidedAt || null, dir }); if (state.undo.length > 10) state.undo.shift();
  state.tally.reviewed++; if (status === 'approved') state.tally.kept++; else state.tally.passed++;
  if (state.front === id) state.front = null; state.later.delete(id);
  if (!state.hinted) { state.hinted = true; savePrefs(); }
  const patch = { status, decidedAt: Date.now(), hasUpdate: false }; if (status === 'approved' && !l.stage) patch.stage = 'To call';
  const left = Math.max(0, reviewQueue().length - 1);
  const what = `${bhkLabel(l.bhk)} ${l.rent ? inr(l.rent) : ''}`.trim() || 'listing';
  announce(`${status === 'approved' ? 'Shortlisted' : 'Passed'} ${what}. ${left} left.`);
  toast(status === 'approved' ? `Shortlisted ${what}` : `Passed ${what}`, { action: 'Undo', onAction: undo });
  await updateListing(id, patch);
}
async function undo() {
  const u = state.undo.pop(); if (!u) return;
  const l = byId(u.id); if (!l) return;
  state.tally.reviewed = Math.max(0, state.tally.reviewed - 1);
  if (l.status === 'approved') state.tally.kept = Math.max(0, state.tally.kept - 1); else if (l.status === 'rejected') state.tally.passed = Math.max(0, state.tally.passed - 1);
  state.front = u.id; state.enter = { id: u.id, dir: u.dir || 1 };
  if (state.screen !== 'review') location.hash = '#review';
  announce('Undone. The listing is back on top.');
  await updateListing(u.id, { status: u.status, stage: u.stage, decidedAt: u.decidedAt });
}

/* ---------- rows ---------- */
function repostsSince(l) { if (!l.decidedAt) return 0; return (l.posts || []).filter(p => p.importedAt > l.decidedAt).length; }
const waMessage = l => { const g = (l.groups || [])[0]; return `Hi, I saw your post${g ? ` in ${g}` : ''} about the ${bhkLabel(l.bhk) || 'flat'} in ${placeOf(l)}. Is it still available?`; };
function rowHTML(l, ctx) {
  const p = (l.posts || [])[0] || {}; const g = (l.groups || [])[0] || ''; const lid = esc(l.id);
  const rent = l.rent ? `<span class="rent">${esc(inr(l.rent))}</span>` : '<span class="rent none">Rent not stated</span>';
  const what = [bhkLabel(l.bhk), typeLabel(l.type)].filter(Boolean).join(' · ');
  const rs = repostsSince(l);
  const tap = `<button class="main-tap" type="button" data-open="${lid}">${rent}<span class="what">${esc(what)}</span>
    <div class="line">${esc(l.society || p.text || '')}</div>
    ${ctx === 'passed' ? `<div class="line">${esc(g || 'Group not detected')} · passed ${esc(ago(l.decidedAt))}${rs ? ` · reposted ${rs}× since` : ''}</div>` : `<div class="chips">${chipList(l, 3)}</div>`}</button>`;
  if (ctx === 'review') return `<div class="lrow">${tap}<div class="side"><button class="rb sm passb" type="button" data-set="rejected" data-lid="${lid}" aria-label="Pass">${I.pass}</button><button class="rb sm keepb" type="button" data-set="approved" data-lid="${lid}" aria-label="Shortlist">${I.keep}</button></div></div>`;
  if (ctx === 'passed') return `<div class="lrow muted">${tap}<div class="side"><button class="btn small" type="button" data-set="new" data-lid="${lid}">Restore</button><button class="btn small" type="button" data-set="approved" data-lid="${lid}">Shortlist</button></div></div>`;
  const ph = (l.phones || [])[0]; const stage = l.stage || 'To call'; const next = STAGES[STAGES.indexOf(stage) + 1];
  return `<div class="lrow">${tap}
    <div class="side">${ph ? `<a class="circle" href="tel:+91${esc(ph)}" aria-label="Call ${esc(ph)}">${I.phone}</a><a class="circle wa" href="https://wa.me/91${esc(ph)}?text=${encodeURIComponent(waMessage(l))}" target="_blank" rel="noopener" aria-label="WhatsApp">${I.wa}</a>` : ''}</div>
    <div class="under">
      <select class="stage-pill" data-stage="${lid}" aria-label="Stage">${STAGES.map(s => `<option ${s === stage ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      ${next ? `<button class="btn small" type="button" data-next="${lid}">${esc(next)} →</button>` : ''}
      ${ph ? `<span class="phone">${esc(ph.replace(/(\d{5})(\d{5})/, '$1 $2'))}</span>` : ''}
      <span class="spacer"></span>
      <button class="iconbtn" type="button" data-menu="${lid}" aria-label="More actions" aria-expanded="${state.menu === l.id}">${I.more}</button>
    </div>
    ${state.menu === l.id ? `<div class="menu"><button class="btn small" type="button" data-set="new" data-lid="${lid}">Back to Review</button><button class="btn small" type="button" data-set="rejected" data-lid="${lid}">Move to Passed</button>${state.menuDel === l.id ? `<span>Delete for good?</span><button class="btn small primary" type="button" data-del-yes="${lid}">Delete</button>` : `<button class="btn small ghost danger" type="button" data-del="${lid}">Delete</button>`}</div>` : ''}
  </div>`;
}
function matchQ(l, q) { q = normText(q); return !q || normText((l.posts || []).map(p => p.text + ' ' + p.group).join(' ') + ' ' + (l.notes || '') + ' ' + (l.society || '')).includes(q); }
function areaSelect(id) {
  if (state.areas.length < 2) return '';
  return `<select class="plain" id="${id}" aria-label="Area"><option value="all">All areas</option>${state.areas.map(a => `<option value="${a.id}" ${String(a.id) === String(state.f.area) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`;
}
function shortlistHTML() {
  const all = state.listings.filter(l => l.status === 'approved' && inArea(l));
  const rows = all.filter(l => matchQ(l, state.qShort));
  const byStage = {}; all.forEach(l => { const s = l.stage || 'To call'; byStage[s] = (byStage[s] || 0) + 1; });
  const strip = STAGES.filter(s => byStage[s]).map(s => `<span><b>${byStage[s]}</b> ${esc(s.toLowerCase())}</span>`).join('');
  const head = `<div class="shead"><h1>Shortlist</h1><span class="sub">${all.length}</span></div>${all.length ? `<div class="strip">${strip}</div>` : ''}
    ${all.length || state.f.area !== 'all' ? `<div class="tools"><input class="search" id="q-short" type="search" placeholder="Search posts, society, notes" value="${esc(state.qShort)}">${areaSelect('area-short')}<select class="plain" id="sort-short" aria-label="Sort"><option value="stage" ${state.sortShort === 'stage' ? 'selected' : ''}>By stage</option><option value="rent" ${state.sortShort === 'rent' ? 'selected' : ''}>Lowest rent</option><option value="recent" ${state.sortShort === 'recent' ? 'selected' : ''}>Latest repost</option></select></div>` : ''}`;
  if (!all.length) return head + '<div class="empty"><h2>No shortlisted flats yet</h2><p>Swipe right on a listing in Review to shortlist it. It lands here under “To call”, with Call and WhatsApp one tap away.</p><div class="btns"><a class="btn primary" href="#review">Go to Review</a></div></div>';
  if (!rows.length) return head + `<div class="empty"><p>No shortlisted listings match “${esc(state.qShort)}”.</p></div>`;
  const rec = (a, b) => (b.lastPostedAt || 0) - (a.lastPostedAt || 0);
  if (state.sortShort !== 'stage') { rows.sort(state.sortShort === 'rent' ? ((a, b) => (a.rent || 1e9) - (b.rent || 1e9)) : rec); return head + `<div class="rows">${rows.map(l => rowHTML(l, 'short')).join('')}</div>`; }
  return head + STAGES.map(s => { const r = rows.filter(l => (l.stage || 'To call') === s).sort(rec); return r.length ? `<div class="sec-h">${esc(s)} <span class="badge">${r.length}</span></div><div class="rows">${r.map(l => rowHTML(l, 'short')).join('')}</div>` : ''; }).join('');
}
function passedHTML() {
  const all = state.listings.filter(l => l.status === 'rejected' && inArea(l));
  const rows = all.filter(l => matchQ(l, state.qPassed)).sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  const head = `<div class="shead"><h1>Passed</h1><span class="sub">${all.length}</span></div>${all.length || state.f.area !== 'all' ? `<div class="tools"><input class="search" id="q-passed" type="search" placeholder="Search passed listings" value="${esc(state.qPassed)}">${areaSelect('area-passed')}</div>` : ''}`;
  if (!all.length) return head + '<div class="empty"><h2>Nothing passed yet</h2><p>Listings you swipe left on are kept here. If one gets reposted later it shows “reposted since”, which usually means the flat is still empty and the rent may be negotiable.</p></div>';
  if (!rows.length) return head + `<div class="empty"><p>No passed listings match “${esc(state.qPassed)}”.</p></div>`;
  return head + `<div class="rows">${rows.map(l => rowHTML(l, 'passed')).join('')}</div>`;
}

/* ---------- sheets ---------- */
function openSheet(kind, id) { state.open = { kind, id }; state.confirmDel = null; state.confirmWipe = false; state.confirmAreaDel = null; if (kind === 'settings') state.groupsDraft = null; renderSheet(true); }
function closeSheet() { state.open = null; $('#sheet-root').innerHTML = ''; }
function renderSheet(fresh) {
  if (!state.open) return; const k = state.open.kind;
  if (k === 'detail') { const l = byId(state.open.id); if (!l) { closeSheet(); return; } shell(detailTitle(l), detailHTML(l, 'sheet'), fresh); }
  else if (k === 'import') renderImport(fresh); else if (k === 'settings') renderSettings(fresh); else if (k === 'filters') renderFiltersSheet(fresh);
}
function shell(title, body, fresh) {
  const keep = fresh ? 0 : ($('#sheet-root .sheet-body')?.scrollTop || 0); const had = !!$('#sheet-root .sheet');
  const noanim = had && !fresh ? ' noanim' : '';
  $('#sheet-root').innerHTML = `<div class="scrim${noanim}" data-close></div><section class="sheet${noanim}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="handle" aria-hidden="true"><i></i></div><div class="sheet-head"><h2>${esc(title)}</h2><button class="iconbtn" type="button" data-close aria-label="Close">${I.pass}</button></div><div class="sheet-body">${body}</div></section>`;
  const b = $('#sheet-root .sheet-body'); if (b) b.scrollTop = keep;
  document.querySelectorAll('#sheet-root [data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
  if (fresh) $('#sheet-root .sheet-head .iconbtn')?.focus({ preventScroll: true });
}
function detailTitle(l) { return [l.rent ? inr(l.rent) + '/mo' : null, bhkLabel(l.bhk), typeLabel(l.type)].filter(Boolean).join(' · ') || 'Listing'; }
function fact(k, v) { return `<div class="fact"><dt>${esc(k)}</dt><dd class="${v ? '' : 'missing'}">${v ? esc(v) : 'Not stated'}</dd></div>`; }
function detailHTML(l, ctx) {
  const st = l.status || 'new'; const lid = esc(l.id); const uid = ctx + '-' + lid;
  const rh = (l.rentHistory || []).length ? ` (was ${l.rentHistory.map(r => inrShort(r.rent)).join(', ')})` : '';
  const areas = (l.areas || []).map(areaName).filter(Boolean).join(', ');
  const facts = [fact('Rent', l.rent ? inr(l.rent) + rh : ''), fact('Deposit', l.deposit ? inr(l.deposit) : l.depositMonths ? l.depositMonths + ' months' : ''), fact('Maintenance', l.maintenance ? inr(l.maintenance) : ''), fact('Brokerage', l.brokerage === 'no' ? 'None' : l.brokerage === 'yes' ? (l.brokerageAmount ? inr(l.brokerageAmount) : 'Yes') : ''), fact('Furnishing', furnLabel(l.furnishing)), fact('Type', typeLabel(l.type) + (l.kind === 'seeking' ? ' (looking for a place)' : '')), fact('Preferred', { female: 'Women', male: 'Men', any: 'Anyone' }[l.gender] || ''), fact('Available', l.availableFrom || ''), fact('Society', l.society || ''), fact('Area', areas)].join('');
  const msg = waMessage(l);
  const phones = (l.phones || []).map(n => `<div class="contact"><span class="mono">${esc(n.replace(/(\d{5})(\d{5})/, '$1 $2'))}</span><button class="btn small" type="button" data-copy="${esc(n)}">Copy</button><a class="btn small" href="tel:+91${esc(n)}">Call</a><a class="btn small keep" href="https://wa.me/91${esc(n)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp</a></div>`).join('');
  const maps = (l.mapLinks || []).map(safeUrl).filter(Boolean).map((u, i, a) => `<a href="${esc(u)}" target="_blank" rel="noopener">Map location${a.length > 1 ? ' ' + (i + 1) : ''} ↗</a>`).join('');
  const imgs = postImages(l).slice(0, 10);
  const posts = (l.posts || []).map(p => `<div class="post"><div class="post-h"><b>${esc(p.group || 'Group not detected')}</b>${p.groupKnown === false ? '<span class="chip info">Not in watched groups</span>' : ''}<span>${esc(p.author || '')}</span><span>${esc(p.postedAt ? ago(p.postedAt) : p.timeText || '')}</span><span>via ${esc(SOURCE_LABEL[p.source] || p.source || '')}</span></div><p class="post-t">${highlight(p.text)}</p>${safeUrl(p.url) ? `<div class="links"><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">Open on Facebook ↗</a></div>` : ''}</div>`).join('');
  return `${ctx === 'pane' ? `<h2 class="cond pane-title">${esc(detailTitle(l))}</h2>` : ''}
    <div class="statusbar">
      <button class="btn a" type="button" data-set="approved" data-lid="${lid}" aria-pressed="${st === 'approved'}">${I.keep}Shortlist</button>
      <button class="btn r" type="button" data-set="rejected" data-lid="${lid}" aria-pressed="${st === 'rejected'}">${I.pass}Pass</button>
      ${st !== 'new' ? `<button class="btn" type="button" data-set="new" data-lid="${lid}">Back to Review</button>` : ''}
      ${st === 'approved' ? `<select class="stage-pill" data-stage="${lid}" aria-label="Stage">${STAGES.map(s => `<option ${s === (l.stage || 'To call') ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
    </div>
    <div class="sec"><h3>Key facts</h3><dl class="facts">${facts}</dl><p class="help">Found by keyword rules. Check against the post.</p></div>
    <div class="sec"><h3>Contact</h3>${phones || '<p class="help m0">No phone number in the posts. Message the poster through the Facebook link below.</p>'}</div>
    ${maps ? `<div class="sec"><h3>Location</h3><div class="links">${maps}</div></div>` : ''}
    <div class="sec"><h3>Photos</h3>${imgs.length ? `<div class="post-imgs">${imgs.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Photo from the post" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div><p class="help">Photos load from Facebook and expire after a few days. Save the ones you like to your phone.</p>` : '<p class="help m0">No photos in the posts.</p>'}</div>
    <div class="sec"><label class="lbl" for="notes-${uid}">Notes</label><textarea id="notes-${uid}" class="d-notes" data-lid="${lid}" maxlength="5000" placeholder="Owner name, visit time, questions to ask…">${esc(l.notes || '')}</textarea></div>
    <div class="sec"><h3>Posts (${(l.posts || []).length}${(l.seenCount || 0) > (l.posts || []).length ? `, seen ${l.seenCount}×` : ''})</h3><div class="posts">${posts}</div></div>
    <div class="sec"><div class="row">${state.confirmDel === l.id ? `<span>Delete this listing and its posts?</span><button class="btn small primary" type="button" data-del-yes="${lid}">Delete</button><button class="btn small" type="button" data-del-no>Keep</button>` : `<button class="btn small ghost danger" type="button" data-del="${lid}">Delete listing</button>`}</div></div>`;
}
function renderFiltersSheet(fresh) {
  const f = state.f;
  const seg = (id, opts, val) => `<div class="seg wrap" id="${id}">${opts.map(([v, t]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v) === String(val)}">${esc(t)}</button>`).join('')}</div>`;
  shell('Filters', `${state.areas.length > 1 ? `<div class="sec"><h3>Area</h3>${seg('f-area', [['all', 'All areas'], ...state.areas.map(a => [String(a.id), a.name])], f.area)}</div>` : ''}
    <div class="sec"><h3>BHK</h3>${seg('f-bhk', [['any', 'Any'], ['1', '1'], ['2', '2'], ['3', '3+']], f.bhk)}</div>
    <div class="sec"><h3>Type</h3>${seg('f-type', [['any', 'All'], ['flat', 'Whole flat'], ['flatmate', 'Flatmate / PG']], f.type)}</div>
    <div class="sec"><h3>Budget</h3><label class="field-inline">Max ₹<input id="f-max" class="mono" inputmode="numeric" placeholder="any" value="${esc(f.max)}"></label></div>
    <div class="sec"><label class="check"><input type="checkbox" id="f-nobroker" ${f.nobroker ? 'checked' : ''}> No brokerage only</label><br><label class="check"><input type="checkbox" id="f-seek" ${f.seek ? 'checked' : ''}> Include “looking for a place” posts</label></div>
    <div class="row"><button class="btn primary" type="button" data-close id="f-show">Show ${reviewQueue().length} listings</button><button class="btn" type="button" id="btn-reset">Reset</button></div>`, fresh);
}
const IMPORT_TABS = [['file', 'Scraper file'], ['phone', 'Phone scan'], ['paste', 'Paste a post']];
function runsTable() {
  const runs = state.runs.slice(0, 8).map(r => `<tr><td>${esc(new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))} · ${esc(SOURCE_LABEL[r.source] || r.source)}${r.status !== 'done' ? ` (${esc(r.status)})` : ''}</td><td>${r.report?.error ? 'error' : `+${r.report?.newListings ?? 0} new, ${r.report?.merged ?? 0} merged`}</td></tr>`).join('');
  return runs ? `<div class="report"><table>${runs}</table></div>` : '<p class="help m0">No imports yet.</p>';
}
function renderImport(fresh) {
  const t = state.open.sub || 'file'; let panel = '';
  const seg = `<div class="seg wrap">${IMPORT_TABS.map(([k, v]) => `<button type="button" data-isub="${k}" aria-pressed="${k === t}">${v}</button>`).join('')}</div>`;
  if (t === 'file') panel = `<div class="sec"><label class="lbl" for="i-file">Apify dataset (JSON)</label><input id="i-file" class="input" type="file" accept=".json,application/json,.jsonl,.txt"><p class="help">Normally runs arrive on their own. To load one by hand: in Apify open a run → Storage → Export → JSON, then upload it here (up to 2 MB). Or paste the JSON below.</p></div>
    <div class="sec"><label class="lbl" for="i-json">Or paste JSON</label><textarea id="i-json" placeholder='[{"text":"2BHK available in Green Glen Layout…","url":"https://www.facebook.com/groups/…"}]'></textarea></div>
    <div class="row"><button class="btn primary" type="button" id="i-go-json">Import</button></div>`;
  if (t === 'phone') panel = '<div class="sec"><label class="lbl" for="i-phone">Phone scan result</label><input id="i-phone" class="input" type="file" accept=".json,application/json"><p class="help">Upload the <code>scan_….json</code> file from the phone script. The report shows how many matching posts came from groups you don’t scrape yet.</p></div><div class="row"><button class="btn primary" type="button" id="i-go-phone">Import scan</button></div>';
  if (t === 'paste') panel = `<div class="sec"><label class="lbl" for="i-text">Post text</label><textarea id="i-text" placeholder="Paste the full post from Facebook or WhatsApp"></textarea></div>
    <div class="row stretch"><input id="i-group" class="input grow" placeholder="Group name (optional)"><input id="i-url" class="input grow" placeholder="Post link (optional)"></div>
    <div class="row"><button class="btn primary" type="button" id="i-go-paste">Add post</button></div>`;
  shell('Import posts', `${seg}${panel}<div id="i-report">${state.lastReport ? reportHTML(state.lastReport) : ''}</div><div class="sec"><h3>Recent imports</h3>${runsTable()}</div>`, fresh);
}
function reportHTML(r) {
  const area = activeAreas().length === 1 ? activeAreas()[0].name : 'area';
  const rows = [['Posts read', r.total], [`No ${area} mention (skipped)`, r.offTopic], ['Already in tracker (skipped)', r.dupes], ['Reposts merged into existing listings', r.merged], ['New listings for Review', r.newListings], ['“Looking for a place” posts', r.seeking]];
  if (r.noText) rows.push(['Empty or too short', r.noText]);
  for (const [name, n] of Object.entries(r.byArea || {})) if (state.areas.length > 1) rows.push([`Mentions ${name}`, n]);
  let ext = '';
  if (r.source === 'phone' || r.source === 'screenshot') {
    const kept = r.known + r.outside; const pct = kept ? Math.round(100 * r.outside / kept) : 0;
    const gl = Object.entries(r.outsideGroups || {}).sort((a, b) => b[1] - a[1]).map(([g, n]) => `<tr><td>${esc(g)}</td><td>${n}</td></tr>`).join('');
    ext = kept === 0 ? '<p class="help">Add your watched groups in Settings to see which posts came from groups the scraper doesn’t cover.</p>' : `<div class="sec mt12"><p class="big-stat"><span class="mono">${r.outside}</span> of <span class="mono">${kept}</span> matching posts (${pct}%) came from groups you don’t scrape</p>${gl ? `<table>${gl}</table>` : ''}<p class="help">These are private groups or public groups missing from your list. Check each group’s label on Facebook: add public ones to your watched groups; private ones are what the phone method adds.</p></div>`;
  }
  if ((r.unscrapable || []).length) ext += `<p class="help">Couldn’t be scraped: ${r.unscrapable.map(u => esc(u.name || u.url)).join(', ')}</p>`;
  return `<div class="report"><p class="big-stat">Import finished</p><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v ?? 0}</td></tr>`).join('')}</table>${ext}</div>`;
}

/* ---------- settings ---------- */
function groupsDraft() { if (!state.groupsDraft) state.groupsDraft = (state.settings?.groups || []).map(g => ({ ...g })); return state.groupsDraft; }
function areaCardHTML(a) {
  const id = a.id;
  return `<div class="area-card${a.active ? '' : ' paused'}" data-area="${id}">
    <div class="head"><label class="sr" for="a-name-${id}">Area name</label><input class="input" id="a-name-${id}" value="${esc(a.name)}" maxlength="60"><span class="status-pill${a.active ? '' : ' off'}">${a.active ? 'Scanning' : 'Paused'}</span></div>
    <label class="lbl" for="a-kw-${id}">Keywords (one per line)</label><textarea id="a-kw-${id}" spellcheck="false">${esc(a.keywords.join('\n'))}</textarea>
    <div class="row"><button class="btn small primary" type="button" data-area-save="${id}">Save</button><button class="btn small" type="button" data-area-regen="${id}">Regenerate from name</button><button class="btn small" type="button" data-area-toggle="${id}">${a.active ? 'Pause' : 'Resume'}</button>
      <span class="spacer"></span>${state.confirmAreaDel === id ? `<span>Delete this area?</span><button class="btn small primary" type="button" data-area-del-yes="${id}">Delete</button><button class="btn small" type="button" data-area-del-no>Keep</button>` : `<button class="btn small ghost danger" type="button" data-area-del="${id}">Delete</button>`}</div></div>`;
}
function renderSettings(fresh) {
  const s = state.settings || { groups: [], keywordFilter: true, resultsPerGroup: 25, apify: {} };
  const groups = groupsDraft();
  const usage = s.apifyUsage; const pct = usage ? Math.min(100, Math.round(100 * usage.usedUsd / (usage.limitUsd || 5))) : 0;
  const sch = s.scheduler; const uns = s.unscrapableGroups?.groups || [];
  shell('Settings', `
    <div class="sec"><h3>Areas</h3><p class="help m0">A post is kept when it mentions any keyword of an active area. Spaces are ignored, so “green glen” also matches “GreenGlen”. Paused areas are not scanned; their listings stay.</p></div>
    ${state.areas.map(areaCardHTML).join('')}
    <form class="row" id="area-add-form"><label class="sr" for="a-new">New area name</label><input class="input grow" id="a-new" placeholder="Add an area, e.g. HSR Layout" maxlength="60" autocomplete="off"><button class="btn" type="submit">Add area</button></form>
    <div class="sec"><label class="check"><input type="checkbox" id="s-kwf" ${s.keywordFilter !== false ? 'checked' : ''}> Keep only posts that mention one of my areas</label></div>

    <div class="sec"><h3>Watched groups (scraped by Apify)</h3>
      <div class="rows">${groups.map((g, i) => `<div class="group-row"><input class="input g-name" data-g="${i}" data-k="name" value="${esc(g.name)}" placeholder="Group name" aria-label="Group ${i + 1} name"><input class="input g-url" data-g="${i}" data-k="url" value="${esc(g.url)}" placeholder="https://www.facebook.com/groups/…" aria-label="Group ${i + 1} link" inputmode="url"><label class="check"><input type="checkbox" data-g="${i}" data-k="active" ${g.active !== false ? 'checked' : ''}> On</label><button class="iconbtn" type="button" data-g-del="${i}" aria-label="Remove group ${i + 1}">${I.pass}</button></div>`).join('') || '<p class="help m0">No groups yet. Add the public Facebook groups to scrape.</p>'}</div>
      <div class="row mt8"><button class="btn small" type="button" id="g-add">Add group</button><label class="field-inline">Posts per group<input id="s-rpg" class="mono" inputmode="numeric" value="${esc(s.resultsPerGroup || 25)}"></label></div>
      ${uns.length ? `<p class="help">Couldn’t be scraped in the last run (private or unavailable): ${uns.map(u => esc(u.name || u.url)).join(', ')}</p>` : ''}
      <div class="row mt8"><button class="btn primary" type="button" id="s-save">Save groups</button><button class="btn" type="button" id="s-copy">Copy group names for the phone script</button></div></div>

    <div class="sec"><h3>Automatic import (Apify)</h3>
      ${s.apify?.configured ? `<dl class="kv"><dt>Status</dt><dd>${sch ? esc(`${sch.action === 'started' ? 'Last run started' : sch.action === 'skipped' ? 'Last run skipped' : sch.action === 'error' ? 'Last attempt failed' : 'Checked'} ${ago(sch.at)}`) : 'Waiting for the first scheduled run'}</dd>${sch?.detail ? `<dt>Note</dt><dd>${esc(sch.detail)}</dd>` : ''}<dt>Actor</dt><dd class="mono">${esc(s.apify.actor || '')}</dd><dt>Webhook</dt><dd>${s.apify.webhook ? 'On (results arrive when each run finishes)' : 'Off: results arrive with the next 4-hourly sweep'}</dd></dl>
        ${usage ? `<p class="m0 mt8"><b>Apify credit used: $${esc(usage.usedUsd.toFixed(2))} of $${esc(usage.limitUsd)}</b> this month</p><div class="meter${pct > 95 ? ' hot' : pct > 80 ? ' warn' : ''}" role="img" aria-label="${pct}% of monthly credit used"><i data-w="${pct}"></i></div><p class="help m0">Above 80% each run fetches half as many posts per group; above 95% runs pause until the cycle resets.</p>` : '<p class="help">Credit usage appears after the first run.</p>'}
        <div class="row mt8"><button class="btn small" type="button" id="s-run-now">Run scraper now</button></div>`
      : '<p class="help m0">Not connected. Set the APIFY_TOKEN and INGEST_SECRET secrets on the server (see docs/DEPLOY.md); runs then start every 4 hours for the watched groups above.</p>'}
      <h3 class="mt12">Recent imports</h3>${runsTable()}</div>

    <div class="sec"><h3>Data</h3><div class="row"><a class="btn small" href="/api/export" download>Export all listings (JSON)</a>${state.confirmWipe ? `<span>Delete ${counts().passed} passed listings? Reposts of them will come back to Review.</span><button class="btn small primary" type="button" id="s-wipe-yes">Delete</button><button class="btn small" type="button" id="s-wipe-no">Keep</button>` : '<button class="btn small ghost danger" type="button" id="s-wipe">Delete all passed listings</button>'}</div>
      ${s.auth === 'password' ? '<div class="row mt8"><button class="btn small" type="button" id="s-logout">Log out</button></div>' : ''}</div>`, fresh);
}

/* ---------- import ---------- */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
async function runImport(items, source) {
  if (!items.length) { toast('No posts found in that input.'); return; }
  const body = { source, items };
  if (new Blob([JSON.stringify(body)]).size > MAX_IMPORT_BYTES) { toast('That file is over 2 MB. Split it into smaller files, or let the automatic import handle it.', { ms: 6000 }); return; }
  if (state.busy) return; state.busy = true;
  toast('Importing…', { ms: 15000 });
  try {
    const { report } = await api('POST', '/api/import', body);
    state.lastReport = report;
    await refresh({ full: true });
    if (state.open?.kind === 'import') renderImport();
    toast(`${report.newListings} new, ${report.merged} merged, ${report.dupes + report.offTopic} skipped`);
  } catch (e) { if (e.status !== 401) toast(e.message || 'Import failed.', { ms: 5000 }); }
  finally { state.busy = false; }
}
async function readFile(input) { const f = input && input.files && input.files[0]; if (!f) return null; if (f.size > MAX_IMPORT_BYTES * 1.5) return { tooBig: true }; return { name: f.name, text: await f.text() }; }

/* ---------- settings actions ---------- */
async function saveArea(id, patch, okMsg) {
  try { const a = await api('PATCH', `/api/areas/${id}`, patch); state.areas = state.areas.map(x => x.id === id ? a : x); renderNav(); renderSettings(); render(); toast(okMsg); }
  catch (e) { if (e.status !== 401) toast(e.message, { ms: 5000 }); }
}
async function addArea(name) {
  name = String(name || '').trim(); if (!name) { toast('Type an area name first.'); return false; }
  try { const a = await api('POST', '/api/areas', { name }); state.areas = [...state.areas, a]; renderNav(); render(); if (state.open?.kind === 'settings') renderSettings(); toast(`Added ${a.name} with ${a.keywords.length} keywords. Edit them in Settings.`, { ms: 4000 }); return true; }
  catch (e) { if (e.status !== 401) toast(e.message, { ms: 5000 }); return false; }
}

/* ---------- events ---------- */
document.addEventListener('error', e => { if (e.target && e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);
document.addEventListener('submit', async e => {
  const f = e.target;
  if (f.id === 'first-area-form') { e.preventDefault(); await addArea($('#first-area').value); }
  if (f.id === 'area-add-form') { e.preventDefault(); if (await addArea($('#a-new').value)) { const n = $('#a-new'); if (n) n.value = ''; } }
});
document.addEventListener('click', async e => {
  if (state.suppressClick && e.target.closest('#deck')) { e.preventDefault(); return; }
  const card = e.target.closest('#deck .scard.top');
  if (card && !e.target.closest('button,a')) { if (!wide()) openSheet('detail', card.dataset.id); return; }
  const el = e.target.closest('button,[data-close]'); if (!el) return;
  if (el.matches('[data-close]')) { closeSheet(); render(); return; }
  const d = el.dataset;
  if (d.go) { openSheet(d.go); return; }
  if (d.mode) { state.mode = d.mode; savePrefs(); render(); return; }
  if (d.deck) { deckAction(d.deck); return; }
  if (d.open) { openSheet('detail', d.open); return; }
  if (d.set) {
    const id = d.lid, l = byId(id); if (!l) return; const s = d.set; if ((l.status || 'new') === s) return;
    const patch = { status: s, decidedAt: Date.now(), hasUpdate: false }; if (s === 'approved' && !l.stage) patch.stage = 'To call';
    const prev = { status: l.status || 'new', stage: l.stage || '', decidedAt: l.decidedAt || null }; state.menu = null;
    await updateListing(id, patch); toast(s === 'approved' ? 'Moved to Shortlist' : s === 'rejected' ? 'Moved to Passed' : 'Back in Review', { action: 'Undo', onAction: () => updateListing(id, prev) }); return;
  }
  if (d.next) { const l = byId(d.next); const nx = STAGES[STAGES.indexOf(l.stage || 'To call') + 1]; if (nx) { await updateListing(l.id, { stage: nx }); toast('Stage: ' + nx); } return; }
  if (d.menu) { state.menu = state.menu === d.menu ? null : d.menu; state.menuDel = null; render(); return; }
  if (d.del) { if (state.open?.kind === 'detail') { state.confirmDel = d.del; renderSheet(); } else { state.menuDel = d.del; render(); } return; }
  if (el.hasAttribute('data-del-no')) { state.confirmDel = null; renderSheet(); return; }
  if (d.delYes) { const id = d.delYes; state.confirmDel = null; state.menuDel = null; state.menu = null; if (state.open?.id === id) closeSheet(); await deleteListing(id); toast('Listing deleted'); return; }
  if (d.copy) { try { await navigator.clipboard.writeText(d.copy); toast('Number copied'); } catch { const n = el.parentElement.querySelector('.mono'); const r = document.createRange(); r.selectNodeContents(n); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected. Copy it from here.'); } return; }
  if (el.closest('#f-area') && d.v) { state.f.area = d.v; savePrefs(); render(); renderSheet(); return; }
  if (el.closest('#f-bhk') && d.v) { state.f.bhk = d.v; savePrefs(); render(); renderSheet(); return; }
  if (el.closest('#f-type') && d.v) { state.f.type = d.v; savePrefs(); render(); renderSheet(); return; }
  if (el.id === 'btn-reset' || el.id === 'btn-show-all') { state.f = { ...DEFAULT_F }; savePrefs(); render(); if (state.open) renderSheet(); return; }
  if (el.id === 'btn-samples') {
    try { const samples = await (await fetch('/samples.json', { credentials: 'same-origin' })).json(); await runImport(samples, 'sample'); }
    catch { toast('Couldn’t load the sample posts.'); }
    return;
  }
  if (el.id === 'btn-clear-samples') {
    const s = state.listings.filter(l => l.isSample); state.listings = state.listings.filter(l => !l.isSample); state.undo = state.undo.filter(u => !s.some(l => l.id === u.id)); state.tally = { reviewed: 0, kept: 0, passed: 0 }; render();
    try { await api('DELETE', '/api/listings?sample=1'); toast('Samples removed'); } catch (err) { handleWriteError(err); refresh(); }
    return;
  }
  if (d.isub) { state.open.sub = d.isub; renderImport(); return; }
  if (el.id === 'i-go-json') {
    const src = await readFile($('#i-file')); if (src?.tooBig) { toast('That file is over 2 MB. Split it into smaller files.', { ms: 5000 }); return; }
    const data = parseJsonText(src ? src.text : $('#i-json').value);
    if (!data) { toast('That isn’t valid JSON. Export the Apify dataset as JSON and try again.', { ms: 5000 }); return; }
    const { items, source } = itemsFromJson(data); await runImport(items, source === 'phone' ? 'phone' : 'scraper'); return;
  }
  if (el.id === 'i-go-phone') {
    const src = await readFile($('#i-phone')); if (!src) { toast('Choose the scan file first.'); return; } if (src.tooBig) { toast('That file is over 2 MB.'); return; }
    const data = parseJsonText(src.text); if (!data) { toast('That file isn’t valid JSON.'); return; }
    await runImport(itemsFromJson(data).items, 'phone'); return;
  }
  if (el.id === 'i-go-paste') {
    const text = $('#i-text').value.trim(); if (!text) { toast('Paste the post text first.'); return; }
    await runImport([{ text, group: $('#i-group').value.trim(), url: $('#i-url').value.trim(), time: Date.now() }], 'manual');
    const t = $('#i-text'); if (t) t.value = ''; return;
  }
  // areas
  if (d.areaSave) { const id = +d.areaSave; await saveArea(id, { name: $(`#a-name-${id}`).value, keywords: $(`#a-kw-${id}`).value }, 'Area saved'); return; }
  if (d.areaRegen) { const id = +d.areaRegen; await saveArea(id, { name: $(`#a-name-${id}`).value, regenerate: true }, 'Keywords regenerated'); return; }
  if (d.areaToggle) { const id = +d.areaToggle; const a = state.areas.find(x => x.id === id); await saveArea(id, { active: !a.active }, a.active ? `${a.name} paused` : `${a.name} resumed`); return; }
  if (d.areaDel) { state.confirmAreaDel = +d.areaDel; renderSettings(); return; }
  if (el.hasAttribute('data-area-del-no')) { state.confirmAreaDel = null; renderSettings(); return; }
  if (d.areaDelYes) {
    const id = +d.areaDelYes; state.confirmAreaDel = null;
    try { await api('DELETE', `/api/areas/${id}`); state.areas = state.areas.filter(a => a.id !== id); if (String(state.f.area) === String(id)) { state.f.area = 'all'; savePrefs(); } renderNav(); renderSettings(); render(); toast('Area deleted'); }
    catch (err) { if (err.status !== 401) toast(err.message, { ms: 5000 }); }
    return;
  }
  // groups
  if (el.id === 'g-add') { groupsDraft().push({ name: '', url: '', active: true }); renderSettings(); const inputs = document.querySelectorAll('.g-name'); inputs[inputs.length - 1]?.focus(); return; }
  if (d.gDel != null) { groupsDraft().splice(+d.gDel, 1); renderSettings(); return; }
  if (el.id === 's-save') {
    const groups = groupsDraft().filter(g => g.url.trim() || g.name.trim());
    try {
      state.settings = await api('PUT', '/api/settings', { groups, keywordFilter: $('#s-kwf').checked, resultsPerGroup: parseInt($('#s-rpg').value, 10) || 25 });
      state.groupsDraft = null; renderSettings(); toast('Settings saved');
    } catch (err) { if (err.status !== 401) toast(err.message, { ms: 6000 }); }
    return;
  }
  if (el.id === 's-copy') { const names = groupsDraft().filter(g => g.active !== false).map(g => g.name || g.url).filter(Boolean).join('\n'); try { await navigator.clipboard.writeText(names); toast('Copied. Paste into groups.txt next to the script.'); } catch { toast('Couldn’t copy. Select the names and copy them.'); } return; }
  if (el.id === 's-run-now') {
    el.disabled = true; el.textContent = 'Starting…';
    try { const r = await api('POST', '/api/apify/run'); toast(r.action === 'started' ? 'Run started. New posts arrive when it finishes.' : (r.detail || 'Nothing to do.'), { ms: 6000 }); await refresh({ full: true }); renderSettings(); }
    catch (err) { if (err.status !== 401) toast(err.message, { ms: 6000 }); if (el.isConnected) { el.disabled = false; el.textContent = 'Run scraper now'; } }
    return;
  }
  if (el.id === 's-wipe') { state.confirmWipe = true; renderSettings(); return; }
  if (el.id === 's-wipe-no') { state.confirmWipe = false; renderSettings(); return; }
  if (el.id === 's-wipe-yes') {
    state.confirmWipe = false; const rej = state.listings.filter(l => l.status === 'rejected'); state.listings = state.listings.filter(l => l.status !== 'rejected'); render(); renderSettings();
    try { const r = await api('DELETE', '/api/listings?status=rejected'); toast(`${r.deleted} deleted`); } catch (err) { handleWriteError(err); state.listings.push(...rej); render(); }
    return;
  }
  if (el.id === 's-logout') { try { await api('POST', '/api/logout'); } catch { /* ignore */ } location.href = '/login'; }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'f-max') { state.f.max = t.value; savePrefs(); clearTimeout(render._t); render._t = setTimeout(() => { render(); const b = $('#f-show'); if (b) b.textContent = `Show ${reviewQueue().length} listings`; }, 250); }
  if (t.id === 'q-short' || t.id === 'q-passed') { state[t.id === 'q-short' ? 'qShort' : 'qPassed'] = t.value; clearTimeout(render._q); render._q = setTimeout(() => { const pos = t.selectionStart; render(); const n = $('#' + t.id); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* ignore */ } } }, 250); }
  if (t.dataset.g != null && t.dataset.k && t.dataset.k !== 'active') groupsDraft()[+t.dataset.g][t.dataset.k] = t.value;
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'f-nobroker') { state.f.nobroker = t.checked; savePrefs(); render(); renderSheet(); }
  if (t.id === 'f-seek') { state.f.seek = t.checked; savePrefs(); render(); renderSheet(); }
  if (t.id === 'sort-short') { state.sortShort = t.value; savePrefs(); render(); }
  if (t.id === 'area-short' || t.id === 'area-passed') { state.f.area = t.value; savePrefs(); render(); }
  if (t.dataset.g != null && t.dataset.k === 'active') groupsDraft()[+t.dataset.g].active = t.checked;
  if (t.dataset.stage) { await updateListing(t.dataset.stage, { stage: t.value }); toast('Stage: ' + t.value); }
  if (t.classList.contains('d-notes')) { await updateListing(t.dataset.lid, { notes: t.value }, { silent: true }); toast('Note saved'); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.open) { closeSheet(); render(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (state.open || ['input', 'textarea', 'select'].includes(tag) || e.altKey) return;
  if (!e.metaKey && !e.ctrlKey && ['1', '2', '3'].includes(e.key)) { location.hash = '#' + SCREENS[+e.key - 1][0]; return; }
  if (state.screen !== 'review') return;
  if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); undo(); return; }
  if (state.mode !== 'cards' || e.metaKey || e.ctrlKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); deckAction('rejected'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); deckAction('approved'); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); deckAction('later'); }
  else if ((e.key === 'Enter' || e.key === ' ') && !['button', 'a'].includes(tag)) { const top = $('#deck .scard.top'); if (top && !wide()) { e.preventDefault(); openSheet('detail', top.dataset.id); } }
});
let sh = null;
document.addEventListener('pointerdown', e => { const h = e.target.closest('.handle'); if (!h) return; sh = { y0: e.clientY, el: h.closest('.sheet'), pid: e.pointerId, dy: 0 }; try { h.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
document.addEventListener('pointermove', e => { if (!sh || e.pointerId !== sh.pid) return; sh.dy = Math.max(0, e.clientY - sh.y0); sh.el.style.transition = 'none'; sh.el.style.transform = `translateY(${sh.dy}px)`; });
document.addEventListener('pointerup', e => { if (!sh || e.pointerId !== sh.pid) return; const s = sh; sh = null; if (s.dy > 100) { closeSheet(); render(); } else { s.el.style.transition = ''; s.el.style.transform = ''; } });
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.screen === 'review' && !state.dragging) render(); }, 200); });
// Refetch every 60 s and whenever the app comes back to the foreground.
setInterval(() => { if (!document.hidden) refresh(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh({ full: true }); });
window.addEventListener('focus', () => { if (Date.now() - (refresh._last || 0) > 5000) { refresh._last = Date.now(); refresh({ full: true }); } });

/* ---------- boot ---------- */
route();
loadAll();
