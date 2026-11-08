// Flat Hunt v2 UI (docs/DESIGN.md). Vanilla ES module, no libraries, no inline styles (CSP style-src 'self':
// dynamic sizes go through the CSSOM or SVG attributes). Three roles: public, user, admin (/api/me).
// Contact details for the public are removed by the server; post text arrives with [[phone]] tokens.

import { usd2, cents, fdate, ftime, niceMoney, moneyTick, costDelta, whatIfCost, whatIfDefaults, statusPill as finPill, verdict, suggestions } from './finance.js';
import { registerServiceWorker, createAlertsUI, iosSigninNote, BELL } from './alerts.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  wa: svg('<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z"/>'),
  pin: svg('<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>'),
  photo: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  heart: svg('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  chev: svg('<path d="M6 9l6 6 6-6"/>'),
  home: svg('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  cards: svg('<rect x="4" y="3" width="13" height="17" rx="2"/><path d="M20 6v13a2 2 0 0 1-2 2H8"/>'),
  star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  bin: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  coin: svg('<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.7 0-2.8.8-2.8 2s1.1 1.7 2.8 2 2.8.8 2.8 2-1.1 2-2.8 2c-1.3 0-2.3-.4-2.8-1.2M12 6.5V8M12 16v1.5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
};
const GOOGLE = '<svg class="g" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-3.9 7-9.8 7-17z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
const MASKED = `<span class="masked" aria-label="Phone number hidden">${svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>')}number hidden</span>`;
const STAGES = ['To call', 'Called – waiting', 'Visit booked', 'Visited', 'Negotiating', 'Token paid'];
const ADMIN_PAGES = [['admin-scraper', 'Scraper', I.chart], ['admin-finance', 'Finance & budget', I.coin], ['admin-groups', 'Groups', I.cards], ['admin-phone', 'Phone scans', I.phone], ['admin-ai', 'AI extraction', I.star], ['admin-data', 'Data', I.bin], ['admin-users', 'Users', I.user], ['admin-alerts', 'Alerts', BELL]];
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = { get(k, d) { try { const v = localStorage.getItem('fh.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('fh.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

// ---------- API ----------
class ApiError extends Error { constructor(status, data) { super(data?.message || `HTTP ${status}`); this.status = status; this.data = data; } }
async function api(method, path, body) {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const r = await fetch(path, init);
  const text = await r.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    if (r.status === 401 && state.me?.role !== 'public') { await loadMe(); renderChrome(); }
    throw new ApiError(r.status, data);
  }
  return data;
}

// ---------- state ----------
const state = {
  me: { role: 'public', user: null, login: {} },
  areas: [], myAreas: [], area: store.get('area', null),
  f: store.get('filters', { bhk: '', maxRent: '', type: '', nobroker: false, furnishing: '', sort: 'new' }),
  browse: { items: [], next: null, loading: false, key: '' },
  listings: new Map(), lastSync: 0, undo: [], lastIngestMin: null, admin: {}, swung: false, statsDays: 14,
};
const signedIn = () => state.me.role === 'user' || state.me.role === 'admin';
const isAdmin = () => state.me.role === 'admin';
const mine = () => [...state.listings.values()];
const isOffer = l => (l.kind || 'offer') === 'offer';
const counts = () => { const L = mine(); return { review: L.filter(l => l.status === 'new' && isOffer(l)).length, shortlist: L.filter(l => l.status === 'approved').length, passed: L.filter(l => l.status === 'rejected').length }; };

async function loadMe() { try { state.me = await api('GET', '/api/me'); } catch { state.me = { role: 'public', user: null, login: {} }; } }
async function loadAreas() {
  const pub = await api('GET', '/api/public/areas').catch(() => ({ areas: [] }));
  state.areas = pub.areas || [];
  if (signedIn()) { state.myAreas = (await api('GET', '/api/areas').catch(() => ({ areas: [] }))).areas || []; }
  else state.myAreas = [];
  const ids = new Set(state.areas.map(a => a.id));
  if (state.area != null && !ids.has(state.area)) state.area = null; // null = all of the city
}
async function syncListings({ full = false } = {}) {
  if (!signedIn()) { state.listings.clear(); return; }
  const since = !full && state.lastSync ? `?since=${state.lastSync - 5000}` : '';
  const d = await api('GET', '/api/listings' + since);
  if (!since) state.listings.clear();
  for (const l of d.listings) state.listings.set(l.id, l);
  if (d.ids) { const keep = new Set(d.ids); for (const id of state.listings.keys()) if (!keep.has(id)) state.listings.delete(id); }
  state.lastSync = d.now;
}

// ---------- formatting ----------
const inr = n => n == null ? '' : '₹' + Number(n).toLocaleString('en-IN');
const k = n => n == null ? '' : n >= 100000 ? (Math.round(n / 10000) / 10) + 'L' : n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
const ago = t => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60e3); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 24) return h + ' h ago'; const d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago'); };
const when = t => t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
const dur = ms => ms == null ? '–' : ms < 60e3 ? Math.round(ms / 1000) + ' s' : Math.round(ms / 60e3) + ' min';
const phoneFmt = p => p && p.length === 10 ? p.slice(0, 5) + ' ' + p.slice(5) : p || '';
const typeName = l => l.type === 'flatmate' ? 'Room in a shared flat' : l.type === 'pg' ? 'PG / co-living' : l.bhk === '1RK' ? '1 RK' : l.bhk != null ? `${l.bhk} BHK` : 'Flat';
const kindLine = l => [l.bhk != null && l.type !== 'flat' && l.type ? `${l.bhk === '1RK' ? '1 RK' : l.bhk + ' BHK'}` : '', typeName(l), l.furnishing ? { fully: 'Furnished', semi: 'Semi-furnished', unfurnished: 'Unfurnished' }[l.furnishing] : ''].filter(Boolean);
// The city every scraped group covers. Areas are optional filters inside it.
const CITY = 'Bangalore';
const areaName = id => state.areas.find(a => a.id === id)?.name || state.myAreas.find(a => a.id === id)?.name || '';
/** Post text for display: escaped, with [[phone]] tokens as the hatched "number hidden" pill. */
const postHtml = t => esc(t).replace(/\[\[phone\]\]/g, MASKED);
const firstText = l => (l.summary ? l.summary + ' · ' : '') + (l.posts?.[0]?.text || '');
const fresh = l => l.lastPostedAt && Date.now() - l.lastPostedAt < 6 * 36e5;
const imagesOf = l => l.images || [...new Set((l.posts || []).flatMap(p => p.images || []))].slice(0, 10);

// ---------- toast, sheet ----------
let toastTimer = null;
function toast(msg, { undo, err = false, ms = 3500 } = {}) {
  const root = $('#toast-root'); clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast${err ? ' err' : ''}" role="status"><span>${esc(msg)}</span>${undo ? '<button type="button" id="toast-undo">Undo</button>' : ''}${err ? '<button type="button" id="toast-x" aria-label="Dismiss">✕</button>' : ''}</div>`;
  if (undo) $('#toast-undo').onclick = () => { root.innerHTML = ''; undo(); };
  if (err) $('#toast-x').onclick = () => { root.innerHTML = ''; };
  else toastTimer = setTimeout(() => { root.innerHTML = ''; }, undo ? 6000 : ms);
}
const fail = e => toast(e?.data?.message || e?.message || 'Something went wrong.', { err: true });
let sheetReturn = null, sheetRoute = null;
function openSheet(html, { label = 'Details', center = false, route = null } = {}) {
  sheetReturn = document.activeElement; sheetRoute = route;
  $('#sheet-root').innerHTML = `<div class="scrim${center ? ' center' : ''}" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1"><div class="handle"></div>${html}</div></div>`;
  const s = $('.sheet'); s.focus();
  $('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });
  return s;
}
function closeSheet() {
  if (!$('#scrim')) return;
  $('#sheet-root').innerHTML = '';
  if (sheetRoute && location.hash.slice(1) === sheetRoute) history.replaceState(null, '', '#' + (state.base || 'browse'));
  sheetRoute = null;
  try { sheetReturn?.focus(); } catch { /* gone */ }
}
document.addEventListener('keydown', e => {
  const s = $('.sheet'); if (!s) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  if (e.key === 'Tab') { // focus trap
    const f = $$('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])', s); if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
});

// ---------- chrome: top bar, rail, tab bar ----------
const route = () => (location.hash.slice(1) || 'browse');
function navItems() {
  const c = counts();
  if (!signedIn()) return [['browse', 'Browse', I.home], ['review', 'Review', I.cards, 0, true], ['shortlist', 'Shortlist', I.star, 0, true], ['signin', 'Sign in', I.user]];
  return [['browse', 'Browse', I.home], ['review', 'Review', I.cards, c.review], ['shortlist', 'Shortlist', I.star, c.shortlist], ['passed', 'Passed', I.x, 0], ['account', 'Me', I.user]];
}
const avatar = () => { const u = state.me.user; if (u?.picture) return `<span class="avatar"><img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer"></span>`; return `<span class="avatar">${esc((u?.name || u?.email || '?').slice(0, 1).toUpperCase())}</span>`; };
function renderChrome() {
  const r = route().split('-')[0] === 'admin' ? route() : route().replace(/^listing-.*/, state.base || 'browse');
  const cur = n => (n === r ? ' aria-current="page"' : '');
  const area = areaName(state.area);
  $('#topbar').innerHTML = `<div class="brand"><span class="plate" aria-hidden="true">TO-LET</span><b>Flat Hunt</b></div><span class="sp"></span>
    <button class="area-chip" type="button" data-act="pick-area">${esc(area || 'All ' + CITY)} ${I.chev}</button>
    ${isAdmin() ? `<a class="btn sm" href="#admin-phone">${I.plus}Import</a>` : ''}
    ${signedIn() ? '' : `<a class="btn sm primary" href="#signin">Sign in</a>`}`;
  $('#tabbar').innerHTML = navItems().map(([id, label, icon, n, locked]) => `<a href="#${id}"${cur(id)}>${id === 'account' && signedIn() ? avatar() : icon}<span>${label}</span>${locked ? `<span class="lockg">${I.lock}</span>` : ''}${n ? `<span class="badge">${n}</span>` : ''}</a>`).join('');
  const my = state.myAreas.map(a => `<a href="#browse" data-area="${a.id}"${a.id === state.area && r === 'browse' ? ' aria-current="page"' : ''}>${esc(a.name)}${a.matching ? ' <span class="small">matching…</span>' : ''}</a>`).join('');
  $('#rail').innerHTML = `<div class="brand"><span class="plate" aria-hidden="true">TO-LET</span><b>Flat Hunt</b></div>
    <nav aria-label="Screens">${navItems().filter(([id]) => id !== 'signin' && id !== 'account').map(([id, label, icon, n, locked]) => `<a href="#${id}"${cur(id)}>${icon}${label}${locked ? ` <span class="lockg">${I.lock}</span>` : ''}${n ? `<span class="badge">${n}</span>` : ''}</a>`).join('')}
    ${signedIn() ? `<a href="#areas"${cur('areas')}>${I.pin}My areas</a>` : ''}</nav>
    ${signedIn() && my ? `<h3>My areas</h3><nav aria-label="My areas"><a href="#browse" data-area=""${state.area == null && r === 'browse' ? ' aria-current="page"' : ''}>All ${CITY}</a>${my}</nav>` : ''}
    ${isAdmin() ? `<h3>Admin</h3><nav aria-label="Admin">${ADMIN_PAGES.map(([id, l, ic]) => `<a href="#${id}"${cur(id)}>${ic}${l}</a>`).join('')}</nav>` : ''}
    ${signedIn() ? `<a class="acct" href="#account">${avatar()}<span class="who">${esc(state.me.user?.name || state.me.user?.email || '')}</span></a>` : ctaCard(true)}`;
  $$('[data-area]', $('#rail')).forEach(a => a.addEventListener('click', () => { setArea(a.dataset.area === '' ? null : Number(a.dataset.area)); }));
}
function ctaCard(compact = false) {
  return `<div class="cta-card"><span class="plate" aria-hidden="true">TO-LET</span><h2>See the numbers</h2>${compact ? '' : '<p>Sign in free to call or WhatsApp owners directly.</p>'}
    <ul><li>${I.check}Owner's phone, WhatsApp and map pin</li><li>${I.check}Your own swipe deck and shortlist</li><li>${I.check}Pick the areas we scan for you</li></ul>
    <a class="btn google block" href="#signin">${GOOGLE}Continue with Google</a></div>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('[data-act="pick-area"]'); if (a) { e.preventDefault(); areaPicker(); }
});
function setArea(id) { state.area = id; store.set('area', id); state.browse.key = ''; if (route() !== 'browse') location.hash = '#browse'; else render(); }
function areaPicker() {
  const s = openSheet(`<div class="shead"><h2>Pick an area</h2><button class="btn quiet sm" type="button" data-close>Close</button></div>
    <input class="input" id="ap-q" placeholder="Type an area, e.g. HSR Layout" autocomplete="off"><div class="pick-list" id="ap-list"></div>`, { label: 'Pick an area', center: true });
  const row = (id, name, ct) => `<button class="pr btn quiet" type="button" data-id="${id}" aria-pressed="${(id === '' ? null : id) === state.area}"><span class="nm">${esc(name)}</span><span class="ct">${ct}</span>${(id === '' ? null : id) === state.area ? I.check : ''}</button>`;
  const draw = () => {
    const q = $('#ap-q').value.trim().toLowerCase();
    const all = !q || ('all ' + CITY).toLowerCase().includes(q) ? row('', 'All ' + CITY, 'every post') : '';
    const list = state.areas.filter(a => !q || a.name.toLowerCase().includes(q)).map(a => row(a.id, a.name, `${a.listings} listings`)).join('');
    $('#ap-list').innerHTML = (all + list) || '<p class="help">No area matches. Signed-in users can add new areas.</p>';
  };
  draw(); $('#ap-q').addEventListener('input', draw); $('#ap-q').focus();
  s.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); const b = e.target.closest('[data-id]'); if (b) { closeSheet(); setArea(b.dataset.id === '' ? null : Number(b.dataset.id)); } });
}

// ---------- listing card and board ----------
function stripHtml(l) {
  if (!signedIn() || l.limited) return `<div class="strip locked">${I.lock}<span class="ph">••••• •••••</span><span class="sp"></span><a class="link" href="#signin">Sign in to call</a></div>`;
  const p = (l.phones || [])[0];
  return `<div class="strip">${I.phone}<span class="ph">${p ? esc(phoneFmt(p)) : 'No number in post'}</span><span class="sp"></span>${l.brokerage === 'no' ? '<span class="chip keep">Owner</span>' : l.brokerage === 'yes' ? '<span class="chip brok">Broker</span>' : ''}</div>`;
}
function boardHtml(l) {
  const money = [l.deposit ? `Deposit ${k(l.deposit)}` : l.depositMonths ? `Deposit ${l.depositMonths} mo` : '', l.maintenance ? `Maint. ${k(l.maintenance)}` : '', l.availableFrom ? `From ${esc(l.availableFrom)}` : ''].filter(Boolean);
  const wanted = l.kind === 'seeking';
  return `<div class="board"><span class="plate"${wanted ? ' data-wanted' : ''}>${wanted ? 'WANTED' : 'TO-LET'}</span>
    <div class="rent num">${l.rent ? `${inr(l.rent)}<small>/mo</small>` : '<small>Rent not stated</small>'}</div>
    <div class="kind">${kindLine(l).map(x => `<span>${esc(x)}</span>`).join('')}</div>
    ${money.length ? `<div class="money2">${money.map(x => `<span>${x}</span>`).join('')}</div>` : ''}
    ${stripHtml(l)}</div>`;
}
function chipsHtml(l) {
  const c = [];
  if (l.brokerage === 'no') c.push('<span class="chip keep">No brokerage</span>'); else if (l.brokerage === 'yes') c.push('<span class="chip brok">Brokerage</span>');
  if (l.gender) c.push(`<span class="chip">${{ male: 'Men', female: 'Women', any: 'Anyone' }[l.gender]}</span>`);
  if (l.multiFlat) c.push('<span class="chip">Multiple flats</span>');
  if (l.rentHistory?.length && l.rent < l.rentHistory.at(-1).rent) c.push('<span class="chip keep">Rent dropped</span>');
  if (l.hasUpdate) c.push('<span class="chip">Updated</span>');
  return c.length ? `<div class="chips">${c.join('')}</div>` : '';
}
function cardHtml(l) {
  const imgs = imagesOf(l);
  const group = l.posts?.[0]?.group || l.groups?.[0] || '';
  return `<button class="lcard" type="button" data-open="${esc(l.id)}" aria-label="${esc((l.rent ? inr(l.rent) + ' a month, ' : '') + typeName(l))}">
    ${imgs.length ? `<div class="photo"><img src="${esc(imgs[0])}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="count">${I.photo}${imgs.length} photo${imgs.length > 1 ? 's' : ''}</span></div>` : ''}
    ${boardHtml(l)}${chipsHtml(l)}<p class="excerpt">${postHtml(firstText(l))}</p>
    <div class="meta">${fresh(l) ? '<span class="fresh" aria-label="New"></span>' : ''}<span class="grp">${esc(group)}</span><span>${ago(l.lastPostedAt)}</span><span class="sp"></span>${(l.postCount || l.posts?.length || 0) > 1 || l.seenCount > 1 ? `<span class="reposts">Posted ${l.seenCount || l.postCount}×</span>` : ''}</div></button>`;
}

// ---------- Browse ----------
function browseQuery() {
  const p = new URLSearchParams();
  if (state.area != null) p.set('area', state.area);
  if (state.f.bhk) p.set('bhk', state.f.bhk);
  if (state.f.maxRent) p.set('maxRent', state.f.maxRent);
  if (state.f.type) p.set('type', state.f.type);
  p.set('limit', '30');
  return p;
}
async function loadBrowse(more = false) {
  const p = browseQuery(); const key = p.toString() + state.me.role;
  if (!more && state.browse.key === key) return;
  if (more && state.browse.next) p.set('before', state.browse.next);
  state.browse.loading = true;
  const base = signedIn() ? '/api/browse' : '/api/public/listings';
  try {
    const d = await api('GET', `${base}?${p}`);
    state.browse.items = more ? [...state.browse.items, ...d.listings] : d.listings; state.browse.next = d.next; state.browse.key = key;
  } catch (e) { if (e.status === 429) toast('Too many requests. Try again in a minute.', { err: true }); else fail(e); state.browse.items = more ? state.browse.items : []; }
  state.browse.loading = false;
}
function filtered() {
  let L = state.browse.items.filter(l => l.kind !== 'not_rental');
  if (state.f.nobroker) L = L.filter(l => l.brokerage === 'no');
  if (state.f.furnishing) L = L.filter(l => l.furnishing === state.f.furnishing);
  if (state.f.sort === 'rent') L = [...L].sort((a, b) => (a.rent || 1e9) - (b.rent || 1e9));
  return L;
}
const FILTERS = [
  ['bhk', 'BHK', [['', 'Any'], ['1RK', '1 RK'], ['1', '1 BHK'], ['2', '2 BHK'], ['3', '3 BHK'], ['4', '4 BHK']], v => v === '1RK' ? '1 RK' : `${v} BHK`],
  ['maxRent', 'Rent', [['', 'Any'], ['15000', '≤ ₹15k'], ['20000', '≤ ₹20k'], ['30000', '≤ ₹30k'], ['45000', '≤ ₹45k'], ['60000', '≤ ₹60k']], v => `≤ ₹${k(Number(v))}`],
  ['type', 'Type', [['', 'Any'], ['flat', 'Whole flat'], ['flatmate', 'Room / flatmate'], ['pg', 'PG']], v => ({ flat: 'Whole flat', flatmate: 'Flatmate', pg: 'PG' }[v])],
  ['furnishing', 'Furnishing', [['', 'Any'], ['fully', 'Furnished'], ['semi', 'Semi'], ['unfurnished', 'Unfurnished']], v => ({ fully: 'Furnished', semi: 'Semi', unfurnished: 'Unfurnished' }[v])],
  ['sort', 'Sort', [['new', 'Newest'], ['rent', 'Rent low to high']], v => v === 'rent' ? 'Rent ↑' : 'Newest'],
];
async function renderBrowse() {
  const main = $('#main');
  const area = areaName(state.area);
  main.innerHTML = `<div class="bhead"><h1>Flats to let in <button class="area-pick" type="button" data-act="pick-area">${esc(area ? `${area}, ${CITY}` : CITY)}</button></h1><p id="bline">Loading listings…</p></div>
    <div class="filters" role="toolbar" aria-label="Filters"><button class="fchip${area ? ' set' : ''}" type="button" data-act="pick-area" aria-haspopup="dialog">${I.pin}${esc(area || 'All areas')} ${I.chev}</button>${FILTERS.map(([key, label, , fmt]) => { const v = state.f[key]; const set = key === 'sort' ? v === 'rent' : !!v; return `<button class="fchip${set ? ' set' : ''}" type="button" data-filter="${key}" aria-haspopup="dialog">${esc(set ? fmt(v) : label)} ${I.chev}</button>`; }).join('')}
    <button class="fchip${state.f.nobroker ? ' set' : ''}" type="button" data-filter="nobroker" aria-pressed="${state.f.nobroker}">No brokerage</button></div>
    <div class="grid" id="grid">${state.browse.loading || !state.browse.key ? Array.from({ length: 3 }, () => '<div class="skel"><i class="b"></i><i></i><i></i><i></i></div>').join('') : ''}</div><div class="more" id="more"></div>`;
  main.onclick = browseClick;
  await loadBrowse();
  if (route() !== 'browse') return;
  drawGrid();
}
function drawGrid() {
  const L = filtered();
  const groups = new Set(L.flatMap(l => l.groups || []));
  $('#bline').innerHTML = `<b>${L.length}${state.browse.next ? '+' : ''} listing${L.length === 1 ? '' : 's'}</b> from ${groups.size} group${groups.size === 1 ? '' : 's'}, newest first. Reposts are merged into one card.${state.lastIngestMin != null ? ` Checked ${ago(Date.now() - state.lastIngestMin * 60e3)}.` : ''}`;
  const cells = L.map(cardHtml);
  if (!signedIn()) for (let i = 3; i <= cells.length; i += 13) cells.splice(i, 0, ctaCard());
  $('#grid').innerHTML = cells.join('') || `<div class="empty"><div class="eboard"></div><p>No listings${state.f.bhk ? ` with ${esc(FILTERS[0][3](state.f.bhk))}` : ''}${state.f.maxRent ? ` under ₹${k(Number(state.f.maxRent))}` : ''} in ${esc(areaName(state.area) || CITY)} yet.</p>${state.area != null || Object.entries(state.f).some(([key, v]) => v && key !== 'sort') ? '<button class="btn" type="button" data-act="clear-filters">Clear filters</button>' : ''}</div>`;
  $('#more').innerHTML = state.browse.next ? '<button class="btn" type="button" data-act="more">Show more</button>' : '';
  if (!state.swung && !reduceMotion()) { state.swung = true; $$('#grid .lcard').slice(0, 3).forEach((c, i) => { c.classList.add('swing'); c.style.animationDelay = (i * 60) + 'ms'; }); }
}
async function browseClick(e) {
  const open = e.target.closest('[data-open]'); if (open && !e.target.closest('a')) { location.hash = '#listing-' + open.dataset.open; return; }
  const f = e.target.closest('[data-filter]');
  if (f) {
    const key = f.dataset.filter;
    if (key === 'nobroker') { state.f.nobroker = !state.f.nobroker; store.set('filters', state.f); renderBrowse(); return; }
    const def = FILTERS.find(x => x[0] === key);
    const s = openSheet(`<div class="shead"><h2>${esc(def[1])}</h2><button class="btn quiet sm" type="button" data-close>Close</button></div><div class="pick-list">${def[2].map(([v, l]) => `<button class="pr btn quiet" type="button" data-v="${esc(v)}" aria-pressed="${state.f[key] === v}"><span class="nm">${esc(l)}</span>${state.f[key] === v ? I.check : ''}</button>`).join('')}</div>`, { label: def[1], center: true });
    s.addEventListener('click', ev => { if (ev.target.closest('[data-close]')) closeSheet(); const b = ev.target.closest('[data-v]'); if (b) { state.f[key] = b.dataset.v; store.set('filters', state.f); closeSheet(); renderBrowse(); } });
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'more') { await loadBrowse(true); drawGrid(); }
  if (act === 'clear-filters') { state.f = { bhk: '', maxRent: '', type: '', nobroker: false, furnishing: '', sort: 'new' }; store.set('filters', state.f); state.area = null; store.set('area', null); state.browse.key = ''; renderBrowse(); }
}

// ---------- listing detail ----------
async function openListing(id) {
  openSheet('<div class="skel"><i class="b"></i><i></i><i></i></div>', { label: 'Listing', route: 'listing-' + id });
  let l;
  try { l = signedIn() ? (state.listings.get(id) && (await api('GET', `/api/listings/${encodeURIComponent(id)}`))) || await api('GET', `/api/listings/${encodeURIComponent(id)}`) : await api('GET', `/api/public/listings/${encodeURIComponent(id)}`); }
  catch (e) { closeSheet(); fail(e); return; }
  const s = $('.sheet'); if (!s) return;
  const facts = [['Rent', l.rent ? inr(l.rent) : 'Not stated'], ['Deposit', l.deposit ? inr(l.deposit) : l.depositMonths ? `${l.depositMonths} months` : '–'], ['Maintenance', l.maintenance != null ? inr(l.maintenance) : '–'], ['Brokerage', l.brokerage === 'no' ? 'None' : l.brokerage === 'yes' ? (l.brokerageAmount ? inr(l.brokerageAmount) : 'Yes') : '–'],
    ['Type', typeName(l)], ['Furnishing', l.furnishing ? { fully: 'Furnished', semi: 'Semi-furnished', unfurnished: 'Unfurnished' }[l.furnishing] : '–'], ['For', l.gender ? { male: 'Men', female: 'Women', any: 'Anyone' }[l.gender] : '–'], ['Available', l.availableFrom || '–'],
    ['Area', (l.areas || []).map(areaName).filter(Boolean).join(', ') || '–'], ['First posted', when(l.firstPostedAt)]];
  if (signedIn() && l.society) facts.push(['Society', l.society]);
  if (l.locality) facts.push(['Locality', l.locality]);
  const p = (l.phones || [])[0];
  const contact = !signedIn() || l.limited
    ? `<div class="lock"><div class="lock-rows"><div class="crow"><span class="ic">${I.phone}</span><span class="tx"><span class="lbl">Phone</span><br><span class="val mono">+91 ••••• •••••</span></span>${I.lock.replace('class="i"', 'class="i pad"')}</div>
        <div class="crow"><span class="ic">${I.wa}</span><span class="tx"><span class="lbl">WhatsApp</span><br><span class="val">Message the poster</span></span>${I.lock.replace('class="i"', 'class="i pad"')}</div>
        <div class="crow"><span class="ic">${I.pin}</span><span class="tx"><span class="lbl">Location</span><br><span class="val">${esc((l.areas || []).map(areaName).filter(Boolean)[0] || 'Area')}, society hidden</span></span>${I.lock.replace('class="i"', 'class="i pad"')}</div></div>
        <div class="lock-foot"><p><b>Posters share their numbers with members, not the open web.</b> Sign in free to see them.</p><a class="btn google block" href="/auth/google?next=${encodeURIComponent('/#listing-' + l.id)}">${GOOGLE}Continue with Google</a></div></div>`
    : `<div class="contact">${p ? `<span class="num">+91 ${esc(phoneFmt(p))}</span><div class="row"><a class="btn sm" href="tel:+91${esc(p)}">${I.phone}Call</a><a class="btn sm keep" href="https://wa.me/91${esc(p)}?text=${encodeURIComponent('Hi, is the flat from your post still available?')}" target="_blank" rel="noopener">${I.wa}WhatsApp</a><button class="btn sm quiet" type="button" data-copy="${esc(p)}">${I.copy}Copy</button></div>` : '<span class="small">No phone number in the post.</span>'}
        ${(l.mapLinks || []).map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${I.pin} Map pin</a>`).join('')}</div>`;
  const imgs = imagesOf(l);
  const userBtns = signedIn() ? `<div class="field-row section-gap">${l.status !== 'approved' ? `<button class="btn keep" type="button" data-decide="approved">${I.heart}Shortlist</button>` : ''}${l.status !== 'rejected' ? `<button class="btn" type="button" data-decide="rejected">${I.x}Pass</button>` : ''}${l.status !== 'new' ? `<button class="btn quiet" type="button" data-decide="new">Back to Review</button>` : ''}</div>` : '';
  s.innerHTML = `<div class="handle"></div><div class="shead"><h2>${esc(typeName(l))}</h2><button class="btn quiet sm" type="button" data-close>Close</button></div>
    ${boardHtml(l)}${chipsHtml(l)}<dl class="facts">${facts.map(([a, b]) => `<div><dt>${a}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
    ${contact}${userBtns}
    ${imgs.length ? `<div class="photos">${imgs.map(u => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>` : ''}
    <h3 class="stage-h">${(l.posts || []).length > 1 ? `${l.posts.length} posts merged` : 'Post'}</h3>
    ${(l.posts || []).map(q => `<div class="post"><div class="pm"><b>${esc(q.group || 'Group not detected')}</b><span>${ago(q.postedAt || q.importedAt)}</span>${signedIn() && q.author ? `<span>${esc(q.author)}</span>` : ''}${signedIn() && q.url ? `<a href="${esc(q.url)}" target="_blank" rel="noopener">Open post</a>` : ''}</div><p class="pt">${postHtml(q.text)}</p></div>`).join('')}
    ${l.rentHistory?.length ? `<h3 class="stage-h">Rent history</h3><p class="small">${l.rentHistory.map(h => `${inr(h.rent)} (${when(h.at)})`).join(' → ')} → ${inr(l.rent)}</p>` : ''}`;
  s.onclick = async e => {
    if (e.target.closest('[data-close]')) closeSheet();
    const c = e.target.closest('[data-copy]'); if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Number copied'); } catch { toast('Copy failed', { err: true }); } }
    const d = e.target.closest('[data-decide]'); if (d) { closeSheet(); decide(l.id, d.dataset.decide); }
  };
}

// ---------- sign in ----------
function openSignin(context) {
  const next = state.base && state.base !== 'signin' ? '/#' + state.base : '/';
  openSheet(`<div class="shead"><span class="plate" aria-hidden="true">TO-LET</span><span class="sp"></span><button class="btn quiet sm" type="button" data-close>Close</button></div>
    <h2 class="signin-title">Sign in to Flat Hunt</h2>${context ? `<p>${esc(context)}</p>` : ''}
    <ul class="small"><li>Owner's phone, WhatsApp and map pin</li><li>Your own swipe deck and shortlist</li><li>Pick the areas we scan for you</li></ul>
    ${state.me.login?.google ? `<a class="btn google block" href="/auth/google?next=${encodeURIComponent(next)}">${GOOGLE}Continue with Google</a>` : '<p class="help">Google sign-in is not set up on this server yet.</p>'}
    <p class="small">We only use your name and email. Posters' numbers stay private to signed-in members.</p>${iosSigninNote(esc)}
    ${state.me.login?.password ? `<a class="small" href="/login?next=${encodeURIComponent(next)}">Admin password login</a>` : ''}`, { label: 'Sign in', center: true, route: 'signin' }).onclick = e => { if (e.target.closest('[data-close]')) closeSheet(); };
}

// ---------- Review deck ----------
function deckList() { return mine().filter(l => l.status === 'new' && isOffer(l)).sort((a, b) => b.lastPostedAt - a.lastPostedAt); }
function renderReview() {
  const main = $('#main'); const L = deckList();
  main.innerHTML = `<div class="wrap"><div class="screen-h"><h1>Review</h1><span class="sub">${L.length} new</span></div>${L.length ? `<div class="deckwrap"><div class="deck" id="deck">${L.slice(0, 3).reverse().map((l, i, a) => {
    const pos = a.length - 1 - i;
    return `<article class="scard ${pos === 0 ? 'top' : 'b' + pos}" data-id="${esc(l.id)}" aria-label="${esc((l.rent ? inr(l.rent) + ' a month' : 'Rent not stated') + ', ' + typeName(l))}"${pos === 0 ? ' tabindex="0"' : ''}>
      <span class="stamp keep">SHORTLIST</span><span class="stamp pass">PASS</span>${boardHtml(l)}${chipsHtml(l)}<p class="excerpt">${postHtml(firstText(l))}</p>
      <div class="sfoot">${(l.mapLinks || []).length ? `${I.pin}<span class="on">Map pin</span>` : ''}${imagesOf(l).length ? `${I.photo}<span>${imagesOf(l).length} photos</span>` : ''}<span class="sp"></span><button class="btn quiet sm info-btn" type="button" data-open="${esc(l.id)}">Full post</button></div></article>`;
  }).join('')}</div>
    <div class="deck-btns"><button class="rb sm" type="button" data-act="undo" aria-label="Undo"${state.undo.length ? '' : ' disabled'}>${I.undo}</button><button class="rb lg passb" type="button" data-act="pass" aria-label="Pass">${I.x}</button><button class="rb lg keepb" type="button" data-act="keep" aria-label="Shortlist">${I.heart}</button></div>
    <p class="kbdline"><kbd>←</kbd> pass · <kbd>→</kbd> shortlist · <kbd>↓</kbd> details · <kbd>Z</kbd> undo</p></div>` : reviewEmpty()}</div>`;
  main.onclick = e => {
    const o = e.target.closest('[data-open]'); if (o) { location.hash = '#listing-' + o.dataset.open; return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'keep' || act === 'pass') { const t = $('#deck .scard.top'); if (t) fly(t, act === 'keep' ? 1 : -1); }
    if (act === 'undo') undo();
    if (act === 'samples') importSamples();
  };
  const top = $('#deck .scard.top'); if (top) dragify(top);
}
function reviewEmpty() {
  if (!state.myAreas.length) return `<div class="empty"><div class="eboard"></div><p>Pick the areas you are hunting in, and new listings there land in this deck.</p><a class="btn primary" href="#areas">Choose areas</a></div>`;
  return `<div class="empty"><div class="eboard"></div><p>You're all caught up. New posts in ${esc(state.myAreas.map(a => a.name).join(', '))} arrive here after each scrape.</p><a class="btn" href="#browse">Browse listings</a>${isAdmin() ? '<button class="btn" type="button" data-act="samples" id="btn-samples">Import sample posts</button>' : ''}</div>`;
}
async function importSamples() {
  try { const items = await (await fetch('/samples.json', { credentials: 'same-origin' })).json(); const r = await api('POST', '/api/import', { source: 'sample', items }); toast(`${r.report.newListings} new listings from the samples`); await syncListings({ full: true }); render(); } catch (e) { fail(e); }
}
function dragify(card) {
  let x0 = 0, y0 = 0, dx = 0, active = false, horiz = null;
  const stamps = { keep: $('.stamp.keep', card), pass: $('.stamp.pass', card) };
  card.addEventListener('pointerdown', e => { if (e.target.closest('button,a')) return; active = true; horiz = null; x0 = e.clientX; y0 = e.clientY; dx = 0; card.setPointerCapture(e.pointerId); card.classList.add('dragging'); card.style.transition = 'none'; });
  card.addEventListener('pointermove', e => {
    if (!active) return; dx = e.clientX - x0; const dy = e.clientY - y0;
    if (horiz == null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy);
    if (!horiz) return;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
    stamps.keep.style.opacity = String(Math.max(0, Math.min(1, dx / 120))); stamps.pass.style.opacity = String(Math.max(0, Math.min(1, -dx / 120)));
  });
  const end = () => {
    if (!active) return; active = false; card.classList.remove('dragging');
    if (horiz && Math.abs(dx) >= 200) { fly(card, dx > 0 ? 1 : -1); return; }
    card.style.transition = 'transform var(--d3) var(--spring)'; card.style.transform = ''; stamps.keep.style.opacity = '0'; stamps.pass.style.opacity = '0';
  };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
}
function fly(card, dir) {
  const id = card.dataset.id;
  if (!reduceMotion()) { card.style.transition = 'transform var(--d3) var(--ease)'; card.style.transform = `translateX(${dir * 130}%) rotate(${dir * 14}deg)`; }
  setTimeout(() => decide(id, dir > 0 ? 'approved' : 'rejected'), reduceMotion() ? 0 : 180);
}
const writeChains = new Map();
async function decide(id, status) {
  const l = state.listings.get(id); if (!l) return;
  const prev = { status: l.status, stage: l.stage, decidedAt: l.decidedAt };
  Object.assign(l, { status, stage: status === 'approved' ? (l.stage || STAGES[0]) : status === 'new' ? '' : l.stage, decidedAt: Date.now(), hasUpdate: false });
  if (status !== 'new') state.undo.push({ id, prev });
  render();
  const body = status === 'new' ? { status, stage: '', decidedAt: null } : { status };
  patch(id, body);
  if (status !== 'new') toast(status === 'approved' ? 'Shortlisted' : 'Passed', { undo });
}
function patch(id, body) {
  const chain = (writeChains.get(id) || Promise.resolve()).catch(() => {}).then(async () => { const r = await api('PATCH', `/api/listings/${encodeURIComponent(id)}`, body); state.listings.set(id, r); return r; });
  writeChains.set(id, chain);
  chain.catch(e => { fail(e); syncListings({ full: true }).then(render); });
  return chain;
}
function undo() {
  const u = state.undo.pop(); if (!u) return;
  const l = state.listings.get(u.id); if (!l) return;
  Object.assign(l, u.prev); render();
  patch(u.id, { status: u.prev.status, stage: u.prev.stage || '', decidedAt: u.prev.decidedAt ?? null });
}
document.addEventListener('keydown', e => {
  if ($('.sheet') || e.target.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const r = route();
  if (r === 'review') {
    const t = $('#deck .scard.top');
    if (e.key === 'ArrowRight' && t) { e.preventDefault(); fly(t, 1); }
    else if (e.key === 'ArrowLeft' && t) { e.preventDefault(); fly(t, -1); }
    else if (e.key === 'ArrowDown' && t) { e.preventDefault(); location.hash = '#listing-' + t.dataset.id; }
    else if (e.key.toLowerCase() === 'z') undo();
  }
  if (e.key === '/' && r === 'browse') { e.preventDefault(); areaPicker(); }
  const n = ['1', '2', '3', '4'].indexOf(e.key); if (n >= 0) { const items = navItems(); if (items[n]) location.hash = '#' + items[n][0]; }
});

// ---------- Shortlist / Passed ----------
function rowHtml(l, passed = false) {
  const p = (l.phones || [])[0];
  return `<div class="srow" data-id="${esc(l.id)}"><button class="mini" type="button" data-open="${esc(l.id)}"><b>${l.rent ? k(l.rent) : '–'}</b><span>${esc(typeName(l))}</span></button>
    <div class="body"><span class="t">${esc((l.areas || []).map(areaName).filter(Boolean)[0] || '')}${l.society ? ' · ' + esc(l.society) : ''} ${l.hasUpdate ? '<span class="upd">Updated</span>' : ''}</span>
    <span class="small">${esc((l.posts?.[0]?.text || '').slice(0, 120))}</span>
    <div class="acts">${passed ? `<button class="btn sm" type="button" data-restore>${I.undo}Restore</button>` : `
      ${p ? `<a class="btn sm" href="tel:+91${esc(p)}" aria-label="Call">${I.phone}</a><a class="btn sm keep" href="https://wa.me/91${esc(p)}" target="_blank" rel="noopener" aria-label="WhatsApp">${I.wa}</a>` : ''}
      <select class="stage-pill" data-stage aria-label="Stage">${STAGES.map(s => `<option${s === l.stage ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      ${STAGES.indexOf(l.stage) < STAGES.length - 1 ? `<button class="btn sm" type="button" data-next>Next: ${esc(STAGES[STAGES.indexOf(l.stage) + 1] || STAGES[0])}</button>` : ''}
      <button class="btn sm quiet" type="button" data-menu aria-label="Move to Passed">${I.x}</button>`}</div>
    ${passed ? '' : `<textarea class="input" data-notes placeholder="Notes (owner name, visit time…)" aria-label="Notes">${esc(l.notes || '')}</textarea>`}</div></div>`;
}
function renderShortlist() {
  const L = mine().filter(l => l.status === 'approved').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  const q = (state.slq || '').toLowerCase();
  const F = q ? L.filter(l => JSON.stringify([l.notes, l.society, l.posts?.[0]?.text]).toLowerCase().includes(q)) : L;
  $('#main').innerHTML = `<div class="wrap"><div class="screen-h"><h1>Shortlist</h1><span class="sub">${L.length}</span><span class="sp"></span><input class="input" id="slq" placeholder="Search notes" value="${esc(state.slq || '')}"></div>
    ${F.length ? STAGES.map(s => { const R = F.filter(l => (l.stage || STAGES[0]) === s); return R.length ? `<h2 class="stage-h">${esc(s)} · ${R.length}</h2><div class="rows">${R.map(l => rowHtml(l)).join('')}</div>` : ''; }).join('') : '<div class="empty"><div class="eboard"></div><p>Nothing shortlisted yet. Swipe right in Review to keep a listing.</p><a class="btn" href="#review">Go to Review</a></div>'}</div>`;
  $('#slq').addEventListener('input', e => { state.slq = e.target.value; const pos = e.target.selectionStart; renderShortlist(); const i = $('#slq'); i.focus(); i.setSelectionRange(pos, pos); });
  rowsEvents();
}
function renderPassed() {
  const L = mine().filter(l => l.status === 'rejected').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  $('#main').innerHTML = `<div class="wrap"><div class="screen-h"><h1>Passed</h1><span class="sub">${L.length}</span></div>${L.length ? `<div class="rows">${L.map(l => rowHtml(l, true)).join('')}</div>` : '<div class="empty"><div class="eboard"></div><p>Listings you pass on show up here, in case you change your mind.</p></div>'}</div>`;
  rowsEvents();
}
function rowsEvents() {
  const main = $('#main');
  main.onclick = e => {
    const o = e.target.closest('[data-open]'); if (o) { location.hash = '#listing-' + o.dataset.open; return; }
    const row = e.target.closest('.srow'); if (!row) return; const id = row.dataset.id; const l = state.listings.get(id);
    if (e.target.closest('[data-restore]')) decide(id, 'new');
    if (e.target.closest('[data-menu]')) decide(id, 'rejected');
    if (e.target.closest('[data-next]')) { const nx = STAGES[STAGES.indexOf(l.stage) + 1] || STAGES[0]; l.stage = nx; l.hasUpdate = false; patch(id, { stage: nx, hasUpdate: false }); render(); }
  };
  main.onchange = e => { const sel = e.target.closest('[data-stage]'); if (sel) { const id = sel.closest('.srow').dataset.id; const l = state.listings.get(id); l.stage = sel.value; patch(id, { stage: sel.value, hasUpdate: false }); render(); } };
  main.addEventListener('focusout', e => { const t = e.target.closest('[data-notes]'); if (!t) return; const id = t.closest('.srow').dataset.id; const l = state.listings.get(id); if (l && l.notes !== t.value) { l.notes = t.value; patch(id, { notes: t.value }).then(() => toast('Notes saved')); } });
}

// ---------- My areas ----------
async function renderAreas() {
  const all = (await api('GET', '/api/areas?scope=all').catch(() => ({ areas: [] }))).areas;
  const mineIds = new Set(state.myAreas.map(a => a.id));
  $('#main').innerHTML = `<div class="wrap"><div class="screen-h"><h1>My areas</h1></div>
    <div class="area-chips">${state.myAreas.map(a => `<span class="achip">${esc(a.name)} <span class="st${a.matching || !(all.find(x => x.id === a.id)?.listings) ? ' wait' : ''}">${a.matching ? 'Matching existing posts…' : all.find(x => x.id === a.id)?.listings ? 'Scanning' : 'Waiting for first scrape'}</span><button type="button" data-rm="${a.id}" aria-label="Remove ${esc(a.name)}">${I.x}</button></span>`).join('') || '<p class="help">No areas yet.</p>'}</div>
    <label class="lbl" for="area-q">Add an area</label><input class="input" id="area-q" placeholder="Type an area, e.g. HSR Layout" autocomplete="off"><div class="pick-list" id="area-list"></div>
    <p class="help">New areas are scanned from the next scrape (about every 4 h). Posts we already have are matched right away.</p></div>`;
  alertsUI.decorateAreas($('#main'), state.myAreas, () => renderAreas()); // bell per area (web/alerts.js)
  const draw = () => {
    const q = $('#area-q').value.trim(); const ql = q.toLowerCase();
    const hits = all.filter(a => !mineIds.has(a.id) && (!ql || a.name.toLowerCase().includes(ql))).slice(0, 12);
    const exact = all.some(a => a.name.toLowerCase() === ql);
    $('#area-list').innerHTML = hits.map(a => `<div class="pr"><span class="nm">${esc(a.name)}</span><span class="ct">${a.listings} listings</span><button class="btn sm" type="button" data-add="${a.id}">Add</button></div>`).join('') + (q.length >= 2 && !exact ? `<div class="pr"><span class="nm">Create '${esc(q)}'</span><button class="btn sm primary" type="button" data-create>Create</button></div>` : '');
  };
  draw();
  $('#area-q').addEventListener('input', draw);
  $('#area-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const b = $('#area-list [data-add],#area-list [data-create]'); b?.click(); } });
  $('#main').onclick = async e => {
    const add = e.target.closest('[data-add]'), cr = e.target.closest('[data-create]'), rm = e.target.closest('[data-rm]');
    try {
      if (add || cr) {
        const a = await api('POST', '/api/areas', add ? { areaId: Number(add.dataset.add) } : { name: $('#area-q').value.trim() });
        toast(a.matching ? `Added ${a.name}. Matching existing posts…` : `Added ${a.name}`);
      }
      if (rm) { await api('DELETE', `/api/areas/${rm.dataset.rm}`); toast('Area removed'); }
      if (add || cr || rm) { await loadAreas(); await syncListings({ full: true }); renderChrome(); renderAreas(); }
    } catch (err) { fail(err); }
  };
}

// ---------- Account ----------
function renderAccount() {
  const u = state.me.user || {};
  const theme = store.get('theme', 'system');
  $('#main').innerHTML = `<div class="wrap"><div class="screen-h">${avatar()}<h1>${esc(u.name || 'Account')}</h1><span class="sub">${esc(u.email || '')}</span></div>
    <div class="panel"><h2>Theme</h2><div class="seg section-gap" role="group" aria-label="Theme">${['system', 'light', 'dark'].map(t => `<button type="button" data-theme="${t}" aria-pressed="${t === theme}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
    <div class="panel"><h2>Areas</h2><p class="help">${esc(state.myAreas.map(a => a.name).join(', ') || 'None yet')}</p><a class="btn sm" href="#areas">Edit my areas</a></div>
    <div id="alerts-panel"></div>
    ${isAdmin() ? `<div class="panel"><h2>Admin</h2><div class="field-row section-gap">${ADMIN_PAGES.map(([id, l, ic]) => `<a class="btn sm" href="#${id}">${ic}${l}</a>`).join('')}</div></div>` : ''}
    <div class="panel"><button class="btn danger" type="button" id="logout">Sign out</button></div></div>`;
  $('#main').onclick = async e => {
    const t = e.target.closest('[data-theme]'); if (t) { store.set('theme', t.dataset.theme); applyTheme(); renderAccount(); }
    if (e.target.closest('#logout')) { await alertsUI.beforeSignOut(); try { await api('POST', '/auth/logout'); } catch { /* ignore */ } location.href = '/'; }
  };
  alertsUI.mountAccount($('#alerts-panel'));
}
function applyTheme() { const t = store.get('theme', 'system'); if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }

// ---------- admin helpers: charts ----------
const niceMax = v => { if (v <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 2 ? 2 : n <= 4 ? 4 : n <= 5 ? 5 : 10) * p; };
const dLabel = d => { const [, m, day] = d.split('-'); return `${Number(day)} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)]}`; };
/** Charts are drawn at the container's real width (1 SVG unit = 1 px) and redrawn on resize. */
const chartObservers = [];
function chart(el, draw) {
  const paint = () => { const W = Math.max(240, Math.floor(el.clientWidth)); el.innerHTML = draw(W); };
  paint();
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(() => paint()); ro.observe(el); chartObservers.push(ro); }
}
function axes(W, H, max, pad, desc, title, attrs = '') {
  const ticks = [0, 1, 2, 3, 4].map(i => (max / 4) * i);
  return `<svg class="chart" role="img" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${attrs}><title>${esc(title)}</title><desc>${esc(desc)}</desc>${ticks.map((t, i) => { const y = H - pad.b - (H - pad.t - pad.b) * (t / max); return `<line class="grid${i === 0 ? ' base' : ''}" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="ax" x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${pad.pct ? Math.round(t) + '%' : pad.usd ? moneyTick(t) : Math.round(t)}</text>`; }).join('')}`;
}
function xLabels(W, H, days, pad, x, bw) { const every = W < 720 ? 4 : 2; return days.map((d, i) => i % every === 0 ? `<text class="ax" x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${dLabel(d.day)}</text>` : '').join(''); }
function barsChart(days, keyA, keyB, cls, title) {
  return W => {
    const H = 200, pad = { l: 40, r: 8, t: 8, b: 24 };
    const tot = d => keyB === 'off' ? d.postsFetched : d[keyA] + (d[keyB] || 0);
    const max = niceMax(Math.max(1, ...days.map(tot)));
    const step = (W - pad.l - pad.r) / days.length, bw = Math.max(2, step * 0.7), x = i => pad.l + i * step + (step - bw) / 2;
    const y = v => (H - pad.t - pad.b) * (v / max);
    const sum = days.reduce((a, d) => a + d[keyA], 0);
    return axes(W, H, max, pad, `${title}: ${sum} in ${days.length} days`, title) + days.map((d, i) => {
      const a = d[keyA], b = keyB === 'off' ? Math.max(0, d.postsFetched - d.matched) : d[keyB] || 0;
      const ya = H - pad.b - y(a);
      return `<g><title>${dLabel(d.day)}: ${a} ${keyA === 'matched' ? 'matched' : 'new'}, ${b} ${keyB === 'off' ? 'off-area' : 'merged'}</title><rect class="${cls[0]}" x="${x(i)}" y="${ya}" width="${bw}" height="${y(a)}"/>${b ? `<rect class="${cls[1]}" x="${x(i)}" y="${ya - y(b)}" width="${bw}" height="${y(b)}"/>` : ''}</g>`;
    }).join('') + xLabels(W, H, days, pad, x, bw) + '</svg>';
  };
}
function rateChart(days) {
  return W => {
    const H = 200, pad = { l: 40, r: 8, t: 8, b: 24, pct: true };
    const pts = days.map((d, i) => [i, d.matchRate]).filter(p => p[1] != null);
    const step = (W - pad.l - pad.r) / days.length, x = i => pad.l + i * step + step / 2, y = v => H - pad.b - (H - pad.t - pad.b) * (v / 100);
    const avg = pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : null;
    return axes(W, H, 100, pad, `Match rate, average ${avg == null ? 'n/a' : Math.round(avg) + '%'}`, 'Match rate') +
      (avg != null ? `<line class="s-avg" x1="${pad.l}" x2="${W - pad.r}" y1="${y(avg)}" y2="${y(avg)}"/>` : '') +
      (pts.length > 1 ? `<path class="s-line" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0])},${y(p[1])}`).join('')}"/>` : '') +
      pts.map(p => `<g><title>${dLabel(days[p[0]].day)}: ${p[1]}%</title><circle class="s-dot" cx="${x(p[0])}" cy="${y(p[1])}" r="3.5"/></g>`).join('') +
      xLabels(W, H, days, pad, i => x(i) - 0, 0) + '</svg>';
  };
}
function groupChart(groups) {
  return W => {
    const G = groups.slice(0, 10); const row = 28, H = Math.max(60, G.length * row + 8), lw = Math.min(180, W * 0.38);
    const max = niceMax(Math.max(1, ...G.map(g => g.newListings)));
    return `<svg class="chart" role="img" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>New listings per group</title><desc>${esc(G.map(g => `${g.group}: ${g.newListings}`).join(', ') || 'No groups yet')}</desc>` + G.map((g, i) => {
      const yy = 4 + i * row; const name = g.group.length > 26 ? g.group.slice(0, 25) + '…' : g.group;
      if (g.failures && !g.postsFetched) return `<g><text class="lbl" x="${lw - 8}" y="${yy + 17}" text-anchor="end">${esc(name)}</text><rect class="s-amber" x="${lw}" y="${yy + 4}" width="52" height="18" rx="9"/><text class="ax" x="${lw + 26}" y="${yy + 17}" text-anchor="middle" fill="#fff">Failed</text></g>`;
      const w = Math.max(2, (W - lw - 48) * (g.newListings / max));
      return `<g><title>${esc(g.group)}: ${g.newListings} new from ${g.postsFetched} posts (${g.matchRate ?? 0}% matched)</title><text class="lbl" x="${lw - 8}" y="${yy + 17}" text-anchor="end">${esc(name)}</text><rect class="s-new" x="${lw}" y="${yy + 5}" width="${w}" height="16" rx="3"/><text class="ax" x="${lw + w + 6}" y="${yy + 17}">${g.newListings}</text></g>`;
    }).join('') + '</svg>';
  };
}
function spark(values, cls = '') {
  const v = values.length ? values : [0]; const max = Math.max(1, ...v); const W = 100, H = 28;
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, v.length - 1)) * W},${H - 2 - (n / max) * (H - 4)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="${cls}" vector-effect="non-scaling-stroke" d="${d}"/></svg>`;
}
const delta = (cur, prev, word) => { if (!prev && !cur) return '<span>no change</span>'; const pct = prev ? Math.round(100 * (cur - prev) / prev) : 100; return pct >= 0 ? `<span class="up">+${pct}% up</span> vs previous ${word}` : `<span class="down">${pct}% down</span> vs previous ${word}`; };
const statusPill = s => ({ done: '<span class="pill ok">Done</span>', partial: '<span class="pill warn">Partial</span>', failed: '<span class="pill bad">Failed</span>', ingesting: '<span class="pill run">Ingesting</span>', running: '<span class="pill run">Running</span>' }[s] || `<span class="pill">${esc(s)}</span>`);
function stepper(id, value, min, max, step = 1, label = id) { return `<span class="stepper" data-stepper="${id}" data-min="${min}" data-max="${max}" data-step="${step}"><button type="button" data-dec aria-label="Less">−</button><input id="${id}" inputmode="numeric" value="${value}" aria-label="${esc(label)}"><button type="button" data-inc aria-label="More">+</button></span>`; }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-stepper] button'); if (!b) return;
  const s = b.closest('[data-stepper]'); const inp = $('input', s); const step = Number(s.dataset.step), min = Number(s.dataset.min), max = Number(s.dataset.max);
  inp.value = String(Math.min(max, Math.max(min, (Number(inp.value) || 0) + (b.hasAttribute('data-inc') ? step : -step))));
});
const stepVal = id => { const s = $(`[data-stepper="${id}"]`); return Math.min(Number(s.dataset.max), Math.max(Number(s.dataset.min), Number($('#' + id).value) || 0)); };
function adminHead(title, extra = '') { return `<div class="ahead"><h1>${esc(title)}</h1>${extra}</div>`; }

// ---------- #admin-scraper ----------
const hourLabel = h => `${h % 12 || 12}${h < 12 ? ' AM' : ' PM'}`;
const scheduleText = sch => sch.mode === 'interval' || !(sch.runHoursIst || []).length ? `Every ${sch.intervalHours} h` : `At ${sch.runHoursIst.map(hourLabel).join(', ')} IST`;
const usd = v => v == null ? '–' : '$' + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2));
async function renderScraper() {
  const main = $('#main'); main.innerHTML = `<div class="wrap">${adminHead('Scraper')}<div class="skel"><i></i><i></i></div></div>`;
  const days = state.statsDays;
  const [sc, st, runs, src] = await Promise.all([api('GET', '/api/admin/scraper'), api('GET', `/api/admin/stats?days=${Math.max(days, 14)}`), api('GET', '/api/admin/runs?limit=30'), api('GET', '/api/admin/sources')]);
  if (route() !== 'admin-scraper') return;
  state.admin.scraper = sc;
  const D = st.perDay.slice(-days); const last7 = st.perDay.slice(-7), prev7 = st.perDay.slice(-14, -7);
  const sum = (a, kk) => a.reduce((x, d) => x + (d[kk] || 0), 0);
  const u = sc.apifyUsage; const pct = u ? Math.round(100 * u.usedUsd / u.limitUsd) : null;
  const sch = sc.schedule;
  const m7 = sum(last7, 'matched'), f7 = sum(last7, 'postsFetched'), mp = sum(prev7, 'matched'), fp = sum(prev7, 'postsFetched');
  main.innerHTML = `<div class="wrap">${adminHead('Scraper', `<span class="status"><span class="dot${sch.enabled ? '' : ' off'}"></span>${sch.enabled ? `${scheduleText(sch)}${sc.nextRunAt ? `, next run ${new Date(sc.nextRunAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST` : ''}` : 'Paused'}</span><span class="sp"></span><button class="btn" type="button" data-act="schedule">Schedule</button><button class="btn primary" type="button" data-act="run">Run now</button>`)}
    <div class="kpis">
      <div class="kpi"><span class="k">Apify credit used</span><span class="v">${u ? `$${u.usedUsd}<small> of $${u.limitUsd}</small>` : '–'}</span><div class="meter"><i id="meter-fill" class="${pct >= sch.budgetStopPct ? 'hi' : pct >= sch.budgetWarnPct ? 'mid' : ''}"></i><span class="tick" id="tick-w"></span><span class="tick" id="tick-s"></span></div><span class="d">${u ? `${pct}% used${u.cycleEnd ? `, resets ${new Date(u.cycleEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}` : sc.apify.configured ? 'Usage not read yet' : 'APIFY_TOKEN not set'}</span></div>
      <div class="kpi"><span class="k">Posts fetched 7d</span><span class="v">${f7}</span>${spark(last7.map(d => d.postsFetched))}<span class="d">${delta(f7, fp, 'week')}</span></div>
      <div class="kpi"><span class="k">New listings 7d</span><span class="v">${sum(last7, 'newListings')}<small> +${sum(last7, 'merged')} merged</small></span>${spark(last7.map(d => d.newListings), 'new')}<span class="d">${delta(sum(last7, 'newListings'), sum(prev7, 'newListings'), 'week')}</span></div>
      <div class="kpi"><span class="k">Match rate 7d</span><span class="v">${f7 ? Math.round(100 * m7 / f7) : 0}<small>%</small></span>${spark(last7.map(d => d.matchRate || 0))}<span class="d">${fp ? (Math.round(100 * m7 / Math.max(1, f7)) - Math.round(100 * mp / fp) >= 0 ? `<span class="up">+${Math.round(100 * m7 / Math.max(1, f7)) - Math.round(100 * mp / fp)} pts up</span>` : `<span class="down">${Math.round(100 * m7 / Math.max(1, f7)) - Math.round(100 * mp / fp)} pts down</span>`) : 'no earlier data'}</span></div>
    </div>
    <div class="panel"><div class="phead"><h2>Sources</h2></div><div class="tscroll"><table class="tbl"><thead><tr><th>Source</th><th>Status</th><th class="n">Watched</th><th class="n">Posts 7d</th><th class="n">New 7d</th><th>Last run</th><th>Last error</th><th></th></tr></thead><tbody>
      ${src.sources.map(s => `<tr><td class="first" data-l="Source">${esc(s.name)}</td><td data-l="Status">${!s.connected ? '<span class="pill">Not connected</span>' : s.enabled === false ? '<span class="pill warn">Paused</span>' : '<span class="pill ok">Connected</span>'}</td><td class="n" data-l="Watched">${s.watched ?? '–'}${s.unsupported ? ` <span class="pill warn">${s.unsupported} Page</span>` : ''}</td><td class="n" data-l="Posts 7d">${s.last7d.postsFetched}</td><td class="n" data-l="New 7d">${s.last7d.newListings}</td><td data-l="Last run">${when(s.last7d.lastRunAt || s.lastRun?.at)}</td><td data-l="Error">${esc(s.lastError || '')}</td><td>${s.id === 'reddit' && s.connected ? '<button class="btn sm" type="button" data-act="run-reddit">Run</button>' : s.id === 'phone' ? '<a class="btn sm" href="#admin-phone">Upload</a>' : ''}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel"><div class="phead"><h2>Charts</h2><span class="sp"></span><div class="seg" role="group" aria-label="Range">${[7, 14, 30].map(n => `<button type="button" data-days="${n}" aria-pressed="${n === days}">${n} d</button>`).join('')}</div></div>
      <div class="charts"><div class="panel"><div class="phead"><h2>Posts per day</h2><div class="legend"><span><i></i>Matched an area</span><span><i class="off"></i>Off-area</span></div></div><div id="ch1"></div></div>
      <div class="panel"><div class="phead"><h2>Match rate</h2></div><div id="ch2"></div></div>
      <div class="panel"><div class="phead"><h2>New listings per day</h2><div class="legend"><span><i class="new-l"></i>New</span><span>Outline: merged reposts</span></div></div><div id="ch3"></div></div>
      <div class="panel"><div class="phead"><h2>Per-group yield</h2></div><div id="ch4"></div></div></div></div>
    <div class="panel"><div class="phead"><h2>Runs</h2></div><div class="tscroll"><table class="tbl"><thead><tr><th>Started</th><th>Source</th><th>Status</th><th class="n">Duration</th><th class="n">Fetched</th><th class="n">Matched</th><th class="n">New</th><th class="n">Merged</th><th class="n">Dupes</th><th class="n">Off-area</th><th class="n">Failed groups</th><th class="n">Cost</th></tr></thead><tbody>
      ${runs.runs.map((r, i) => `<tr data-run="${i}"><td class="first" data-l="Started">${when(r.startedAt || r.finishedAt)}</td><td data-l="Source">${esc(r.source)}</td><td class="stat" data-l="Status">${statusPill(r.status)}</td><td class="n" data-l="Duration">${dur(r.durationMs)}</td><td class="n" data-l="Fetched">${r.postsFetched}</td><td class="n" data-l="Matched">${r.matchedArea}</td><td class="n" data-l="New">${r.newListings}</td><td class="n" data-l="Merged">${r.merged}</td><td class="n" data-l="Dupes">${r.duplicates}</td><td class="n" data-l="Off-area">${r.offArea}</td><td class="n" data-l="Failed groups">${r.unscrapableGroups.length}</td><td class="n" data-l="Cost">${usd(r.costUsd)}</td></tr>`).join('') || '<tr><td>No runs yet.</td></tr>'}</tbody></table></div></div></div>`;
  if (pct != null) $('#meter-fill').style.width = Math.min(100, pct) + '%';
  $('#tick-w').style.left = sch.budgetWarnPct + '%'; $('#tick-s').style.left = sch.budgetStopPct + '%';
  chart($('#ch1'), barsChart(D, 'matched', 'off', ['s-match', 's-off'], 'Posts per day'));
  chart($('#ch2'), rateChart(D));
  chart($('#ch3'), barsChart(D, 'newListings', 'merged', ['s-new', 's-merged'], 'New listings per day'));
  chart($('#ch4'), groupChart(st.groups));
  main.onclick = async e => {
    const dd = e.target.closest('[data-days]'); if (dd) { state.statsDays = Number(dd.dataset.days); renderScraper(); return; }
    const row = e.target.closest('[data-run]'); if (row) { runSheet(runs.runs[Number(row.dataset.run)]); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'run') { e.target.closest('button').disabled = true; const r = await api('POST', '/api/admin/scraper/run', {}); toast(r.action === 'started' ? 'Run started. New posts arrive when it finishes.' : (r.detail || 'Nothing to do.'), { ms: 6000 }); renderScraper(); }
      if (act === 'run-reddit') { const r = await api('POST', '/api/admin/scraper/run', { source: 'reddit' }); toast(`Reddit: ${r.reddit.action}, ${r.reddit.fetched || 0} posts`); renderScraper(); }
      if (act === 'schedule') scheduleSheet(sc);
    } catch (err) { fail(err); }
  };
}
/** Run details sheet (Scraper runs table and Finance run costs). */
function runSheet(r) {
  openSheet(`<div class="shead"><h2>Run details</h2><button class="btn quiet sm" type="button" data-close>Close</button></div><table class="report"><tr><td>Source</td><td>${esc(r.source)} (${esc(r.actor || '')})</td></tr><tr><td>Started</td><td>${when(r.startedAt)}</td></tr><tr><td>Finished</td><td>${when(r.finishedAt)}</td></tr><tr><td>Not housing</td><td>${r.notHousing}</td></tr>${r.truncated ? `<tr><td>Hit limits</td><td>${r.truncated.rows ? 'Row limit reached. ' : ''}${r.truncated.charge ? 'Spend limit reached. ' : ''}${r.truncated.groups.length ? `${r.truncated.groups.length} group(s) returned the maximum ${r.truncated.perGroup} posts: ${esc(r.truncated.groups.join(', '))}. ` : ''}${r.truncated.recover ? 'This was already a re-read, so some older posts may be missing.' : 'The next run re-reads this window.'}</td></tr>` : ''}${r.cost ? `<tr><td>Cost</td><td>${usd(r.cost.totalUsd)}: ${r.cost.rows ?? '?'} rows ${usd(r.cost.resultsUsd)} + platform ${usd(r.cost.platformUsd)}</td></tr>` : ''}<tr><td>Seeking</td><td>${r.seeking}</td></tr>${r.error ? `<tr><td>Error</td><td>${esc(r.error)}</td></tr>` : ''}</table><h3 class="stage-h">Groups that couldn't be scraped</h3>${r.unscrapableGroups.length ? `<ul>${r.unscrapableGroups.map(g => `<li>${esc(g.name || g.url)}: ${esc(g.reason || '')}</li>`).join('')}</ul>` : '<p class="help">None.</p>'}`, { label: 'Run details' }).onclick = ev => { if (ev.target.closest('[data-close]')) closeSheet(); };
}
function scheduleSheet(sc, after = renderScraper) {
  const s = sc.schedule;
  const sh = openSheet(`<div class="shead"><h2>Schedule</h2><button class="btn quiet sm" type="button" data-close>Close</button></div>
    <label class="toggle"><span>Scraping on</span><input type="checkbox" role="switch" id="sc-on"${s.enabled ? ' checked' : ''}></label>
    <label class="toggle"><span>Reddit source on</span><input type="checkbox" role="switch" id="sc-rd"${s.redditEnabled !== false ? ' checked' : ''}></label>
    <div class="section-gap"><span class="lbl">When to run</span> <div class="seg" role="group" aria-label="Schedule mode"><button type="button" data-mode="times" aria-pressed="${s.mode !== 'interval'}">At set hours (IST)</button><button type="button" data-mode="interval" aria-pressed="${s.mode === 'interval'}">Every N hours</button></div></div>
    <div id="sc-hours" class="hours"${s.mode === 'interval' ? ' hidden' : ''} role="group" aria-label="Run hours, IST">${Array.from({ length: 24 }, (_, h) => `<button type="button" class="fchip${(s.runHoursIst || []).includes(h) ? ' set' : ''}" data-hour="${h}" aria-pressed="${(s.runHoursIst || []).includes(h)}">${hourLabel(h)}</button>`).join('')}</div>
    <p class="help">Each run fetches only posts since the last run, so extra runs cost almost nothing (about $0.0002 each). You pay per post fetched.</p>
    <div class="form-grid"><div id="sc-int-wrap"${s.mode === 'interval' ? '' : ' hidden'}><span class="lbl">Run every (hours)</span>${stepper('sc-int', s.intervalHours, 1, 24)}</div><div><span class="lbl">Posts per group (cap)</span>${stepper('sc-rpg', sc.resultsPerGroup, 5, sc.maxResultsPerGroup || 50, 5)}</div>
    <div><span class="lbl">Max spend per run ($)</span><input class="input" id="sc-max" inputmode="decimal" value="${s.maxRunUsd ?? 0.5}"></div>
    <div><span class="lbl">Warn at (%)</span>${stepper('sc-warn', s.budgetWarnPct, 10, 99, 5)}</div><div><span class="lbl">Stop at (%)</span>${stepper('sc-stop', s.budgetStopPct, 11, 100, 5)}</div>
    <div><span class="lbl">Fetch at most the last (days)</span>${stepper('sc-back', s.backfillDays, 1, 5)}</div><div><span class="lbl">Keep listings for (days)</span>${stepper('sc-ret', s.retentionDays, 7, 365, 5)}</div></div>
    <p class="help">Shortlisted listings are never deleted. At the warn level, posts per group are halved; at the stop level, runs pause until the Apify cycle resets. Apify stops a run that reaches the max spend.</p>
    <button class="btn primary block section-gap" type="button" id="sc-save">Save</button>`, { label: 'Schedule' });
  let mode = s.mode === 'interval' ? 'interval' : 'times';
  sh.onclick = async e => {
    if (e.target.closest('[data-close]')) closeSheet();
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; $$('[data-mode]', sh).forEach(b => b.setAttribute('aria-pressed', String(b === m))); $('#sc-hours').hidden = mode !== 'times'; $('#sc-int-wrap').hidden = mode !== 'interval'; }
    const hb = e.target.closest('[data-hour]');
    if (hb) { const on = hb.getAttribute('aria-pressed') !== 'true'; hb.setAttribute('aria-pressed', String(on)); hb.classList.toggle('set', on); }
    if (e.target.closest('#sc-save')) {
      const runHoursIst = $$('[data-hour][aria-pressed="true"]', sh).map(b => Number(b.dataset.hour));
      try { await api('PUT', '/api/admin/scraper', { mode, runHoursIst, maxRunUsd: Number($('#sc-max').value), enabled: $('#sc-on').checked, redditEnabled: $('#sc-rd').checked, intervalHours: stepVal('sc-int'), resultsPerGroup: stepVal('sc-rpg'), budgetWarnPct: stepVal('sc-warn'), budgetStopPct: stepVal('sc-stop'), backfillDays: stepVal('sc-back'), retentionDays: stepVal('sc-ret') }); closeSheet(); toast('Schedule saved'); after(); }
      catch (err) { fail(err); }
    }
  };
}

// ---------- #admin-finance (docs/design/FINANCE.md) ----------
const FIN_SAME = '<p id="fin-same" class="sr">The same numbers are in the Where the money goes and Run costs tables below.</p>';
const finEmpty = F => `<p class="help">No paid runs this cycle yet.${F.schedule.enabled && F.schedule.nextRunAt ? ` The next run is at ${ftime(F.schedule.nextRunAt)}.` : ''}</p>`;
const nDays = d => { const n = Math.max(1, Math.round(d)); return n === 1 ? 'day' : `${n} days`; };
/** E1: cumulative spend this cycle, the projection to the cycle end, the budget (and Apify credit) lines. */
/** Date labels for cycle charts: about one per 56 px, so "13 Nov" never overlaps on a phone. */
function finXLabels(W, H, days, pad, step) {
  const every = Math.max(1, Math.ceil(56 / step));
  return days.map((d, i) => i % every === 0 ? `<text class="ax" x="${pad.l + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${dLabel(d)}</text>` : '').join('');
}
function cumChart(F) {
  return W => {
    const H = W < 720 ? 180 : 200, pad = { l: 48, r: 8, t: 18, b: 24, usd: true };
    const days = F.cycle.days, n = days.length, f = F.forecast, b = F.budget.monthlyUsd, lim = F.apify.usage?.limitUsd ?? null;
    const sum = F.perDay.reduce((a, d) => a + d.costUsd, 0);
    // Apify's own figure includes platform pennies our run records miss: scale the line to end on it.
    const scale = f.mtdSource === 'apify' && sum > 0 ? f.mtdUsd / sum : 1;
    let c = 0; const cum = F.perDay.map(d => (c += d.costUsd * scale));
    if (cum.length && sum === 0) cum[cum.length - 1] = f.mtdUsd;
    const last = cum.at(-1) ?? 0, ti = cum.length - 1;
    const max = niceMoney(Math.max(b, lim || 0, f.projectedUsd, last) * 1.05);
    const step = (W - pad.l - pad.r) / n, x = i => pad.l + (i + 0.5) * step, y = v => H - pad.b - (H - pad.t - pad.b) * Math.min(1, v / max);
    const pi = f.pauseAt && f.pauseAt > F.now && f.pauseAt < F.cycle.end ? Math.min(n - 1, Math.floor((f.pauseAt - F.cycle.start) / 864e5)) : -1;
    const desc = `Spent ${usd2(f.mtdUsd)} of a ${usd2(b)} budget by ${fdate(F.now)}. Projected ${usd2(f.projectedUsd)} by ${fdate(F.cycle.end)}.${pi >= 0 ? ` Scraping pauses ${fdate(f.pauseAt)}.` : ''}`;
    const yb = y(b), pts = cum.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    let o = axes(W, H, max, pad, desc, 'Spend this cycle vs budget', ' aria-describedby="fin-same"');
    o += `<line class="s-bud" x1="${pad.l}" x2="${W - pad.r}" y1="${yb}" y2="${yb}"/><text class="ax" x="${pad.l + 4}" y="${yb - 5}">Budget ${usd2(b)}${lim === b ? ' (= Apify credit)' : ''}</text>`;
    if (lim != null && lim !== b) o += `<line class="s-cap" x1="${pad.l}" x2="${W - pad.r}" y1="${y(lim)}" y2="${y(lim)}"/><text class="ax" x="${W - pad.r - 2}" y="${y(lim) - 5}" text-anchor="end">Apify credit ${usd2(lim)}</text>`;
    if (pi >= 0) o += `<line class="s-pause" x1="${x(pi)}" x2="${x(pi)}" y1="${pad.t}" y2="${H - pad.b}"/><text class="ax t-pause" x="${x(pi)}" y="${pad.t - 6}" text-anchor="middle">Pauses</text>`;
    if (ti >= 0 && f.status !== 'unknown') {
      const xEnd = (pad.l + n * step).toFixed(1), yp = y(f.projectedUsd).toFixed(1);
      const xp = f.projectionCapped && f.pauseAt ? (pad.l + step * (f.pauseAt - F.cycle.start) / 864e5).toFixed(1) : null;
      o += `<path class="s-proj" d="M${x(ti).toFixed(1)},${y(last).toFixed(1)}${xp ? `L${xp},${yp}` : ''}L${xEnd},${yp}"/>`;
    }
    if (ti >= 0) {
      o += `<path class="s-cum" d="${pts}"/>`;
      // The part above the budget is the only red on the page, and only once spend really passed it.
      if (last >= b) o += `<clipPath id="fin-over"><rect x="0" y="0" width="${W}" height="${yb}"/></clipPath><path class="s-cum over" clip-path="url(#fin-over)" d="${pts}"/>`;
      o += `<circle class="s-dot" cx="${x(ti)}" cy="${y(last)}" r="3.5"/>${last >= b ? `<circle class="s-ring" cx="${x(ti)}" cy="${y(last)}" r="6"/>` : ''}`;
      o += F.perDay.map((d, i) => `<g><title>${dLabel(d.day)}: ${usd2(cum[i])} spent so far (${usd(d.costUsd)} that day, ${d.runs} run${d.runs === 1 ? '' : 's'})</title><rect class="hit" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${H - pad.t - pad.b}"/></g>`).join('');
    }
    return o + finXLabels(W, H, days, pad, step) + '</svg>';
  };
}
/** E2: daily spend, posts (rows) under platform and group-detail charges, with the budget's daily share. */
function moneyBars(F) {
  return W => {
    const H = W < 720 ? 180 : 200, pad = { l: 48, r: 8, t: 18, b: 24, usd: true };
    const days = F.cycle.days, n = days.length, by = new Map(F.perDay.map(d => [d.day, d])), f = F.forecast;
    const share = F.budget.monthlyUsd / Math.max(1, F.cycle.daysTotal);
    const max = niceMoney(Math.max(share, ...F.perDay.map(d => d.costUsd)) * 1.1);
    const step = (W - pad.l - pad.r) / n, bw = Math.max(2, step * 0.7), x = i => pad.l + i * step + (step - bw) / 2, h = v => (H - pad.t - pad.b) * Math.min(1, v / max);
    const top = F.perDay.reduce((a, d) => (d.costUsd > (a?.costUsd ?? 0) ? d : a), null);
    const desc = `Daily spend this cycle. Average ${usd(f.dailyRateUsd)} a day over the last ${nDays(f.rateWindowDays)}; highest ${usd(top?.costUsd ?? 0)}${top ? ` on ${dLabel(top.day)}` : ''}.`;
    let o = axes(W, H, max, pad, desc, 'Daily spend', ' aria-describedby="fin-same"');
    o += days.map((day, i) => {
      const d = by.get(day); if (!d || !d.costUsd) return '';
      const a = h(d.rowsUsd), bb = d.otherUsd > 0 ? Math.max(1, h(d.otherUsd)) : 0, ya = H - pad.b - a;
      return `<g><title>${dLabel(day)}: ${usd(d.costUsd)} (${d.rows} rows, ${d.runs} runs, ${d.newListings} new listings)</title><rect class="s-match" x="${x(i)}" y="${ya}" width="${bw}" height="${a}"/>${bb ? `<rect class="s-off" x="${x(i)}" y="${ya - bb}" width="${bw}" height="${bb}"/>` : ''}</g>`;
    }).join('');
    const ys = H - pad.b - h(share);
    o += `<line class="s-avg" x1="${pad.l}" x2="${W - pad.r}" y1="${ys}" y2="${ys}"/><text class="ax" x="${W - pad.r - 2}" y="${ys - 5}" text-anchor="end">Daily share ${usd(share)}</text>`;
    return o + finXLabels(W, H, days, pad, step) + '</svg>';
  };
}
/** G: monthly cost by number of groups for the current what-if inputs. */
function wiChart(wi) {
  return W => {
    const H = 140, pad = { l: 48, r: 8, t: 12, b: 22, usd: true }, c = wi.res, i = wi.inp, g = i.groups;
    const gmax = Math.min(Math.max(2 * g, (Number.isFinite(c.maxFree) ? c.maxFree : 0) + 2, 10), Math.max(200, 2 * g));
    const max = niceMoney(Math.max(c.monthlyAt(gmax), i.budget, i.limitUsd) * 1.05);
    const x = k => pad.l + (W - pad.l - pad.r) * k / gmax, y = v => H - pad.b - (H - pad.t - pad.b) * Math.min(1, v / max);
    const line2 = `Your budget covers up to ${c.maxGroups} group${c.maxGroups === 1 ? '' : 's'} at this rate. The free credit covers ${c.maxFree}.`;
    let o = axes(W, H, max, pad, line2, 'Monthly cost by number of groups');
    o += `<line class="s-bud" x1="${pad.l}" x2="${W - pad.r}" y1="${y(i.budget)}" y2="${y(i.budget)}"/><text class="ax" x="${W - pad.r - 2}" y="${y(i.budget) - 5}" text-anchor="end">Budget ${usd2(i.budget)}</text>`;
    if (i.limitUsd !== i.budget) o += `<line class="s-cap" x1="${pad.l}" x2="${W - pad.r}" y1="${y(i.limitUsd)}" y2="${y(i.limitUsd)}"/><text class="ax" x="${pad.l + 4}" y="${y(i.limitUsd) - 5}">Apify credit ${usd2(i.limitUsd)}</text>`;
    o += `<path class="s-cum" d="M${x(0)},${y(c.monthlyAt(0))}L${x(gmax)},${y(c.monthlyAt(gmax))}"/>`;
    const right = x(g) > W * 0.6;
    o += `<line class="s-avg" x1="${x(g)}" x2="${x(g)}" y1="${pad.t}" y2="${H - pad.b}"/><circle class="s-dot" cx="${x(g)}" cy="${y(c.monthlyUsd)}" r="4"/><text class="lbl" x="${right ? x(g) - 8 : x(g) + 8}" y="${Math.max(pad.t + 10, y(c.monthlyUsd) - 8)}" text-anchor="${right ? 'end' : 'start'}">${g} group${g === 1 ? '' : 's'} · ${usd2(c.monthlyUsd)}</text>`;
    o += [0, 1, 2, 3, 4].map(k => Math.round(gmax * k / 4)).map(v => `<text class="ax" x="${x(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`).join('');
    return o + '</svg>';
  };
}
function wiOutput(wi, cap) {
  const c = wi.res, i = wi.inp, m = c.monthlyUsd;
  const l1 = m <= i.budget ? `<span class="up">Inside your ${usd2(i.budget)} budget</span>, ${usd2(i.budget - m)} to spare.`
    : m <= i.limitUsd ? `<span class="warn-t">${usd2(m - i.budget)} over your budget</span>.`
    : `<span class="warn-t">Over the ${usd2(i.limitUsd)} Apify credit</span>. Runs would pause around day ${Math.ceil((i.limitUsd * i.stopPct / 100) / (m / 30.4))}.`;
  const l3 = c.postsPerRun <= cap ? `Longest gap between runs is ${i.longestGapHours} h, so about ${c.postsPerRun} posts per group per run (cap ${cap}).`
    : `<span class="warn-t">About ${c.postsPerRun} posts per group would arrive in the ${i.longestGapHours} h gap, over the ${cap} cap.</span> Add a run hour in that gap.`;
  return `<span class="v">${usd2(m)}<small> a month</small></span><p>${l1}</p><p>Your budget covers up to <strong>${c.maxGroups} group${c.maxGroups === 1 ? '' : 's'}</strong> at this rate. The free credit covers <strong>${c.maxFree}</strong>.</p><p>${l3}</p>
    <dl class="mini"><dt>Posts</dt><dd>${usd2(c.postsUsd)}</dd><dt>Group details</dt><dd>${usd2(c.detailsUsd)}</dd><dt>Platform</dt><dd>${usd2(c.platformUsd)}</dd></dl>`;
}
function budgetSheet(F) {
  const f = F.forecast, lim = F.apify.usage?.limitUsd ?? 5;
  const sh = openSheet(`<div class="shead"><h2>Monthly budget</h2><button class="btn quiet sm" type="button" data-close>Close</button></div>
    <label class="lbl" for="bud-usd">Monthly budget (US$)</label><input class="input" id="bud-usd" inputmode="decimal" value="${Number(F.budget.monthlyUsd).toFixed(2)}" aria-describedby="bud-e bud-h">
    <p class="err" id="bud-e" hidden>Enter an amount from $0.50 to $500.</p>
    <p class="help" id="bud-h">${F.apify.plan === 'free' ? `The Apify free plan gives ${usd2(lim)} of credit each cycle and can't overspend. A budget above ${usd2(lim)} only helps on a paid Apify plan.` : `Your Apify plan allows up to ${usd2(lim)} a cycle.`}</p>
    ${F.apify.configured ? `<p class="help">Current: ${usd2(f.mtdUsd)} spent this cycle; projected ${usd2(f.projectedUsd)}.</p>` : ''}
    <button class="btn keep block section-gap" type="button" id="bud-save">Save budget</button>`, { label: 'Monthly budget' });
  const save = async () => {
    const inp = $('#bud-usd'); const raw = inp.value.trim().replace(/^\$/, ''); const v = Number(raw);
    const ok = raw !== '' && Number.isFinite(v) && v >= 0.5 && v <= 500;
    inp.setAttribute('aria-invalid', String(!ok)); $('#bud-e').hidden = ok; if (!ok) { inp.focus(); return; }
    try { const r = await api('PUT', '/api/admin/finance', { monthlyBudgetUsd: Math.round(v * 100) / 100 }); closeSheet(); toast(`Budget saved: ${usd2(r.budget.monthlyUsd)} a month`); renderFinance(); }
    catch (err) { fail(err); }
  };
  sh.onclick = e => { if (e.target.closest('[data-close]')) closeSheet(); if (e.target.closest('#bud-save')) save(); };
  $('#bud-usd').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  $('#bud-usd').focus();
}
async function renderFinance(refresh = false) {
  const main = $('#main');
  if (refresh !== true) { refresh = false; main.innerHTML = `<div class="wrap">${adminHead('Finance & budget')}<div id="fin-skel"></div></div>`; }
  const skel = setTimeout(() => { const k = $('#fin-skel'); if (k) k.outerHTML = '<div class="skel"><i></i><i></i></div>'; }, 300);
  let F;
  try { F = await api('GET', '/api/admin/finance' + (refresh ? '?refresh=1' : '')); }
  catch (err) {
    clearTimeout(skel); if (route() !== 'admin-finance') return;
    main.innerHTML = `<div class="wrap">${adminHead('Finance & budget')}<div class="panel"><p class="help">Couldn't load finance data: ${esc(err.data?.message || err.message)}.</p><button class="btn" type="button" data-act="retry">Try again</button></div></div>`;
    main.onclick = e => { if (e.target.closest('[data-act="retry"]')) renderFinance(); };
    return;
  }
  clearTimeout(skel);
  if (route() !== 'admin-finance') return;
  if (refresh && F.apify.usageError) toast("Couldn't read Apify usage. Showing the last reading.", { err: true });
  drawFinance(F);
}
function drawFinance(F) {
  const main = $('#main'); const f = F.forecast, B = F.budget.monthlyUsd, sch = F.schedule, u = F.apify.usage, conf = F.apify.configured, e = F.efficiency;
  const [pc, pt] = finPill(F);
  const fresh = !conf ? '' : u?.checkedAt ? `Usage read ${ago(u.checkedAt)}${F.now - u.checkedAt > 6 * 36e5 ? ' (old)' : ''}` : 'Usage not read yet';
  const V = verdict(F);
  const pct = B > 0 ? Math.round(100 * f.mtdUsd / B) : 0;
  const ticks = !!u && u.limitUsd === B;
  const unk = !conf || f.status === 'unknown';
  const end = fdate(F.cycle.end);
  let c3v, c3d;
  if (!conf) { c3v = '–'; c3d = 'Needs Apify'; }
  else if (f.paused) { c3v = 'Paused'; c3d = `Resumes ${end}`; }
  else if (!sch.enabled) { c3v = 'Not this cycle'; c3d = 'Scraping is switched off'; }
  else if (f.pauseAt && f.pauseAt < F.cycle.end) { const n = Math.max(0, Math.round((f.pauseAt - F.now) / 864e5)); c3v = fdate(f.pauseAt); c3d = `${n} day${n === 1 ? '' : 's'} from now${f.warnAt && f.warnAt > F.now ? ` · fetches halve from ${fdate(f.warnAt)}` : ''}`; }
  else { c3v = 'Not this cycle'; c3d = `Credit resets ${end} with ${usd2(Math.max(0, f.limitUsd - (f.creditUsedUsd + (f.projectedUsd - f.mtdUsd))))} to spare`; }
  // C2 detail: no $/day when nothing more will be spent (switched off or paused by the guard).
  const tail = f.projectedUsd > B ? `<span class="warn-t">${usd2(f.projectedUsd - B)} over</span>` : `<span class="up">${usd2(B - f.projectedUsd)} spare</span>`;
  const c2d = !conf ? 'Needs Apify' : !sch.enabled ? `Scraping is switched off: no more spend · ${tail}` : f.paused ? `Scraping paused until ${end}: no more spend · ${tail}`
    : f.rateWindowDays < 1 || unk ? 'Forecast after the first full day'
    : `${f.rateWindowDays < 3 ? 'Early estimate: ' : ''}at ${usd2(f.forwardRateUsd)}/day, last ${nDays(f.rateWindowDays)} · ${f.projectionCapped && f.pauseAt ? `<span class="warn-t">stops ${fdate(f.pauseAt)}, when runs pause</span>` : tail}`;
  const pauseTick = conf && !f.paused && f.pauseAt && f.pauseAt > F.now && f.pauseAt < F.cycle.end;
  const S = suggestions(F);
  const SEV = { over: ['bad', 'Over budget'], watch: ['warn', 'Watch'], tip: ['run', 'Tip'] };
  const G = F.groups;
  const tot = G.reduce((a, g) => ({ usd: a.usd + g.cycleUsd, posts: a.posts + g.postsFetched, nw: a.nw + g.newListings, mo: a.mo + g.dailyUsd * 30.4, fl: a.fl + g.failures }), { usd: 0, posts: 0, nw: 0, mo: 0, fl: 0 });
  const D = whatIfDefaults(F); const wi = { inp: { ...D }, res: whatIfCost(D) };
  const actorShort = /^automly~/.test(F.apify.actor) ? 'automly' : F.apify.actor === 'apify~facebook-groups-scraper' ? 'The official scraper' : esc(F.apify.actor);
  const resets = r => r === 'daily-utc' ? 'Daily, 05:30 IST' : r === 'monthly' ? 'Monthly' : '–';
  const freeRow = s => {
    const p = s.measured && s.limit ? Math.round(100 * s.used / s.limit) : null;
    const used = s.measured ? `${s.unit === 'bytes' ? `${(s.used / 1e6).toFixed(1)} MB of 5 GB stored` : `${s.used.toLocaleString('en-US')} of ${s.limit.toLocaleString('en-US')} ${esc(s.unit)}`}<div class="meter sm" role="meter" aria-label="${esc(s.name)} use" aria-valuemin="0" aria-valuemax="${s.limit}" aria-valuenow="${s.used}" aria-valuetext="${p}% of ${s.period === 'day' ? "today's allowance" : 'the allowance'}"><i data-w="${Math.min(100, p)}" class="${p >= 100 ? 'hi' : p >= 80 ? 'mid' : ''}"></i></div>${s.note ? `<span class="small">${esc(s.note)}</span>` : ''}`
      : `<span class="small">${s.id === 'groq' && s.note ? esc(s.note) : 'Free: not measured yet'}</span>`;
    const st = !s.measured ? '<span class="pill">Free</span>' : p >= 100 ? '<span class="pill bad">Limit reached</span>' : p >= 80 ? '<span class="pill warn">Near limit</span>' : '<span class="pill ok">OK</span>';
    return `<tr><td class="first">${esc(s.name)}<br><span class="small">${esc(s.plan)}</span></td><td data-l="Allowance">${esc(s.allowanceText)}</td><td class="n" data-l="Used">${used}</td><td data-l="Resets">${resets(s.resets)}</td><td class="stat">${st}</td></tr>`;
  };
  main.innerHTML = `<div class="wrap fin" id="fin-root">${adminHead('Finance & budget', `<span class="status-line"><span class="pill${pc ? ' ' + pc : ''}">${pt}</span>${fresh ? ` <span class="small" id="fin-fresh">${fresh}</span>` : ''}</span><span class="sp"></span>${conf ? '<button class="btn" type="button" data-act="refresh">Refresh usage</button>' : ''}<button class="btn" type="button" data-act="budget">Set budget</button>`)}
    <section class="verdict" data-s="${V.s}" aria-labelledby="fin-verdict-h"><h2 id="fin-verdict-h" class="sr">Summary</h2><p>${V.html}</p>${V.sub ? `<p class="sub">${V.sub} <button class="linkish" type="button" data-act="refresh">Refresh usage</button></p>` : ''}</section>
    <section class="kpis fin-kpis" aria-label="This cycle at a glance">
      <div class="kpi"><span class="k">Spent this cycle</span><span class="v">${usd2(conf ? f.mtdUsd : 0)}<small> of ${usd2(B)}</small></span><div class="meter" role="meter" aria-label="Spent this cycle" aria-valuemin="0" aria-valuemax="${B}" aria-valuenow="${conf ? f.mtdUsd : 0}" aria-valuetext="${pct}% of budget"><i id="fin-m1" class="${f.mtdUsd >= B ? 'hi' : pct >= 80 || f.projectedUsd > B ? 'mid' : ''}"></i>${ticks ? `<span class="tick" id="fin-tw" title="Warn at ${sch.budgetWarnPct}%: posts per group halve"></span><span class="tick" id="fin-ts" title="Stop at ${sch.budgetStopPct}%: runs pause"></span>` : ''}</div><span class="d">${conf ? `${pct}% of budget · day ${Math.min(F.cycle.daysTotal, Math.max(1, Math.ceil(F.cycle.daysElapsed)))} of ${F.cycle.daysTotal}${f.mtdSource === 'runs' ? ' · from our runs' : ''}` : 'APIFY_TOKEN not set'}</span></div>
      <div class="kpi"><span class="k">Projected at cycle end</span><span class="v">${unk ? '–' : usd2(f.projectedUsd)}</span>${conf ? spark(F.perDay.map(d => d.costUsd)) : ''}<span class="d">${c2d}</span></div>
      <div class="kpi"><span class="k">Scraping pauses</span><span class="v">${c3v}</span><div class="meter cycle" aria-hidden="true"><i id="fin-cyc"></i>${pauseTick ? '<span class="tick pause" id="fin-tp"></span>' : ''}</div><span class="d">${c3d}</span></div>
      <div class="kpi"><span class="k">Cost per new listing</span><span class="v">${cents(e.costPerNewListingUsd)}</span>${conf ? spark(F.perDay.map(d => d.newListings ? d.costUsd / d.newListings : 0)) : ''}<span class="d">${conf ? costDelta(e.costPerNewListingUsd, e.prevCostPerNewListingUsd) : 'Needs Apify'}</span></div>
    </section>
    <section class="panel" aria-labelledby="fin-h-sugg"><div class="phead"><h2 id="fin-h-sugg">What to change</h2></div>${S.length ? `<ul class="sugg-list">${S.map(x => `<li class="sugg"><span class="pill ${SEV[x.severity][0]}">${SEV[x.severity][1]}</span><span>${x.html}</span><span class="save">${x.savingUsd ? `Saves about ${usd2(x.savingUsd)} this cycle` : ''}</span>${!x.action ? '' : x.action.href ? `<a class="btn sm" href="${x.action.href}">${esc(x.action.label)}</a>` : `<button class="btn sm" type="button" data-act="${x.action.act}"${x.action.k != null ? ` data-k="${x.action.k}"` : ''}>${esc(x.action.label)}</button>`}</li>`).join('')}</ul>` : '<p class="help">Nothing to change. Spending is on track and every group earns its keep.</p>'}</section>
    <div class="charts"><section class="panel" aria-labelledby="fin-h-ch1"><div class="phead"><h2 id="fin-h-ch1">Spend this cycle vs budget</h2><div class="legend"><span><i class="cum"></i>Spent</span><span><i class="proj"></i>Projected</span><span><i class="bud"></i>Budget</span></div></div><div id="fin-ch1"></div></section>
      <section class="panel" aria-labelledby="fin-h-ch2"><div class="phead"><h2 id="fin-h-ch2">Daily spend</h2><div class="legend"><span><i></i>Posts fetched</span><span><i class="off"></i>Platform and group details</span></div></div><div id="fin-ch2"></div></section></div>${FIN_SAME}
    <section class="panel" aria-labelledby="fin-h-groups"><div class="phead"><h2 id="fin-h-groups">Where the money goes</h2></div><p class="help">Facebook groups via Apify: ${usd2(F.bySource.apify.costUsd)} · Reddit: free · Phone scans: free · AI extraction: free</p>
      <div class="tscroll"><table class="tbl"><thead><tr><th>Group</th><th class="n">Spend this cycle</th><th class="n">Posts</th><th class="n">New listings</th><th class="n">Listings per $</th><th class="n">Monthly at this rate</th><th class="n">Failures</th><th><span class="sr">Manage</span></th></tr></thead><tbody>
      ${G.map(g => `<tr><td class="first">${esc(g.group)}${g.active === false ? ' <span class="pill">Paused</span>' : ''}<br><span class="small">${g.sharePct}% of spend</span><svg class="sharebar" viewBox="0 0 100 6" aria-hidden="true"><rect class="tr" width="100" height="6" rx="3"/><rect class="fl" width="${Math.max(0, Math.min(100, g.sharePct))}" height="6" rx="3"/></svg></td><td class="n" data-l="Spend">${usd(g.cycleUsd)}</td><td class="n" data-l="Posts">${g.postsFetched}</td><td class="n" data-l="New">${g.newListings}${g.yieldPct != null ? ` <span class="small">(${g.yieldPct}%)</span>` : ''}</td><td class="n" data-l="Per $">${g.listingsPerUsd ?? '–'}${g.lowValue ? ' <span class="pill warn" title="20+ posts this cycle, under 15% became new listings">Low value</span>' : ''}</td><td class="n" data-l="Monthly">${usd2(g.dailyUsd * 30.4)}</td><td class="n" data-l="Failures">${g.failures}${!g.postsFetched && g.failures ? ' <span class="pill warn">Failed</span>' : ''}</td><td class="stat"><a class="btn sm quiet" href="#admin-groups" aria-label="Manage ${esc(g.group)}">Manage</a></td></tr>`).join('') || '<tr><td colspan="8">No group spend this cycle.</td></tr>'}</tbody>
      ${G.length ? `<tfoot><tr><td class="first">All groups</td><td class="n" data-l="Spend">${usd(tot.usd)}</td><td class="n" data-l="Posts">${tot.posts.toLocaleString('en-US')}</td><td class="n" data-l="New">${tot.nw}</td><td class="n" data-l="Per $">${tot.usd > 0 ? Math.round(tot.nw / tot.usd) : '–'}</td><td class="n" data-l="Monthly">${usd2(tot.mo)}</td><td class="n" data-l="Failures">${tot.fl}</td><td></td></tr></tfoot>` : ''}</table></div></section>
    <section class="panel" aria-labelledby="fin-h-wi"><div class="phead"><h2 id="fin-h-wi">What if we add groups?</h2></div><p class="help">Cost comes from how many posts the groups write, not how often we run. Change the numbers to see a month's cost before adding groups.</p>
      <div class="calc"><div>
        <label class="lbl" for="wi-groups">Groups</label>${stepper('wi-groups', D.groups, 0, 200, 1, 'Groups')}
        <label class="lbl" for="wi-pph">Posts per group per hour</label><input class="input" id="wi-pph" inputmode="decimal" value="${D.pph}" aria-describedby="wi-pph-h wi-pph-e">
        <p class="help" id="wi-pph-h">${F.whatIf.measured ? `Measured: ${F.whatIf.postsPerGroupPerHour} over the last 7 days across ${F.whatIf.activeGroups} group${F.whatIf.activeGroups === 1 ? '' : 's'}.` : 'Estimate: about 1.5 for an area group. Busy city-wide groups post 5 or more.'} <button class="btn sm quiet" type="button" data-act="wi-reset">${F.whatIf.measured ? 'Use measured' : 'Use estimate'}</button></p>
        <p class="err" id="wi-pph-e" hidden>Enter a number from 0 to 50</p>
        <label class="lbl" for="wi-price">Price per post (US$)</label><input class="input" id="wi-price" inputmode="decimal" value="${D.price}" aria-describedby="wi-price-h wi-price-e">
        <p class="help" id="wi-price-h">${actorShort} charges ${usd(D.price)} per post. The official Apify scraper costs about $0.005.</p>
        <p class="err" id="wi-price-e" hidden>Enter a price from $0.0001 to $0.05</p>
        <span class="lbl">Runs per day</span><span class="ro">${sch.runsPerDay} (${esc(scheduleText(sch))})</span>
      </div><div>
        <output id="wi-out" for="wi-groups wi-pph wi-price" aria-live="polite">${wiOutput(wi, sch.resultsPerGroup)}</output>
        <p class="help">This doesn't change any settings. To add groups, go to <a href="#admin-groups">Groups</a>.</p>
        <div id="wi-ch"></div>
      </div></div></section>
    <section class="panel" aria-labelledby="fin-h-free"><div class="phead"><h2 id="fin-h-free">Free services</h2></div><p class="help">Everything except Apify runs on free plans today. Where we can measure use, it's shown against the free allowance.</p>
      <div class="tscroll"><table class="tbl"><thead><tr><th>Service</th><th>Free allowance</th><th class="n">Used</th><th>Resets</th><th>Status</th></tr></thead><tbody>${F.free.map(freeRow).join('')}</tbody></table></div>
      <p class="help">Free plans can change. Re-check the limits on each provider's pricing page once a quarter.</p></section>
    <section class="panel" aria-labelledby="fin-h-runs"><div class="phead"><h2 id="fin-h-runs">Run costs</h2></div>
      <div class="tscroll"><table class="tbl"><thead><tr><th>Started</th><th>Status</th><th class="n">Posts</th><th class="n">Posts cost</th><th class="n">Platform</th><th class="n">Total</th><th class="n">New listings</th><th class="n">Per new listing</th><th class="n">Capped</th></tr></thead><tbody>
      ${F.runs.map((r, i) => `<tr data-run="${i}" tabindex="0" aria-label="Run started ${esc(when(r.startedAt || r.finishedAt))}: open details"><td class="first" data-l="Started">${when(r.startedAt || r.finishedAt)}</td><td class="stat">${statusPill(r.status)}</td><td class="n" data-l="Posts">${r.cost?.rows ?? r.postsFetched}</td><td class="n" data-l="Posts $">${usd(r.cost?.resultsUsd ?? null)}</td><td class="n" data-l="Platform">${usd(r.cost?.platformUsd ?? null)}</td><td class="n" data-l="Total"><b>${usd(r.costUsd)}</b></td><td class="n" data-l="New">${r.newListings}</td><td class="n" data-l="Per new">${r.newListings && r.costUsd != null ? cents(r.costUsd / r.newListings) : '–'}</td><td class="n" data-l="Capped">${r.cappedGroups.length ? `<span class="pill warn">${r.cappedGroups.length} capped</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="9">No paid runs this cycle yet.</td></tr>'}</tbody></table></div>
      <p><a class="small" href="#admin-scraper">All runs on Scraper</a></p>
      <details class="how"><summary>How these numbers are worked out</summary>
        <p class="help"><strong>Spent this cycle</strong> is Apify's own figure for this billing cycle (${F.cycle.source === 'apify' ? `${fdate(F.cycle.start)} to ${end}` : 'calendar month (Apify cycle not read yet)'}). If we can't read it, we add up our run records instead.</p>
        <p class="help"><strong>Projected</strong> is spent so far plus the average daily spend over the last 7 days (fewer early in the cycle), times the days left.</p>
        <p class="help"><strong>Scraping pauses</strong> is when credit used reaches the stop level (${sch.budgetStopPct}%) at that daily rate. At the warn level (${sch.budgetWarnPct}%) each run fetches half as many posts per group.</p>
        <p class="help"><strong>Group spend</strong> is posts fetched from that group times the price per post. Platform charges aren't split by group.</p>
        <p class="help">Run frequency barely changes cost. Each run costs about $0.0002 in platform fees, and we only fetch posts newer than the last run.</p>
      </details></section></div>`;
  // Sizes go through the CSSOM (CSP: no inline styles).
  $('#fin-m1').style.width = Math.min(100, B > 0 ? 100 * (conf ? f.mtdUsd : 0) / B : 0) + '%';
  if (ticks) { $('#fin-tw').style.left = sch.budgetWarnPct + '%'; $('#fin-ts').style.left = sch.budgetStopPct + '%'; }
  $('#fin-cyc').style.width = Math.min(100, 100 * F.cycle.daysElapsed / Math.max(1, F.cycle.daysTotal)) + '%';
  if (pauseTick) $('#fin-tp').style.left = (100 * (f.pauseAt - F.cycle.start) / (F.cycle.end - F.cycle.start)) + '%';
  $$('[data-w]', main).forEach(el => { el.style.width = el.dataset.w + '%'; });
  const noRuns = !F.perDay.some(d => d.runs);
  if (noRuns) { $('#fin-ch1').innerHTML = finEmpty(F); $('#fin-ch2').innerHTML = finEmpty(F); }
  else { chart($('#fin-ch1'), cumChart(F)); chart($('#fin-ch2'), moneyBars(F)); }
  const wiEl = $('#wi-ch'); chart(wiEl, W => wiChart(wi)(W));
  // What-if: recalculate on input (100 ms debounce); invalid input keeps the last valid numbers, faded.
  const field = (id, lo, hi) => { const el = $('#' + id); const raw = el.value.trim(); const v = Number(raw); const ok = raw !== '' && Number.isFinite(v) && v >= lo && v <= hi; el.setAttribute('aria-invalid', String(!ok)); const er = $('#' + id + '-e'); if (er) er.hidden = ok; return ok ? v : null; };
  const calc = () => {
    if (!$('#wi-out')) return;
    const gRaw = $('#wi-groups').value.trim(), g = Number(gRaw); const okG = gRaw !== '' && Number.isInteger(g) && g >= 0 && g <= 200; $('#wi-groups').setAttribute('aria-invalid', String(!okG));
    const pph = field('wi-pph', 0, 50), price = field('wi-price', 0.0001, 0.05);
    const ok = okG && pph != null && price != null; $('#wi-out').classList.toggle('stale', !ok); if (!ok) return;
    wi.inp = { ...D, groups: g, pph, price }; wi.res = whatIfCost(wi.inp);
    $('#wi-out').innerHTML = wiOutput(wi, sch.resultsPerGroup);
    wiEl.innerHTML = wiChart(wi)(Math.max(240, Math.floor(wiEl.clientWidth)));
  };
  let wt = null; const soon = () => { clearTimeout(wt); wt = setTimeout(calc, 100); };
  const root = $('#fin-root');
  root.addEventListener('input', ev => { if (ev.target.closest('.calc')) soon(); });
  root.addEventListener('keydown', ev => { const row = ev.target.closest('tr[data-run]'); if (row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); runSheet(F.runs[Number(row.dataset.run)]); } });
  main.onchange = null;
  main.onclick = async ev => {
    if (ev.target.closest('[data-stepper="wi-groups"] button')) { soon(); return; }
    const row = ev.target.closest('tr[data-run]'); if (row) { runSheet(F.runs[Number(row.dataset.run)]); return; }
    const a = ev.target.closest('[data-act]'); if (!a) return;
    try {
      if (a.dataset.act === 'refresh') { $$('[data-act="refresh"]', main).forEach(b => { b.style.width = b.offsetWidth + 'px'; b.setAttribute('aria-busy', 'true'); b.disabled = true; }); await renderFinance(true); }
      if (a.dataset.act === 'budget') budgetSheet(F);
      if (a.dataset.act === 'schedule') { const sc = await api('GET', '/api/admin/scraper'); if (route() === 'admin-finance') scheduleSheet(sc, () => renderFinance()); }
      if (a.dataset.act === 'calc') { const inp = $('#wi-groups'); inp.value = String(Math.min(200, F.whatIf.activeGroups + Number(a.dataset.k || 0))); calc(); inp.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); inp.focus({ preventScroll: true }); }
      if (a.dataset.act === 'wi-reset') { $('#wi-pph').value = String(F.whatIf.postsPerGroupPerHour); calc(); }
    } catch (err) { fail(err); $$('[data-act="refresh"][aria-busy]', main).forEach(b => { b.removeAttribute('aria-busy'); b.disabled = false; b.style.width = ''; }); }
  };
}

// ---------- #admin-groups ----------
async function renderGroups() {
  const [g, st, sr] = await Promise.all([api('GET', '/api/admin/groups'), api('GET', '/api/admin/stats?days=7'), api('GET', '/api/admin/subreddits')]);
  if (route() !== 'admin-groups') return;
  const stat = name => st.groups.find(x => x.group.toLowerCase() === String(name).toLowerCase()) || {};
  const prefill = state.admin.prefillGroup || ''; state.admin.prefillGroup = '';
  $('#main').innerHTML = `<div class="wrap">${adminHead('Groups')}
    <div class="panel"><div class="phead"><h2>Facebook groups</h2></div><p class="help">Spend is posts fetched × the scraper's price per post. "Low value" means under 15% of a group's posts became new listings this week; consider swapping it for a busier Bangalore-wide group.</p><div class="field-row"><input class="input" id="g-name" placeholder="Group name" value="${esc(prefill)}"><input class="input" id="g-url" placeholder="https://www.facebook.com/groups/…"><button class="btn primary" type="button" data-act="add">Add group</button></div><p class="help" id="g-msg"></p>
    <div class="tscroll"><table class="tbl"><thead><tr><th>Group</th><th>Enabled</th><th>Last scraped</th><th class="n">Posts 7d</th><th class="n">New 7d</th><th class="n">Spend 7d</th><th class="n">Listings per $</th><th class="n">Failures</th><th></th></tr></thead><tbody>
    ${g.groups.map(x => { const s = stat(x.name); return `<tr data-id="${x.id}"><td class="first" data-l="Group">${esc(x.name || x.url)}<br><a class="small" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url.replace('https://www.facebook.com', ''))}</a>${x.supported ? '' : `<br><span class="pill warn">Page: not supported</span> <span class="small">${esc(x.warning)}</span>`}</td>
      <td data-l="Enabled"><label class="toggle"><span class="sr">Enabled</span><input type="checkbox" role="switch" data-toggle${x.active ? ' checked' : ''}></label></td><td data-l="Last scraped">${when(s.lastSeenAt)}</td><td class="n" data-l="Posts 7d">${s.postsFetched || 0}</td><td class="n" data-l="New 7d">${s.newListings || 0}${s.yieldPct != null ? ` <span class="small">(${s.yieldPct}%)</span>` : ''}</td><td class="n" data-l="Spend 7d">${usd(s.costUsd ?? null)}</td><td class="n" data-l="Listings per $">${s.listingsPerUsd ?? '–'}${s.lowValue ? ' <span class="pill warn" title="Under 15% of its posts became new listings this week">Low value</span>' : ''}${x.active && x.supported && !s.postsFetched ? ' <span class="pill" title="No posts fetched in 7 days">Quiet</span>' : ''}</td><td class="n" data-l="Failures">${s.failures || 0}</td><td><button class="btn sm danger" type="button" data-del aria-label="Remove">${I.bin}</button></td></tr>`; }).join('') || '<tr><td>No groups yet.</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="phead"><h2>Subreddits</h2>${sr.connected ? '<span class="pill ok">Connected</span>' : '<span class="pill">Not connected</span>'}</div><p class="help">One per line: <code>name</code>, or <code>name | search words</code> to search instead of reading /new.</p>
      <textarea class="input" id="subs">${esc(sr.subreddits.map(s => s.name + (s.query ? ' | ' + s.query : '')).join('\n'))}</textarea><button class="btn section-gap" type="button" data-act="subs">Save subreddits</button></div></div>`;
  $('#main').onclick = async e => {
    const tr = e.target.closest('tr[data-id]'); const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'add') { const r = await api('POST', '/api/admin/groups', { name: $('#g-name').value, url: $('#g-url').value }); toast(r.warnings?.length ? 'Added, but it is a Page: the group scraper skips it.' : 'Group added', { ms: 6000 }); renderGroups(); }
      if (act === 'subs') { const list = $('#subs').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, query] = l.split('|').map(s => s.trim()); return { name, ...(query ? { query } : {}) }; }); await api('PUT', '/api/admin/subreddits', { subreddits: list }); toast('Subreddits saved'); }
      if (tr && e.target.closest('[data-del]')) { await api('DELETE', `/api/admin/groups/${tr.dataset.id}`); toast('Group removed'); renderGroups(); }
    } catch (err) { if (act === 'add') $('#g-msg').textContent = err.data?.message || err.message; else fail(err); }
  };
  $('#main').onchange = async e => { const tr = e.target.closest('tr[data-id]'); if (tr && e.target.matches('[data-toggle]')) { try { await api('PATCH', `/api/admin/groups/${tr.dataset.id}`, { active: e.target.checked }); } catch (err) { fail(err); } } };
}

