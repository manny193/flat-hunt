// Area alerts in the browser (docs/ai/ALERTS-WEBPUSH.md §9-10). Imported by ui.js; ui.js passes its helpers in
// (createAlertsUI(ctx)), so this module never imports ui.js back. No inline styles (CSP): classes live in app.css.

/** Register the alerts service worker (signed-in users only; it has no fetch handler and caches nothing). */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);
}

export const BELL = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
// BHK chips -> listing_match.bhk values (src/alerts.js BHK_VALUES).
const BHK_CHIPS = [['1RK', '1 RK', ['1RK']], ['1', '1', ['1', '1.5']], ['2', '2', ['2', '2.5']], ['3', '3', ['3', '3.5']], ['4', '4+', ['4', '4.5', '5', '6']]];
const TARGET_KEY = 'fh.alertTarget';
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourName = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
const store = { get() { try { return Number(localStorage.getItem(TARGET_KEY)) || null; } catch { return null; } }, set(v) { try { v ? localStorage.setItem(TARGET_KEY, String(v)) : localStorage.removeItem(TARGET_KEY); } catch { /* private mode */ } } };

// ---------- device detection ----------
export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function iosVersion() {
  const m = navigator.userAgent.match(/OS (\d+)[_.](\d+)/) || navigator.userAgent.match(/Version\/(\d+)\.(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const coarseLabel = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : isIos() ? (/iPad/.test(ua) || navigator.maxTouchPoints > 1 && !/iPhone/.test(ua) ? 'iPad' : 'iPhone') : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return standalone() ? `${os} · app` : `${os} · ${br}`;
};
const fromB64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Extra line for the sign-in sheet inside the iOS Home Screen app (Google sign-in there is unverified). */
export function iosSigninNote(esc) {
  if (!isIos() || !standalone()) return '';
  return `<p class="help alert-note">${esc('On iPhone, Google sign-in inside the Home Screen app can open Safari instead. If you end up signed in in Safari but not here, close Safari and try once more from the Home Screen app. If it still does not work, alerts cannot be set up on this iPhone yet: please tell us.')}</p>`;
}

/**
 * ctx: { api, esc, toast, fail, openSheet, closeSheet, cardHtml, isAdmin }.
 * Returns the pieces ui.js mounts: account panel, area bells, #alerts screen, sign-out hook, admin page.
 */
export function createAlertsUI(ctx) {
  const { api, esc, toast, fail, openSheet, closeSheet } = ctx;
  let cfg = null;
  const load = async (force = false) => { if (!cfg || force) cfg = await api('GET', '/api/alerts/config').catch(() => null); return cfg; };

  /** 'unsupported' | 'ios_old' | 'needs_install' | 'blocked' | 'on' | 'off' */
  async function deviceState() {
    if (isIos() && !standalone()) { const v = iosVersion(); return v != null && v < 16.4 ? 'ios_old' : 'needs_install'; }
    if (!pushSupported()) return isIos() ? 'ios_old' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    const sub = await currentSubscription().catch(() => null);
    const mine = store.get();
    return sub && mine && (cfg?.targets || []).some(t => t.id === mine) ? 'on' : 'off';
  }

  async function turnOn() {
    // The permission prompt must come straight from the tap (iOS shows it only then, and only once).
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.', { err: true }); return false; }
    const reg = (await registerServiceWorker()) && await navigator.serviceWorker.ready;
    if (!reg) { toast('This browser can’t show alerts.', { err: true }); return false; }
    const key = fromB64u(cfg.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    try { if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); }
    catch { await sub?.unsubscribe().catch(() => {}); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }); } // server key changed
    const { id } = await api('POST', '/api/alerts/targets', { channel: 'webpush', subscription: sub.toJSON(), label: coarseLabel() });
    store.set(id);
    if (cfg.prefs && !cfg.prefs.enabled && cfg.areas.length) await api('PUT', '/api/alerts/prefs', { enabled: true });
    return true;
  }
  async function turnOffHere() {
    const sub = await currentSubscription().catch(() => null);
    await sub?.unsubscribe().catch(() => {});
    const id = store.get(); store.set(null);
    if (id) await api('DELETE', `/api/alerts/targets/${id}`).catch(() => {});
  }
  /** Sign-out on a shared device: forget this device before the session goes. Never throws. */
  async function beforeSignOut() { try { await turnOffHere(); } catch { /* signing out anyway */ } }

  // ---------- account panel ----------
  const installCard = () => `<ol class="install-steps"><li>Tap the Share button, then <b>Add to Home Screen</b>.</li><li>Open <b>Flat Hunt</b> from your Home Screen.</li><li>Sign in again there, then tap <b>Turn on alerts</b>.</li></ol>
    <p class="help">iPhone shows alerts only for apps on the Home Screen (iOS 16.4 or later). The Home Screen app keeps its own sign-in, separate from Safari.</p>`;
  function deviceHtml(st) {
    if (st === 'needs_install') return `<p><b>Get alerts on this iPhone</b></p>${installCard()}`;
    if (st === 'ios_old') return '<p class="help">Alerts need iOS 16.4 or later.</p>';
    if (st === 'unsupported') return '<p class="help">This browser can’t show alerts. Try Chrome, Edge, Firefox or Safari.</p>';
    if (st === 'blocked') return '<p class="help">Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.</p><button class="btn sm" type="button" data-al="on">Try again</button>';
    if (st === 'on') return '<p><span class="chip keep">On</span> Alerts on for this device.</p><div class="field-row"><button class="btn sm" type="button" data-al="test">Send a test</button><button class="btn sm quiet" type="button" data-al="off">Turn off on this device</button></div>';
    return '<p class="help">Get a notification when a new flat is posted in your areas.</p><button class="btn sm primary" type="button" data-al="on">' + BELL + 'Turn on alerts</button>';
  }
  const hourSel = (id, v, label) => `<select class="input al-hour" id="${id}" aria-label="${esc(label)}">${HOURS.map(h => `<option value="${h}"${h === v ? ' selected' : ''}>${hourName(h)}</option>`).join('')}</select>`;
  const numSel = (id, v, opts, label) => `<select class="input al-num" id="${id}" aria-label="${esc(label)}">${opts.map(n => `<option value="${n}"${n === v ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  async function mountAccount(el) {
    if (!el) return;
    await load(true);
    if (!cfg?.enabled) { el.innerHTML = ''; return; } // switched off, not configured, or admins-only for now: no UI
    const st = await deviceState();
    const p = cfg.prefs; const L = cfg.limits;
    const listingOpts = [5, 10, 20, 30, 50].filter(n => n <= L.maxListings); if (!listingOpts.includes(p.maxListings)) listingOpts.push(p.maxListings);
    const digestOpts = Array.from({ length: Math.max(L.maxDigests, p.maxDigests) }, (_, i) => i + 1);
    el.innerHTML = `<div class="panel" id="alerts"><div class="phead"><h2>Alerts</h2><span class="sp"></span><a class="btn sm quiet" href="#alerts">Latest alerts</a></div>
      ${deviceHtml(st)}
      <h3 class="stage-h">Areas</h3><p class="help">${cfg.areas.length ? 'Alerts for ' + esc(cfg.areas.map(a => a.name).join(', ')) + '.' : 'No areas yet. Tap the bell next to an area.'}</p><a class="btn sm" href="#areas">${BELL}Choose alert areas</a>
      <h3 class="stage-h">Quiet hours (IST)</h3><div class="field-row al-row"><span>From</span>${hourSel('al-qs', p.quietStart, 'Quiet hours start')}<span>until</span>${hourSel('al-qe', p.quietEnd, 'Quiet hours end')}</div>
      <h3 class="stage-h">Daily limit</h3><div class="field-row al-row"><span>At most</span>${numSel('al-ml', p.maxListings, listingOpts.sort((a, b) => a - b), 'Listings per day')}<span>flats in</span>${numSel('al-md', p.maxDigests, digestOpts, 'Alerts per day')}<span>alerts a day</span></div>
      <label class="toggle section-gap"><span>All alerts on</span><input type="checkbox" role="switch" id="al-en"${p.enabled ? ' checked' : ''}></label>
      ${cfg.targets.length ? `<h3 class="stage-h">Devices</h3><div class="pick-list">${cfg.targets.map(t => `<div class="pr"><span class="nm">${esc(t.label || 'Device')}${t.id === store.get() ? ' <span class="small">(this one)</span>' : ''}</span>${t.failing ? '<span class="chip brok">Not reachable</span>' : ''}<button class="btn sm quiet" type="button" data-rmdev="${t.id}">Remove</button></div>`).join('')}</div>` : ''}
      <p class="help">Alerts show the BHK, rent and area only. Google, Apple or Mozilla deliver them without seeing any listing.</p></div>`;
    el.onclick = async e => {
      const act = e.target.closest('[data-al]')?.dataset.al; const rm = e.target.closest('[data-rmdev]');
      try {
        if (act === 'on') { if (await turnOn()) { toast(cfg.areas.length ? 'Alerts on for this device' : 'Alerts on. Now pick your alert areas.'); } }
        if (act === 'off') { await turnOffHere(); toast('Alerts off on this device'); }
        if (act === 'test') { const r = await api('POST', '/api/alerts/test'); toast(r.sent ? 'Test sent. It should arrive in a few seconds.' : 'The test could not be delivered.', { err: !r.sent }); }
        if (rm) { await api('DELETE', `/api/alerts/targets/${rm.dataset.rmdev}`); if (Number(rm.dataset.rmdev) === store.get()) await turnOffHere(); toast('Device removed'); }
        if (act || rm) mountAccount(el);
      } catch (err) { fail(err); }
    };
    el.onchange = async e => {
      const body = {};
      if (e.target.id === 'al-qs') body.quietStart = Number(e.target.value);
      if (e.target.id === 'al-qe') body.quietEnd = Number(e.target.value);
      if (e.target.id === 'al-ml') body.maxListings = Number(e.target.value);
      if (e.target.id === 'al-md') body.maxDigests = Number(e.target.value);
      if (e.target.id === 'al-en') body.enabled = e.target.checked;
      if (!Object.keys(body).length) return;
      try { cfg.prefs = (await api('PUT', '/api/alerts/prefs', body)).prefs; toast('Saved'); } catch (err) { fail(err); mountAccount(el); }
    };
  }

  // ---------- area bells (My areas screen) ----------
  async function decorateAreas(root, myAreas, rerender) {
    await load(true);
    if (!cfg?.enabled || !root) return;
    const on = new Map(cfg.areas.map(a => [a.areaId, a]));
    for (const btn of root.querySelectorAll('.achip [data-rm]')) {
      const id = Number(btn.dataset.rm); const a = myAreas.find(x => x.id === id); if (!a) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bellb'; b.dataset.bell = String(id);
      b.setAttribute('aria-pressed', String(on.has(id))); b.setAttribute('aria-label', `Alerts for ${a.name}`); b.innerHTML = BELL;
      b.addEventListener('click', ev => { ev.stopPropagation(); bellSheet(a, on.get(id) || null, rerender); });
      btn.before(b);
    }
    const help = document.createElement('p'); help.className = 'help'; help.textContent = 'Tap the bell next to an area to get alerts for new flats there.';
    root.querySelector('.area-chips')?.after(help);
  }
  function bellSheet(area, cur, rerender) {
    const picked = new Set(BHK_CHIPS.filter(([, , vals]) => cur?.bhks?.some(v => vals.includes(v))).map(([k]) => k));
    const s = openSheet(`<div class="shead"><h2>Alerts for ${esc(area.name)}</h2><button class="btn quiet sm" type="button" data-close>Close</button></div>
      <label class="toggle"><span>Alert me about new flats here</span><input type="checkbox" role="switch" id="bl-on"${cur || !cfg.areas.length ? ' checked' : ''}></label>
      <label class="lbl" for="bl-rent">Max rent (optional)</label><input class="input" id="bl-rent" inputmode="numeric" placeholder="Any rent" value="${cur?.maxRent ?? ''}">
      <span class="lbl">BHK (none selected = any)</span><div class="seg" role="group" aria-label="BHK">${BHK_CHIPS.map(([k, label]) => `<button type="button" data-bhk="${k}" aria-pressed="${picked.has(k)}">${label}</button>`).join('')}</div>
      <p class="help">Posts with no rent or BHK in them are included, so you don't miss any.</p>
      <div class="field-row section-gap"><button class="btn primary" type="button" data-save>Save</button></div>`, { label: 'Area alerts', center: true });
    s.onclick = async e => {
      if (e.target.closest('[data-close]')) { closeSheet(); return; }
      const chip = e.target.closest('[data-bhk]');
      if (chip) { const k = chip.dataset.bhk; picked.has(k) ? picked.delete(k) : picked.add(k); chip.setAttribute('aria-pressed', String(picked.has(k))); return; }
      if (!e.target.closest('[data-save]')) return;
      const enabled = s.querySelector('#bl-on').checked;
      const rentRaw = s.querySelector('#bl-rent').value.replace(/[^\d]/g, '');
      const maxRent = rentRaw ? Number(rentRaw) : null;
      const bhks = BHK_CHIPS.filter(([k]) => picked.has(k)).flatMap(([, , v]) => v);
      const others = cfg.areas.filter(a => a.areaId !== area.id).map(a => ({ areaId: a.areaId, maxRent: a.maxRent, bhks: a.bhks }));
      const areas = enabled ? [...others, { areaId: area.id, maxRent, bhks }] : others;
      try {
        cfg.areas = (await api('PUT', '/api/alerts/areas', { areas })).areas;
        closeSheet();
        const st = await deviceState();
        toast(enabled ? (st === 'on' ? `Alerts on for ${area.name}` : `Saved. Turn on alerts for this device in Me > Alerts.`) : `Alerts off for ${area.name}`);
        rerender();
      } catch (err) { fail(err); }
    };
  }

  // ---------- #alerts screen ----------
  async function renderScreen(main) {
    main.innerHTML = '<div class="wrap"><div class="screen-h"><h1>Alerts</h1></div><div class="skel"><i class="b"></i><i></i><i></i></div></div>';
    let d; try { d = await api('GET', '/api/alerts/inbox?full=1'); } catch (e) { if (e.status === 403) d = { batches: [], off: true }; else throw e; }
    const when = t => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const body = d.batches.length
      ? d.batches.map(b => `<h2 class="stage-h">${b.pushed ? `Sent ${esc(when(b.sentAt))}` : 'Not pushed (daily limit reached or no device)'}</h2><div class="grid al-grid">${b.items.map(ctx.cardHtml).join('')}</div>`).join('')
      : `<div class="empty"><div class="eboard"></div><p>${d.off ? 'Alerts are not available yet.' : 'No alerts yet. New flats in your alert areas show up here.'}</p>${d.off ? '' : '<a class="btn" href="#account">Alert settings</a>'}</div>`;
    main.innerHTML = `<div class="wrap"><div class="screen-h"><h1>Alerts</h1><span class="sub">Last 7 days</span><span class="sp"></span><a class="btn sm" href="#account">Settings</a></div>${body}</div>`;
    main.onclick = e => { const o = e.target.closest('[data-open]'); if (o && !e.target.closest('a')) location.hash = '#listing-' + o.dataset.open; };
  }

  // ---------- #admin-alerts ----------
  async function renderAdmin(main, adminHead) {
    const v = await api('GET', '/api/admin/alerts');
    const n = x => (x ?? 0).toLocaleString('en-IN');
    main.innerHTML = `<div class="wrap">${adminHead('Alerts')}
      <div class="panel"><div class="phead"><h2>Switches</h2></div>
        ${v.configured ? '' : `<p class="help warn-txt">${esc(v.configProblem || 'VAPID secrets are not set.')} Alerts stay off until this is fixed. See docs/DEPLOY.md.</p>`}
        <div><label class="toggle"><span>Alerts on</span><input type="checkbox" role="switch" id="aa-en"${v.enabled ? ' checked' : ''}></label></div>
        <div><label class="toggle"><span>Admins only (soft launch)</span><input type="checkbox" role="switch" id="aa-ao"${v.adminOnly ? ' checked' : ''}></label></div>
        <p class="help">While “Admins only” is on, only admins see alerts and receive them.</p>
        <div class="field-row"><label class="lbl" for="aa-max">Max pushes per day (all users)</label><input class="input al-num" id="aa-max" inputmode="numeric" value="${v.maxPushesPerDay}"><button class="btn sm" type="button" data-aa="save">Save</button></div>
        <h3 class="stage-h">Defaults for new users</h3>
        <p class="help">Quiet ${v.defaults.quietStart}:00 to ${v.defaults.quietEnd}:00 IST, at most ${v.defaults.maxListings} flats in ${v.defaults.maxDigests} alerts a day, ${v.defaults.minGapMin} min apart. Listings and alerts per day are also the most anyone can pick.</p>
        <button class="btn sm" type="button" data-aa="test">${BELL}Send a test to my devices</button></div>
      <div class="panel"><div class="phead"><h2>Usage</h2><span class="sub">today (IST)</span></div><div class="tscroll"><table class="tbl"><tbody>
        <tr><td>Devices</td><td class="n">${n(v.targets.webpush)}</td></tr><tr><td>Not reachable devices</td><td class="n">${n(v.failingTargets)}</td></tr>
        <tr><td>Users with alert areas</td><td class="n">${n(v.usersWithAlerts)}</td></tr><tr><td>Areas with alerts</td><td class="n">${n(v.areasWithAlerts)}</td></tr>
        <tr><td>Waiting to send</td><td class="n">${n(v.queue.pending)}</td></tr><tr><td>Listings sent today</td><td class="n">${n(v.queue.sentToday)}</td></tr>
        <tr><td>Not pushed today (limit or no device)</td><td class="n">${n(v.queue.cappedToday)}</td></tr><tr><td>Pushes today</td><td class="n">${n(v.pushesToday)} of ${n(v.maxPushesPerDay)}</td></tr>
        <tr><td>Last run</td><td class="n">${v.lastRunAt ? esc(new Date(v.lastRunAt).toLocaleString('en-IN')) : '–'}</td></tr><tr><td>Last error</td><td class="n">${esc(v.lastError || '–')}</td></tr>
      </tbody></table></div></div></div>`;
    const put = async body => { try { await api('PUT', '/api/admin/alerts', body); toast('Saved'); } catch (err) { fail(err); } renderAdmin(main, adminHead); };
    main.onchange = e => { if (e.target.id === 'aa-en') put({ enabled: e.target.checked }); if (e.target.id === 'aa-ao') put({ adminOnly: e.target.checked }); };
    main.onclick = async e => {
      const act = e.target.closest('[data-aa]')?.dataset.aa;
      if (act === 'save') put({ maxPushesPerDay: Number(main.querySelector('#aa-max').value.replace(/[^\d]/g, '')) });
      if (act === 'test') { try { const r = await api('POST', '/api/admin/alerts/test'); toast(`Test sent to ${r.sent} device${r.sent === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed` : ''}`, { err: !r.sent }); } catch (err) { fail(err); } }
    };
  }

  return { load, mountAccount, decorateAreas, renderScreen, renderAdmin, beforeSignOut };
}