// ---------- #admin-phone ----------
function reportTable(r) {
  const rows = [['Posts read', r.total], ['New listings', r.newListings], ['Merged into existing', r.merged], ['Exact duplicates', r.dupes], ['Not housing', r.notHousing || 0], ['In no area yet (stored)', r.offArea || 0], ['Seeking', r.seeking], ['No text', r.noText]];
  return `<table class="report">${rows.map(([a, b]) => `<tr><td>${a}</td><td class="num"><b>${b ?? 0}</b></td></tr>`).join('')}</table>`;
}
async function renderPhone() {
  const d = await api('GET', '/api/admin/phone-scans');
  if (route() !== 'admin-phone') return;
  $('#main').innerHTML = `<div class="wrap">${adminHead('Phone scans')}
    <label class="drop" id="drop">${I.phone}<span>Drop scan JSON or choose a file</span><input type="file" id="scan-file" accept=".json,application/json" class="sr"></label><div id="scan-report"></div>
    <div class="panel"><div class="phead"><h2>Scan history</h2></div><div class="tscroll"><table class="tbl"><thead><tr><th>When</th><th class="n">Posts</th><th class="n">New</th><th class="n">Merged</th><th class="n">From groups we don't scrape</th></tr></thead><tbody>
      ${d.scans.map(s => `<tr><td class="first" data-l="When">${when(s.startedAt || s.finishedAt)}</td><td class="n" data-l="Posts">${s.postsFetched}</td><td class="n" data-l="New">${s.newListings}</td><td class="n" data-l="Merged">${s.merged}</td><td class="n" data-l="Unwatched">${s.outsideCount}</td></tr>`).join('') || '<tr><td>No scans yet.</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="phead"><h2>Posts from groups we don't scrape</h2></div><div class="tscroll"><table class="tbl"><thead><tr><th>Group</th><th class="n">Posts seen</th><th class="n">Matched an area</th><th></th></tr></thead><tbody>
      ${d.outsideGroups.map(o => `<tr><td class="first" data-l="Group">${esc(o.group)}</td><td class="n" data-l="Posts">${o.posts}</td><td class="n" data-l="Matched">${o.matched}</td><td><button class="btn sm" type="button" data-watch="${esc(o.group)}">Add to watched</button></td></tr>`).join('') || '<tr><td>None yet.</td></tr>'}</tbody></table></div></div></div>`;
  const upload = async file => {
    try { const json = JSON.parse(await file.text()); const r = await api('POST', '/api/admin/phone-scan', json); $('#scan-report').innerHTML = `<div class="panel"><h2>Imported</h2>${reportTable(r.report)}</div>`; toast(`${r.report.newListings} new listings`); syncListings({ full: true }).then(renderChrome); setTimeout(renderPhone, 1500); }
    catch (err) { fail(err instanceof SyntaxError ? new Error('That file is not valid JSON.') : err); }
  };
  $('#scan-file').addEventListener('change', e => e.target.files[0] && upload(e.target.files[0]));
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) upload(f); });
  $('#main').onclick = e => { const w = e.target.closest('[data-watch]'); if (w) { state.admin.prefillGroup = w.dataset.watch; location.hash = '#admin-groups'; toast('Paste the group link to start watching it.'); } };
}

// ---------- #admin-ai ----------
async function renderAi() {
  const d = await api('GET', '/api/admin/ai');
  if (route() !== 'admin-ai') return;
  const L = d.listings || {}; const q = d.queue || {};
  $('#main').innerHTML = `<div class="wrap">${adminHead('AI extraction', `<span class="status"><span class="dot${d.configured.workersAi || d.configured.groq ? '' : ' off'}"></span>${d.provider ? `Using ${esc(d.provider)} (${esc(d.model || '')})` : d.configured.workersAi ? 'Workers AI ready' : d.configured.groq ? 'Groq ready' : 'No provider configured'}</span><span class="sp"></span><button class="btn primary" type="button" data-act="run">Run now</button>`)}
    <div class="kpis"><div class="kpi"><span class="k">Read by AI</span><span class="v">${L.done || 0}</span><span class="d">${d.processedToday} today, queue ${(q.pending || 0) + (q.retry || 0)}</span></div>
      <div class="kpi"><span class="k">Read by rules only</span><span class="v">${L.none || 0}</span><span class="d">not in a followed area, or not reached yet</span></div>
      <div class="kpi"><span class="k">Failed</span><span class="v">${q.failed || 0}</span><span class="d">regex values kept</span></div>
      <div class="kpi"><span class="k">Neurons today</span><span class="v">${d.neurons.used}<small> of ${d.neurons.cap}</small></span><div class="meter"><i id="ai-meter"></i></div><span class="d">${d.cfPausedUntil ? 'Workers AI paused until ' + when(d.cfPausedUntil) : `median confidence ${d.medianConfidence != null ? Math.round(d.medianConfidence * 100) / 100 : '–'}`}</span></div></div>
    <div class="panel"><div class="phead"><h2>Confidence (30 days)</h2></div><div id="ai-hist"></div></div>
    <div class="panel"><div class="phead"><h2>Merge suggestions</h2></div>${d.suggestions.length ? `<div class="tscroll"><table class="tbl"><thead><tr><th>Listing A</th><th>Listing B</th><th>Why</th><th></th></tr></thead><tbody>${d.suggestions.map(s => `<tr data-sg="${s.id}"><td class="first" data-l="A">${inr(s.a_rent)} ${s.a_bhk ? esc(s.a_bhk) + ' BHK' : ''}<br><span class="small">${esc(s.a_text || '')}</span></td><td data-l="B">${inr(s.b_rent)} ${s.b_bhk ? esc(s.b_bhk) + ' BHK' : ''}<br><span class="small">${esc(s.b_text || '')}</span></td><td data-l="Why">${esc(s.reason)}</td><td><button class="btn sm" type="button" data-sgact="merge">Merge</button> <button class="btn sm quiet" type="button" data-sgact="dismiss">Dismiss</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">None.</p>'}</div>
    <div class="panel"><div class="phead"><h2>Failures</h2></div>${d.failures.length ? `<div class="tscroll"><table class="tbl"><thead><tr><th>Post</th><th>Error</th><th class="n">Attempts</th><th></th></tr></thead><tbody>${d.failures.map(f => `<tr><td class="first" data-l="Post">${esc(f.excerpt || f.listing_id)}</td><td data-l="Error">${esc(f.error || '')}</td><td class="n" data-l="Attempts">${f.attempts}</td><td><button class="btn sm" type="button" data-retry="${esc(f.post_id)}">Retry</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">None.</p>'}</div>
    <div class="panel"><div class="phead"><h2>Settings</h2></div><label class="toggle"><span>AI extraction on</span><input type="checkbox" role="switch" id="ai-on"${d.config.enabled ? ' checked' : ''}></label><div class="form-grid"><div><span class="lbl">Daily neuron cap</span>${stepper('ai-cap', d.config.neuronCap, 0, 10000, 500)}</div></div><button class="btn section-gap" type="button" data-act="save">Save</button></div></div>`;
  $('#ai-meter').style.width = Math.min(100, Math.round(100 * d.neurons.used / Math.max(1, d.neurons.cap))) + '%';
  chart($('#ai-hist'), W => {
    const H = 160, pad = { l: 40, r: 8, t: 8, b: 24 }; const max = niceMax(Math.max(1, ...d.histogram)); const step = (W - pad.l - pad.r) / 10, bw = step * 0.75;
    return axes(W, H, max, pad, `Confidence histogram: ${d.histogram.join(', ')}`, 'Confidence') + d.histogram.map((n, i) => { const h = (H - pad.t - pad.b) * (n / max); return `<g><title>${i / 10}–${(i + 1) / 10}: ${n}</title><rect class="${i < 6 ? 's-amber' : 's-match'}" x="${pad.l + i * step + (step - bw) / 2}" y="${H - pad.b - h}" width="${bw}" height="${h}"/><text class="ax" x="${pad.l + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${(i / 10).toFixed(1)}</text></g>`; }).join('') + '</svg>';
  });
  $('#main').onclick = async e => {
    try {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'run') { const r = await api('POST', '/api/admin/ai/run'); toast(r.action === 'ran' ? `Read ${r.done} posts${r.failed ? `, ${r.failed} failed` : ''}` : `AI: ${r.action}`); renderAi(); }
      if (act === 'save') { await api('PUT', '/api/admin/ai', { enabled: $('#ai-on').checked, neuronCap: stepVal('ai-cap') }); toast('Saved'); renderAi(); }
      const r = e.target.closest('[data-retry]'); if (r) { await api('POST', `/api/admin/ai/retry/${encodeURIComponent(r.dataset.retry)}`); toast('Queued again'); renderAi(); }
      const s = e.target.closest('[data-sgact]'); if (s) { await api('POST', `/api/admin/ai/suggestions/${s.closest('tr').dataset.sg}`, { action: s.dataset.sgact }); toast(s.dataset.sgact === 'merge' ? 'Merged' : 'Dismissed'); renderAi(); }
    } catch (err) { fail(err); }
  };
}

// ---------- #admin-data ----------
async function renderData(q = state.admin.dq || '') {
  const [d, sc] = await Promise.all([api('GET', `/api/admin/listings?limit=100&q=${encodeURIComponent(q)}`), api('GET', '/api/admin/scraper')]);
  if (route() !== 'admin-data') return;
  const sel = state.admin.sel = new Set();
  $('#main').innerHTML = `<div class="wrap">${adminHead('Data', `<span class="sp"></span><a class="btn" href="/api/admin/listings/export" download>Export JSON</a>`)}
    <div class="panel"><div class="phead"><h2>Retention</h2></div><p class="help">Listings older than this are deleted daily, with their duplicate keys, unless someone shortlisted them.</p><div class="field-row"><span class="lbl">Delete listings older than (days)</span>${stepper('ret', sc.schedule.retentionDays, 7, 365, 5)}<button class="btn" type="button" data-act="ret">Save</button></div>${sc.purge ? `<p class="help">Last purge ${when(sc.purge.at)}: ${sc.purge.deleted} deleted.</p>` : ''}</div>
    <div class="panel"><div class="phead"><h2>Listings</h2><span class="sub">${d.total}</span></div><input class="input" id="dq" placeholder="Search post text" value="${esc(q)}"><div id="bulk"></div>
    <div class="tscroll"><table class="tbl"><thead><tr><th><span class="sr">Select</span></th><th>Rent</th><th>Type</th><th>Areas</th><th>Last posted</th><th class="n">Shortlisted by</th><th>AI</th></tr></thead><tbody>
    ${d.listings.map(l => `<tr data-id="${esc(l.id)}"><td><input type="checkbox" data-sel aria-label="Select"></td><td class="first" data-l="Rent">${l.rent ? inr(l.rent) : '–'}<br><span class="small">${esc((l.posts?.[0]?.text || '').slice(0, 80))}</span></td><td data-l="Type">${esc(typeName(l))}</td><td data-l="Areas">${esc((l.areas || []).map(areaName).filter(Boolean).join(', ') || 'none')}</td><td data-l="Posted">${when(l.lastPostedAt)}</td><td class="n" data-l="Shortlisted">${l.shortlistedBy}</td><td data-l="AI">${esc(l.aiStatus || '–')}</td></tr>`).join('') || '<tr><td>No listings.</td></tr>'}</tbody></table></div></div></div>`;
  let t = null; $('#dq').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.admin.dq = e.target.value; renderData(e.target.value).then(() => { const i = $('#dq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); });
  const bulk = () => { $('#bulk').innerHTML = sel.size ? `<div class="bulk"><span>${sel.size} selected</span><span class="sp"></span><button class="btn sm danger" type="button" data-act="del">Delete</button></div>` : ''; };
  $('#main').onchange = e => { if (e.target.matches('[data-sel]')) { const id = e.target.closest('tr').dataset.id; e.target.checked ? sel.add(id) : sel.delete(id); bulk(); } };
  $('#main').onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'ret') { await api('PUT', '/api/admin/scraper', { retentionDays: stepVal('ret') }); toast('Retention saved'); }
      if (act === 'del') {
        const sh = openSheet(`<div class="shead"><h2>Delete ${sel.size} listings?</h2></div><p>They disappear for everyone, including from shortlists. Reposts would come back as new listings.</p><div class="field-row"><button class="btn danger" type="button" data-yes>Delete</button><button class="btn" type="button" data-close>Keep</button></div>`, { label: 'Confirm delete', center: true });
        sh.onclick = async ev => { if (ev.target.closest('[data-close]')) closeSheet(); if (ev.target.closest('[data-yes]')) { closeSheet(); const r = await api('POST', '/api/admin/listings/delete', { ids: [...sel] }); toast(`${r.deleted} deleted`); renderData(); } };
      }
    } catch (err) { fail(err); }
  };
}

// ---------- #admin-users ----------
async function renderUsers() {
  const d = await api('GET', '/api/admin/users');
  if (route() !== 'admin-users') return;
  const me = state.me.user?.id;
  $('#main').innerHTML = `<div class="wrap">${adminHead('Users')}<div class="panel"><label class="toggle"><span>Require approval for new users</span><input type="checkbox" role="switch" id="req"${d.requireApproval ? ' checked' : ''}></label><p class="help">When on, new sign-ups see the public view until you approve them.</p></div>
    <div class="panel"><div class="tscroll"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="n">Areas</th><th class="n">Shortlisted</th><th>Last seen</th></tr></thead><tbody>
    ${d.users.map(u => `<tr data-id="${u.id}"><td class="first" data-l="Name">${esc(u.name || '–')}</td><td data-l="Email">${esc(u.email)}</td>
      <td data-l="Role"><select data-role aria-label="Role"${u.id === me || u.envAdmin ? ' disabled' : ''}><option value="user"${u.role === 'user' ? ' selected' : ''}>User</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select>${u.envAdmin ? ' <span class="small">ADMIN_EMAILS</span>' : ''}</td>
      <td data-l="Status"><select data-status aria-label="Status"${u.id === me ? ' disabled' : ''}>${['active', 'pending', 'blocked'].map(s => `<option value="${s}"${u.status === s ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></td>
      <td class="n" data-l="Areas">${u.areas}</td><td class="n" data-l="Shortlisted">${u.shortlisted}</td><td data-l="Last seen">${when(u.lastSeenAt)}</td></tr>`).join('')}</tbody></table></div><p class="help">You cannot demote or block yourself.</p></div></div>`;
  $('#main').onchange = async e => {
    try {
      if (e.target.id === 'req') { await api('PUT', '/api/admin/settings', { requireApproval: e.target.checked }); toast('Saved'); return; }
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      const body = e.target.matches('[data-role]') ? { role: e.target.value } : { status: e.target.value };
      await api('PATCH', `/api/admin/users/${tr.dataset.id}`, body); toast('Saved');
    } catch (err) { fail(err); renderUsers(); }
  };
}

// ---------- area alerts (web/alerts.js) ----------
const alertsUI = createAlertsUI({ api, esc, toast, fail, openSheet, closeSheet, cardHtml });

// ---------- router ----------
const SCREENS = { browse: renderBrowse, review: renderReview, shortlist: renderShortlist, passed: renderPassed, areas: renderAreas, account: renderAccount, alerts: () => alertsUI.renderScreen($('#main')), 'admin-alerts': () => alertsUI.renderAdmin($('#main'), adminHead),
  'admin-scraper': renderScraper, 'admin-finance': renderFinance, 'admin-groups': renderGroups, 'admin-phone': renderPhone, 'admin-ai': renderAi, 'admin-data': renderData, 'admin-users': renderUsers };
const LOCKED = { alerts: 'Sign in to get alerts for new flats in your areas.', review: 'Sign in to get your own swipe deck.', shortlist: 'Sign in to keep a shortlist.', passed: 'Sign in to keep a shortlist.', areas: 'Sign in to pick your areas.', account: '' };
async function render() {
  chartObservers.splice(0).forEach(o => o.disconnect());
  let r = route();
  if (r.startsWith('listing-')) { if (!state.base) { state.base = 'browse'; await renderScreen('browse'); } renderChrome(); if (!$('#scrim') || sheetRoute !== r) openListing(decodeURIComponent(r.slice(8))); return; }
  if (r === 'signin') { if (signedIn()) { location.hash = '#browse'; return; } if (!state.base) { state.base = 'browse'; await renderScreen('browse'); } renderChrome(); openSignin(''); return; }
  // #area-<id> (alert notifications): the homepage filtered to that area.
  if (/^area-\d+$/.test(r)) { const id = Number(r.slice(5)); state.area = state.areas.some(a => a.id === id) ? id : null; store.set('area', state.area); state.browse.key = ''; history.replaceState(null, '', '#browse'); r = 'browse'; }
  if (r.startsWith('admin-') && !isAdmin()) { history.replaceState(null, '', '#browse'); r = 'browse'; toast('That page is for admins.'); }
  if (!signedIn() && r in LOCKED) { history.replaceState(null, '', '#browse'); state.base = 'browse'; await renderScreen('browse'); renderChrome(); openSignin(LOCKED[r]); return; }
  if (!SCREENS[r]) { history.replaceState(null, '', '#browse'); r = 'browse'; }
  if ($('#scrim')) closeSheet();
  state.base = r;
  renderChrome();
  await renderScreen(r);
}
async function renderScreen(r) { try { await SCREENS[r](); } catch (e) { fail(e); } }
let booted = false; // a hash change during boot is picked up by boot's own render()
addEventListener('hashchange', () => { if (!booted) return; render(); $('#main').focus({ preventScroll: true }); });
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && signedIn()) { try { await syncListings(); renderChrome(); if (['review', 'shortlist', 'passed'].includes(route())) render(); } catch { /* offline */ } } });

// ---------- boot ----------
(async function boot() {
  applyTheme();
  await loadMe();
  const [h] = await Promise.all([fetch('/healthz').then(r => r.json()).catch(() => null), loadAreas()]);
  state.lastIngestMin = h?.lastIngestAgeMin ?? null;
  if (signedIn()) { try { await syncListings({ full: true }); } catch (e) { fail(e); } registerServiceWorker(); }
  booted = true;
  if (state.me.role === 'pending') toast('Your account is waiting for an admin to approve it. You can browse listings meanwhile.', { ms: 8000 });
  await render();
})();
