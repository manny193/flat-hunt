# Area alerts over Web Push: high-level design

Written 8 Nov 2026 by the architect against the code at that date (no commit hash: working tree). Tracking issue: manny193/flat-hunt#30. Status: **design, nothing built**. Channel research and the earlier channel-neutral sketch: `docs/ai/ALERTS.md` (this doc supersedes its §6.1 schema and §6.3 send step for Web Push). Items marked **[unverified]** were not checked against a live browser or vendor page; QA or the engineer must confirm them before rollout.

## 1. Goal and scope

**Goal.** A signed-in user (role `user` or `admin`, status `active`) turns on alerts for some of the areas they follow. When ingest stores a **new** listing in one of those areas, they get a browser or installed-PWA notification within about 10 minutes, batched into one digest per user per send, never during their quiet hours, and never more than a daily cap. Tapping it opens the listing (one item) or the alerts screen (several). Cost: $0.

**In scope (v1)**
- Web Push via VAPID to Chrome/Edge/Firefox (desktop and Android) and Safari (macOS 16+, iOS/iPadOS 16.4+ when installed to the Home Screen).
- Per-area opt-in, with two cheap optional filters per area: max rent and BHK set. Offers only (not "looking for" posts).
- Digest per send, per-user daily cap, minimum gap between digests, quiet hours in IST.
- A pluggable channel layer (`alert_targets.channel`), so Telegram can be added later without a new queue.
- Admin counts, kill switch, and a test send to the admin's own devices.

**Out of scope (v1)**
- Telegram, WhatsApp, email (later adapters on the same tables; see `docs/ai/ALERTS.md`).
- Encrypted payloads (RFC 8291). We send **payload-less** pushes (§8). The RFC 8291 design is kept in §8.4 for a later channel that needs it.
- Alerts for reposts merged into an old listing, area backfill results, sample/imported rows, rent drops, "seeking" posts.
- Offline caching of the app in the service worker (the new service worker has no `fetch` handler).
- Per-user quiet-hour time zones other than IST.

## 2. User flows

**Enable (Android Chrome, desktop browsers, macOS Safari)**
1. Signed-in user opens **Areas** (or the new **Alerts** section on `#account`, see §10) and taps "Turn on alerts".
2. UI checks support (`'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window`) and that `GET /api/alerts/config` says `enabled: true`.
3. Inside that tap handler: `Notification.requestPermission()`. Denied → show "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." and stop.
4. `navigator.serviceWorker.register('/sw.js')` (already registered on app start for signed-in users; see §9), then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <vapidPublicKey bytes> })`.
5. `POST /api/alerts/targets` with the subscription JSON. Server stores it. UI shows "Alerts on for this device" and a "Send a test" button.

**Pick areas**
- On the Areas screen each followed area gets a bell toggle. Toggling on opens a small sheet: "Max rent" (optional number) and BHK chips (1RK, 1, 2, 3, 4+; none selected = any). Save → `PUT /api/alerts/areas` with the full set.
- Only areas the user follows (`user_areas`) can have alerts. Unfollowing an area removes its alert row in the same request.
- Cap: 10 alert areas per user.
- Quiet hours (default 22:00 to 08:00 IST) and the daily cap (default 30 listings, max 6 digests) are on the same screen: `PUT /api/alerts/prefs`.

**Receive**
- Ingest stores a new listing in Green Glen Layout. Within 10 minutes the alert cron sends a push with **no payload** to each of the user's devices.
- The service worker wakes, calls `GET /api/alerts/inbox` with the session cookie, and shows the notification text the server built, for example:
  - Title: `3 new flats in your areas`
  - Body: `2 BHK · ₹28,000 · Green Glen Layout` / `1 BHK · ₹16,500 · HSR Layout` / `+1 more`
- If the fetch fails (offline, session expired, signed out): a generic notification, `New flats in your areas. Open Flat Hunt to see them.` with no listing details.

**Tap → listing**
- One item: opens or focuses the app at `/#listing-<id>` (existing detail sheet, full fields for signed-in users).
- Several: opens `/#alerts`, a list of the latest alert batch (cards rendered by the existing list code from `GET /api/alerts/inbox?full=1`).

**Unsubscribe**
- Per area: bell toggle off.
- Per device: "Turn off alerts on this device" → `subscription.unsubscribe()` then `DELETE /api/alerts/targets/:id`.
- All: "Pause all alerts" (`prefs.enabled = 0`).
- Sign out: the UI deletes this device's target before calling `/api/logout` (shared-device privacy).
- Browser-level revoke (user blocks notifications in settings): the push service starts answering 404/410; the cron deletes the target.
- Admin blocks a user: role/status are re-checked at send time and in the inbox, so nothing is sent or shown from the next run.

**iOS / iPadOS install (16.4+)**
- On iOS, `PushManager` exists only inside a web app opened from the Home Screen. In Safari the "Turn on alerts" button shows an install card instead:
  1. "Tap the Share button, then **Add to Home Screen**."
  2. "Open **Flat Hunt** from your Home Screen."
  3. "Sign in again there, then tap Turn on alerts."
- Detect with `navigator.standalone === true || matchMedia('(display-mode: standalone)').matches`; detect iOS by `/iPad|iPhone|iPod/` or `navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1`.
- The permission prompt must come from a tap (we already do that). iOS shows the prompt once; if denied the user must re-enable in Settings > Notifications > Flat Hunt.
- The Home Screen app has its own cookie jar, separate from Safari, so the user signs in again inside it. **[unverified: Google OIDC redirect inside an iOS standalone web app may bounce to Safari and lose the session; QA must test on a real iPhone. If it fails, see open question Q2.]**
- iOS below 16.4: show "Alerts need iOS 16.4 or later."

## 3. Components and data flow

```
ingest (webhook / sweep / Reddit)                         browser / PWA
  ingestItems() ── saveIngest() batch                       ┌──────────────────────────┐
     + 1 stmt: INSERT OR IGNORE INTO alert_queue ...        │ ui.js: Alerts UI         │
       (new listings x alert_areas filters)                 │  subscribe ─POST targets─┼──► /api/alerts/*
                │                                           │ sw.js                    │
                ▼                                           │  push → GET inbox ───────┼──► /api/alerts/inbox
          alert_queue (pending)                             │  showNotification        │      (session cookie,
                │                                           │  click → /#listing-<id>  │       role re-check)
   cron */10 (alerts only) ── alertStep()                   └──────────▲───────────────┘
     1 read: due users (+prefs, role, caps)                            │
     1 read: their targets                                             │
     N fetch: POST <endpoint>  (empty body, VAPID JWT) ──► push service (FCM / Mozilla / Apple / WNS)
     1 batch: mark sent, delete 404/410, count failures
```

New code:
- `src/alerts.js`: queue SQL builder for ingest, `alertStep()`, digest text builder, quiet-hour and cap logic, user API handler.
- `src/channels/webpush.js`: VAPID key import, JWT signing, `send(target, ctx)` returning `{ok, gone, retry, error}`. `src/channels/index.js`: `{ webpush }` map, the plug-in point for `telegram` later. Each channel exports `{ name, send(target, digest, ctx), validateTarget(input) }`; web push ignores `digest` because it is payload-less.
- `web/sw.js`: service worker (push, notificationclick, pushsubscriptionchange).
- `web/ui.js`: Alerts UI, `#alerts` route, iOS install card.
- `migrations/0004_alerts.sql`.

## 4. Data model (`migrations/0004_alerts.sql`, add-only)

Times are epoch ms (INTEGER) and `users.id` is INTEGER, matching 0001 to 0003. No `BEGIN/COMMIT`, no virtual tables. Old code ignores these tables, so a code rollback is safe.

```sql
-- Flat Hunt 0004: area alerts (docs/ai/ALERTS-WEBPUSH.md). Add-only.

-- Where a user can be reached. One row per device (web push) or chat (telegram, later).
-- address = push endpoint URL (web push) | chat id (telegram). Treat as personal data: never log it.
CREATE TABLE IF NOT EXISTS alert_targets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  channel     TEXT    NOT NULL,                 -- 'webpush' (v1) | 'telegram' (later)
  address     TEXT    NOT NULL,
  keys        TEXT    NOT NULL DEFAULT '{}',    -- web push {p256dh, auth}; stored for a future encrypted payload, unused in v1
  label       TEXT    NOT NULL DEFAULT '',      -- coarse device label from the client, e.g. 'Android · Chrome' (no full UA)
  failures    INTEGER NOT NULL DEFAULT 0,
  last_ok_at  INTEGER,
  last_error  TEXT,                             -- short code, e.g. 'http_403', never the endpoint
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (channel, address)
);
CREATE INDEX IF NOT EXISTS alert_targets_user ON alert_targets (user_id);

-- Per-user alert settings. No row = alerts off.
CREATE TABLE IF NOT EXISTS alert_prefs (
  user_id        INTEGER PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 1,
  quiet_start    INTEGER NOT NULL DEFAULT 22,   -- IST hour 0-23; quiet from quiet_start to quiet_end
  quiet_end      INTEGER NOT NULL DEFAULT 8,    -- equal start and end = no quiet hours
  max_listings   INTEGER NOT NULL DEFAULT 30,   -- listings per IST day (1-50)
  max_digests    INTEGER NOT NULL DEFAULT 6,    -- digests per IST day (1-12)
  min_gap_min    INTEGER NOT NULL DEFAULT 60,   -- minutes between digests (30-720)
  test_at        INTEGER,                       -- last test send (inbox shows the test text for 10 min)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Which followed areas alert, with optional cheap filters (matched against listing_match columns).
CREATE TABLE IF NOT EXISTS alert_areas (
  user_id    INTEGER NOT NULL,
  area_id    INTEGER NOT NULL,
  max_rent   INTEGER,                           -- NULL = any; listings with unknown rent are included
  bhks       TEXT    NOT NULL DEFAULT '',       -- '' = any, else ',1,2,1RK,' (bhkKey values, comma-wrapped)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, area_id)
);
CREATE INDEX IF NOT EXISTS alert_areas_area ON alert_areas (area_id);

-- Queue and dedupe log in one: one row per (user, listing). sent_at doubles as the batch id.
CREATE TABLE IF NOT EXISTS alert_queue (
  user_id    INTEGER NOT NULL,
  listing_id TEXT    NOT NULL,
  area_id    INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending', -- pending | sent | capped | expired
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX IF NOT EXISTS alert_queue_pending ON alert_queue (status, user_id, created_at);
CREATE INDEX IF NOT EXISTS alert_queue_user_sent ON alert_queue (user_id, sent_at DESC);
```

Notes:
- PK `(user_id, listing_id)` dedupes a listing that matches two of the user's areas, and repeated ingest of the same listing.
- `capped` rows (over the daily cap) still show on `#alerts`; they just are not pushed.
- Daily counts are derived, not stored: `COUNT(*) ... status='sent' AND sent_at >= <IST midnight>` and `COUNT(DISTINCT sent_at)` for digests. No counter rows to keep in sync.
- Global switches live in `settings.alerts` (JSON): `{ webpush: true, maxPushesPerDay: 2000, day, pushesToday, lastRunAt, lastError }`.
- Retention: the daily purge deletes `alert_queue` rows with `created_at < now − 7 days` (1 statement) and `alert_targets` with `failures >= 5 AND updated_at < now − 7 days`.

## 5. Ingest hook (enqueue)

`ingestItems()` already ends in one `saveIngest()` batch that rewrites `listing_match` for every changed listing. `saveIngest` takes `extra` statements that run after `INSERT_MATCH` inside the same batch. Append **one** statement when the source is a live one (`apify`, `reddit`, `phone`; not `sample`, `manual`, `scraper` import) and there are new, non-sample listings:

```sql
INSERT OR IGNORE INTO alert_queue (user_id, listing_id, area_id, status, created_at)
SELECT a.user_id, m.listing_id, MIN(m.area_id), 'pending', :now
FROM listing_match m
JOIN alert_areas a ON a.area_id = m.area_id
WHERE m.listing_id IN (SELECT value FROM json_each(:newIds))
  AND m.area_id != 0
  AND m.kind = 'offer'
  AND m.last_posted_at >= :now - 86400000            -- only posts from the last 24 h (datasets carry a 3-day backfill)
  AND (a.max_rent IS NULL OR m.rent IS NULL OR m.rent <= a.max_rent)
  AND (a.bhks = '' OR m.bhk IS NULL OR instr(a.bhks, ',' || m.bhk || ',') > 0)
GROUP BY a.user_id, m.listing_id;
```

- `:newIds` = ids in `local` (brand-new listings this call), minus `isSample`. Merged reposts are excluded by construction.
- Cost: +1 D1 statement per ingest call (inside the existing batch; the 48 budget has room, the ingest page uses about 4 to 6). Rows written = matching (listing, user) pairs: 1,000 users × 3 matches/day ≈ 3,000 rows/day, under 3% of the 100k/day write limit.
- Role is not checked here (cheap enqueue); it is checked at send and in the inbox.
- `bhk` in `listing_match` is `bhkKey(l.bhk)`; the engineer confirms the values (`'1'`, `'2'`, `'1RK'`, ...) and builds `bhks` from the same function.

## 6. API endpoints

All under `/api/alerts/*`, handled by `alertsApi()` in `src/alerts.js`, routed from `api()` in `src/app.js`. The existing gate already gives 401 to the public and 403 `pending_approval` to pending users, and runs `checkOrigin()` on every non-GET. Every handler also returns 403 `alerts_off` when `settings.alerts.webpush === false` (except `DELETE`, which always works). Bodies ≤ 4 KB (`readJson(request, 4 * KB)`).

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/alerts/config` | – | `{ enabled, vapidPublicKey, prefs, areas: [{areaId, name, maxRent, bhks}], targets: [{id, channel, label, createdAt, lastOkAt, failing}] }`. Never returns `address` or `keys`. |
| PUT | `/api/alerts/prefs` | `{ enabled?, quietStart?, quietEnd?, maxListings?, maxDigests?, minGapMin? }` | `{ prefs }`. Validated ranges as in §4; upsert. |
| PUT | `/api/alerts/areas` | `{ areas: [{ areaId, maxRent?, bhks?: ['1','2','1RK'] }] }` (full replacement, ≤ 10) | `{ areas }`. 400 `not_followed` if an area is not in the user's `user_areas`. 1 delete + 1 insert. Creates `alert_prefs` with defaults if missing. |
| POST | `/api/alerts/targets` | `{ channel: 'webpush', subscription: { endpoint, keys: { p256dh, auth } }, label? }` | 201 `{ id }`. Validation below. Upsert on `(channel, address)`: an endpoint already stored for another user is moved to this user (the device changed account). |
| DELETE | `/api/alerts/targets/:id` | – | 204. Own targets only (`WHERE id = ? AND user_id = ?`). |
| GET | `/api/alerts/inbox` | `?full=1` optional | Default (service worker): `{ notification: { title, body, url, tag }, count }`. `full=1` (Alerts screen): `{ batches: [{ sentAt, items: [serializeListing(l, role)] }] }`, last 20 items. |
| POST | `/api/alerts/test` | – | 202 `{ sent, failed }`. Sends one payload-less push to the caller's own targets and sets `prefs.test_at`; the inbox then answers with the test text for 10 minutes. Limit 3 per hour per user (`rate_limits` key `alert-test:<userId>`). |

**Target validation (SSRF guard).** The cron POSTs to whatever endpoint we store, so the endpoint must be `https:`, no port or port 443, no credentials, length ≤ 1,024, and the host must match an allowlist:
`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com` (Safari uses `web.push.apple.com`), `*.notify.windows.com` (Edge on Windows). `p256dh` must decode to 65 bytes starting `0x04`, `auth` to 16 bytes (kept for later encryption, and a cheap sanity check). Max 5 targets per user; the oldest is replaced when a 6th arrives. **[unverified: confirm the current endpoint hosts from a real subscription on each browser during QA; add any new host to the list.]**

**Inbox text rules.** Built by `alertText(items, areaNames)` from an allowlist only: `bhk`/`type` (e.g. `2 BHK`, `Room`, `PG`), `rent` (formatted `₹28,000`), area name, and optional age (`2 h ago`). Never post text, phones, emails, links, author, society or group names. At most 3 lines plus `+N more`. `url` is `/#listing-<id>` for one item, `/#alerts` for more; `tag` is `flat-hunt-alerts` so a newer notification replaces the older one. Every field in this text is already visible to the public on `#browse`, so a lock-screen preview leaks nothing beyond public data.

Inbox selection: the user's rows with the latest `sent_at` (one batch), joined to `listings` for the fields above (2 queries plus the session lookup). If `test_at` is within 10 minutes and newer than the latest batch, return `{ title: 'Flat Hunt test', body: 'Alerts work on this device.', url: '/#alerts' }`. If nothing was sent in the last 24 h, return the generic text (a push must always show something).

**Admin** (in `adminApi()`, admin only):

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/admin/alerts` | – | `{ enabled, targets: {webpush: n}, usersWithAlerts, areasWithAlerts, queue: {pending, sentToday, cappedToday, expiredToday}, pushesToday, failingTargets, lastRunAt, lastError }`. Counts only, no endpoints, no per-user rows. |
| PUT | `/api/admin/alerts` | `{ webpush?: bool, maxPushesPerDay?: 100-10000 }` | `{ ...view }`. Writes `settings.alerts`. |
| POST | `/api/admin/alerts/test` | – | Same as the user test, to the admin's own devices only. Admins cannot push to other users. |

`/api/export` must not include `alert_targets.address` or `keys`.

## 7. Cron send step

### 7.1 Where it runs

Add a second Cron Trigger, `*/10 * * * *`, next to the existing `30 * * * *` (Free plan allows 5 per account; the comment in `wrangler.jsonc` says so). `app.scheduled(event, env)` dispatches on `event.cron`: the `*/10` invocation runs **only** `alertStep()`, so it starts with the full 48-query and 50-subrequest budget. The hourly job is unchanged. In Node (`src/node-server.js`) the in-process timer calls `alertStep()` after `scheduledJob()` so local dev works with one timer.

Why a separate trigger, not the hourly cron or `ctx.waitUntil` after a webhook: those invocations already spend D1 queries and subrequests on Apify, Reddit and AI, which would leave only a handful of sends; a dedicated invocation is simple to reason about and bounds latency at 10 minutes. 144 extra invocations a day are free; an idle run is 1 D1 query.

### 7.2 Steps (`alertStep(repo, env, { fetchFn, now, maxSends = 40 })`)

`repo` is `budgeted(baseRepo, 48)`. A `countedFetch(fetchFn)` wrapper counts subrequests the same way `budgeted()` counts queries.

0. Return `{action:'off'}` if `VAPID_*` secrets are missing or `settings.alerts.webpush === false`. Settings read: 1 query.
1. **Due users** (1 query): users with pending rows, active role, prefs enabled, plus their caps and today's counts:
   ```sql
   SELECT q.user_id, COUNT(*) AS pending, MIN(q.created_at) AS oldest,
          p.quiet_start, p.quiet_end, p.max_listings, p.max_digests, p.min_gap_min,
          (SELECT COUNT(*) FROM alert_queue s WHERE s.user_id = q.user_id AND s.status = 'sent' AND s.sent_at >= :dayStart) AS sent_today,
          (SELECT COUNT(DISTINCT sent_at) FROM alert_queue s WHERE s.user_id = q.user_id AND s.status = 'sent' AND s.sent_at >= :dayStart) AS digests_today,
          (SELECT MAX(sent_at) FROM alert_queue s WHERE s.user_id = q.user_id AND s.status = 'sent') AS last_sent
   FROM alert_queue q
   JOIN alert_prefs p ON p.user_id = q.user_id AND p.enabled = 1
   JOIN users u ON u.id = q.user_id AND u.status = 'active'
   WHERE q.status = 'pending'
   GROUP BY q.user_id ORDER BY oldest LIMIT 60;
   ```
   In JS drop users in quiet hours (IST hour = `floor(((now + 19800000) % 86400000) / 3600000)`, window wraps midnight), users whose `last_sent` is within `min_gap_min`, and users at `max_digests`. Users at `max_listings` get their pending rows set to `capped` (step 4). Admin role from `ADMIN_EMAILS` is irrelevant here: any active user may receive.
2. **Targets** (1 query): `SELECT id, user_id, channel, address FROM alert_targets WHERE user_id IN (...) AND failures < 5 ORDER BY user_id, id`. Take users in order until their target count would pass `maxSends` (and the remaining subrequest budget). Users left over wait for the next run (10 minutes).
3. **Send**: per target, `channels[t.channel].send(t, null, ctx)`. Web push: one `POST` per target (§8). Sends run with `Promise.all` in groups of 6 (Workers allow 6 simultaneous open connections). Stop early on the global `maxPushesPerDay`.
4. **Write back** (1 batch, at most 6 statements):
   - `UPDATE alert_queue SET status='sent', sent_at=:now WHERE status='pending' AND user_id IN (<users with ≥1 accepted push>) AND created_at <= :now`
   - `UPDATE alert_queue SET status='capped' WHERE status='pending' AND user_id IN (<users at cap>)`
   - `UPDATE alert_queue SET status='expired' WHERE status='pending' AND created_at < :now - 129600000` (36 h: covers a night of quiet hours plus a day of failures)
   - `DELETE FROM alert_targets WHERE id IN (<404/410 targets>)`
   - `UPDATE alert_targets SET failures = failures + 1, last_error = ?, updated_at = :now WHERE id IN (<failed>)` (one statement per distinct error code, usually 0 or 1)
   - `UPDATE alert_targets SET failures = 0, last_ok_at = :now WHERE id IN (<ok>)`
   Then `putSettings({ alerts: {..., lastRunAt, pushesToday, lastError} })`: 1 statement.

Users whose pushes all failed with a retryable error keep `pending` rows and are retried next run.

### 7.3 Budget math

| Resource | Per alert invocation | Limit | Notes |
|---|---|---|---|
| D1 queries | 1 settings + 1 due users + 1 targets + ≤ 6 batch + 1 settings write = **≤ 10**, constant | 48 (of 50) | Independent of the number of users. Idle run (no pending rows): **2** (settings + due query). |
| Subrequests | **1 per target** (no payload, no fetch of keys) | 50 | Cap `maxSends = 40`, leaving 10 spare. D1 binding calls are assumed **not** to count as subrequests **[unverified; if they do, lower to 35]**. |
| Max sends per invocation | **40 targets** ≈ 30 users at 1.3 devices each | | |
| Throughput | 6 runs/hour × 40 = **240 pushes/hour** | | Enough for ~1,000 alert users if their alerts spread over a few hours; a backlog drains in order, oldest first. |
| CPU | VAPID JWT: ≤ 4 ES256 signatures per run (one per push-service origin, cached for the invocation). Per send: header building, under 0.05 ms. Est. **< 3 ms** for 40 sends | 10 ms | Native WebCrypto; to be measured by the CPU test in §13. |
| D1 rows read | Due query reads pending rows via `alert_queue_pending` plus each due user's sent rows today; idle run ≈ 1 index probe | 5M/day | 144 runs/day × a few hundred rows ≪ 5M. |
| D1 rows written | sent/capped updates = rows queued (≈ 3,000/day at 1,000 users) + a few target updates | 100k/day | |
| Inbox requests | 1 Worker request + ~3 D1 queries per push received | 100k req/day | 240 pushes/hour max ≈ 5,800/day. |

Hourly cron is unaffected: the alert step does not run there. The ingest webhook gains 1 statement.

## 8. Crypto design

### 8.1 Decision: payload-less push, service worker fetches the text

| | Payload-less (chosen) | Encrypted payload (RFC 8291) |
|---|---|---|
| CPU per send | ~0 (no per-subscription crypto); ≤ 4 JWT signs per run | ECDH key generation + ECDH derive + 2 HKDF + AES-128-GCM per subscription, est. 0.3 to 1 ms each **[estimate]**; 40 sends could pass 10 ms |
| Subrequests per send | 1 | 1 |
| What push services see | Endpoint, time, an empty message | Endpoint, time, ciphertext size |
| Privacy at receive | Text fetched only with a valid session; signed-out device gets generic text | Text arrives even if the device has since signed out |
| Extra load | 1 Worker request + ~3 D1 queries per push | none |
| Works offline at receive | No (generic text) | Yes |
| Code size / risk | Small: VAPID JWT only | Larger: RFC 8291 + RFC 8188 framing, test vectors |

Payload-less wins on the 10 ms CPU budget (the deciding factor), privacy (nothing about listings ever passes through Google, Mozilla or Apple, and the session is re-checked at display time) and simplicity. The cost, one extra request per notification, is far inside the free request and D1 limits. Offline-at-receive is an acceptable loss for flat hunting: the user taps through to the app anyway, which needs the network.

Risk: Safari and Chrome require every push to show a notification (`userVisibleOnly: true`); Safari may revoke a subscription that receives pushes without showing one **[unverified exact policy]**. The service worker therefore always shows something, falling back to the generic text. Empty-payload pushes on Apple's service **[unverified; test on a real iPhone in QA round 1]**; if Apple rejects them, fall back to the §8.4 encrypted path for Apple endpoints only.

### 8.2 VAPID (RFC 8292) with WebCrypto, no npm

Secrets: `VAPID_PUBLIC_KEY` (base64url, 65-byte uncompressed P-256 point), `VAPID_PRIVATE_KEY` (base64url, 32-byte scalar `d`), `VAPID_SUBJECT` (`mailto:` alias or `https://<PUBLIC_BASE_URL>`).

- Import once per invocation: build a JWK `{ kty:'EC', crv:'P-256', x: b64u(pub[1..33]), y: b64u(pub[33..65]), d }` and `crypto.subtle.importKey('jwk', jwk, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign'])`. Works the same in Workers and Node 22.
- JWT header `{"typ":"JWT","alg":"ES256"}`, claims `{ aud: new URL(endpoint).origin, exp: floor(now/1000) + 3600, sub: VAPID_SUBJECT }`. 1 hour expiry is under every service's maximum (24 h; Apple is stricter **[unverified]**) and costs nothing because the token is cached only for the invocation.
- `crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, data)` returns the raw 64-byte `r||s` form, which is exactly the JWS ES256 signature. No DER conversion needed.
- Cache: `Map<audience, header>` for the invocation.

### 8.3 Push request

```
POST <endpoint>
Authorization: vapid t=<jwt>, k=<VAPID_PUBLIC_KEY>
TTL: 21600            -- 6 h: if the device is off longer, the app still shows the alerts
Urgency: normal
Topic: flat-hunt-alerts   -- push service keeps only the newest undelivered one per subscription [unverified: FCM support]
Content-Length: 0
```

Responses: 201/202/200 ok; 404/410 gone; 429 retry (honour `Retry-After`, stop sending to that origin for this run); 400/401/403 = bad JWT or a key mismatch (count as failure, record `last_error`, surface in admin; after 5 failures the target is skipped and later purged); 413 cannot happen (no body); 5xx and network errors = retryable failure.

### 8.4 Deferred: encrypted payload (RFC 8291, aes128gcm) with WebCrypto

Kept for a later need (for example if Apple refuses empty pushes). Per subscription: generate an ephemeral P-256 key (`generateKey` ECDH), `deriveBits` with the client `p256dh` → ECDH secret; `HKDF(salt=auth, IKM=secret, info="WebPush: info\0"||ua_public||as_public, 32)` → IKM; random 16-byte salt; `HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)` → CEK and `HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)` → nonce; plaintext `||0x02` padding delimiter; `AES-GCM` encrypt; body = `salt(16) || rs(4, 4096) || idlen(1)=65 || as_public(65) || ciphertext`; header `Content-Encoding: aes128gcm`. All primitives exist in WebCrypto (`ECDH`, `HKDF`, `AES-GCM`). Must be tested against the RFC 8291 Appendix A vector. Would need a per-send CPU measurement and probably `maxSends` of about 10 per invocation.

## 9. Service worker and client changes

There is **no service worker today**. Add `web/sw.js`:

```js
// No 'fetch' handler: we do not cache the app or data (shared devices, auth).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const GENERIC = { title: 'Flat Hunt', body: 'New flats in your areas. Open Flat Hunt to see them.', url: '/#alerts', tag: 'flat-hunt-alerts' };
self.addEventListener('push', e => e.waitUntil((async () => {
  let n = GENERIC;
  try {
    const r = await fetch('/api/alerts/inbox', { credentials: 'same-origin', cache: 'no-store' });
    if (r.ok) { const d = await r.json(); if (d.notification) n = d.notification; }
  } catch { /* offline: generic */ }
  const url = typeof n.url === 'string' && n.url.startsWith('/#') ? n.url : '/#alerts';
  return self.registration.showNotification(n.title, { body: n.body, tag: n.tag || GENERIC.tag, renotify: true, icon: '/icon-192.png', data: { url } });
})()));

self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil((async () => {
  const url = e.notification.data?.url || '/#alerts';
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
  return self.clients.openWindow(url);
})()); });

// Browser rotated the subscription: re-subscribe and tell the server (cookie rides along).
self.addEventListener('pushsubscriptionchange', e => e.waitUntil(/* subscribe with the stored applicationServerKey, POST /api/alerts/targets */));
```

(Sketch for the engineer; final code may differ.) Points to get right:
- Serve `/sw.js` from the root so its scope is `/`. Add `/sw.js` to `PUBLIC_ASSETS` in `src/app.js` (it holds no data, and the browser's update check must not hit the 401 gate). Respond with `Cache-Control: no-cache` so updates roll out.
- Register it in `ui.js` only for signed-in users (`navigator.serviceWorker.register('/sw.js', { scope: '/' })`) and keep the VAPID public key in the page (from `/api/alerts/config`). `pushsubscriptionchange` needs the key: store it in IndexedDB or read `event.oldSubscription.options.applicationServerKey` **[unverified across browsers]**.
- The session cookie is `SameSite=Lax`, which a same-origin fetch from the service worker sends. `checkOrigin()` must accept the `POST` from `pushsubscriptionchange` (`Sec-Fetch-Site: same-origin`) **[unverified on Safari]**.
- `w.navigate()` needs the window to be controlled by this worker; fall back to `openWindow` if it throws.

**CSP impact: none.** The service worker is same-origin (`script-src 'self'` covers it; `worker-src` falls back to `script-src`), its fetch is same-origin (`connect-src 'self'`), and `pushManager.subscribe()` is not governed by CSP. `secure()` adds the same headers to `/sw.js`. Keep `Permissions-Policy` as is (it does not list notifications or push).

## 10. UI (designer specs the details)

- **Areas screen:** bell toggle per followed area; filter sheet (max rent, BHK chips).
- **Account screen, "Alerts" section:** state of this device (on / off / blocked / unsupported / needs install), "Turn on alerts", "Send a test", quiet hours (two hour pickers, IST), daily cap, list of devices by label with remove buttons, "Pause all".
- **`#alerts` route:** latest batches as listing cards (existing card renderer). Locked for the public like `#review`.
- **iOS install card** (§2) when on iOS Safari and not standalone.
- **Admin:** an "Alerts" card on `#admin-data` (or a new `#admin-alerts`): counts from `GET /api/admin/alerts`, the kill switch, max pushes per day, "Send test to my devices", last error.
- No inline styles (CSP); new classes in `app.css`.

## 11. Privacy and abuse limits

- **Who:** only `user`/`admin` with status `active` can call `/api/alerts/*` (existing gate) and receive (re-checked in the due query and in the inbox). Public and pending users get 401/403. Blocked users stop at the next run.
- **What leaves us:** nothing in the push itself. Notification text (via the inbox, behind the session) uses only public-safe fields (§6), so a lock screen shows no more than the public site does. No phones, emails, links, map links, author, society or post text, ever. A test asserts this.
- **Push services** see the endpoint, the send time and an empty body. They do learn that a Flat Hunt user got an alert at a given time. VAPID `sub` reveals the contact we choose, so use an alias or the app URL, not a personal email.
- **Endpoints are personal data and capabilities:** never log them, never return them from any API (`config` returns ids and labels only), exclude from `/api/export`, store only a coarse `label`, delete on 404/410, on device unsubscribe, on sign-out from that device, and with the user if users are ever deleted.
- **SSRF:** endpoint host allowlist and https-only (§6).
- **Limits:** 5 targets per user, 10 alert areas per user, daily cap (default 30 listings, 6 digests), minimum 60 minutes between digests, quiet hours 22:00 to 08:00 IST by default, test send 3/hour, body ≤ 4 KB, global `maxPushesPerDay` (default 2,000) and kill switch in `settings.alerts`.
- **Privacy page copy** (`docs/human/` and the in-app privacy text): what alerts send, that Google/Mozilla/Apple deliver them without seeing listing content, how to stop.

## 12. Failure handling

| Failure | Behaviour |
|---|---|
| 404 / 410 from push service | Delete the target. |
| 429 | Leave rows pending; skip that push origin for the rest of the run; retry next run. |
| 400 / 401 / 403 (bad JWT, key mismatch after a VAPID rotation) | `failures++`, `last_error`; skipped at 5, purged after 7 days. Admin view shows `failingTargets` and `lastError`. |
| 5xx / network / timeout | `failures++`; rows stay pending if no target of that user succeeded. |
| Invocation dies mid-send | Rows not yet marked sent are re-sent next run (at-least-once). Harmless: same `tag` replaces the notification, and `Topic` collapses undelivered duplicates. |
| D1 budget short (`repo.left() < 10`) | Skip the step; next run in 10 minutes. |
| VAPID secrets missing | Step returns `off`; `config.enabled` is false; UI hides the feature. |
| Inbox fetch fails in the service worker | Generic notification; tap opens `#alerts`, which loads after sign-in. |
| User signed out on that device | Inbox 401 → generic text (no details). UI deletes the target on sign-out, so normally no push arrives at all. |
| Backlog (more due users than 40 sends) | Oldest first; drains at 240 pushes/hour. Rows older than 36 h expire (still visible on `#alerts`). |
| Clock / quiet hours | IST has no DST; computed from UTC ms. |

## 13. Testing plan (node:test, `memoryDb()`, all network mocked)

New `test/alerts.test.js` (and `test/webpush.test.js` for crypto):
1. **Migration** applies on `memoryDb()`; previous-version queries still run (rollback safety).
2. **Enqueue:** new listing in an alerted area → one pending row; listing in two alerted areas → one row; merged repost → none; `is_sample` → none; `kind='seeking'` → none; post older than 24 h → none; area 0 → none; `max_rent` and `bhks` filters include/exclude correctly, unknown rent/BHK included; area backfill does not enqueue.
3. **Ingest budget:** an ingest page with alerts enabled stays within the 48-query budget (`budgeted()`), +1 statement.
4. **API auth:** public 401, pending 403 for every `/api/alerts/*`; user and admin OK; areas not followed → 400; > 10 areas → 400; > 5 targets replaces the oldest; target owned by another user is moved; `DELETE` on another user's target → 404.
5. **SSRF validation:** http URL, `localhost`, IP literals, non-allowlisted host, port 8443, userinfo, bad key lengths → 400; real-looking FCM/Mozilla/Apple/WNS endpoints → 201.
6. **No secrets out:** `config`, admin view and `/api/export` never contain `address`, `keys` or endpoint hosts beyond the label.
7. **Digest text privacy:** listings whose posts contain phones, emails, links, society and author names → `alertText()` output contains none of them (reuse the public serializer privacy fixtures); max 3 lines plus `+N more`; URL is `/#listing-<id>` or `/#alerts`.
8. **Inbox:** returns the latest batch only; test text within 10 min of a test send; generic text when nothing sent in 24 h; blocked user → 403; public → 401.
9. **Quiet hours:** IST conversion at 21:59, 22:00, 07:59, 08:00; wrap-around; start == end means none; held rows go out at the first run after quiet end as one digest.
10. **Caps:** `min_gap_min`, `max_digests`, `max_listings` (rows set `capped`), global `maxPushesPerDay`.
11. **Send results (mocked `fetchFn`):** 201 → sent, failures reset; 410 and 404 → target deleted; 429 → rows stay pending, origin skipped for the rest of the run; 403 → failures++ and `last_error`; 500 → pending retained when all targets failed, sent when one succeeded; user with 2 targets gets 2 requests.
12. **Budget:** `alertStep()` with 100 due users and 130 targets: ≤ 10 D1 queries, ≤ 40 fetch calls, rest left pending; the next call sends the next users (resumable, oldest first); idle run uses 2 queries.
13. **Expiry:** pending rows older than 36 h → `expired`; purge deletes rows older than 7 days.
14. **VAPID crypto:** JWT has 3 base64url parts, header `ES256`, `aud` = endpoint origin, `exp` ≤ now + 24 h; signature verifies with `crypto.subtle.verify` using the public key; one sign per audience per run; `Authorization` and `TTL`/`Topic`/`Content-Length: 0` headers present; no body sent. Uses a key pair generated inside the test, never a real key.
15. **CPU:** `alertStep()` with 40 targets and mocked fetch runs in < 5 ms JS time in Node (same style as the ingest CPU test).
16. **Cron dispatch:** `scheduled()` with `cron: '*/10 * * * *'` runs only `alertStep`; the hourly cron string runs `scheduledJob` unchanged.
17. **Kill switch:** `settings.alerts.webpush=false` → step `off`, API 403 `alerts_off`, `DELETE` still works.
18. **E2E (Playwright, optional):** Alerts section renders for a signed-in user; iOS-like user agent without standalone shows the install card. Real push delivery is manual QA.

Manual QA (record in `docs/QA.md`): Android Chrome (browser and installed), desktop Chrome, Firefox, Safari macOS, iPhone with iOS 16.4+ installed PWA: subscribe, test send, real alert, tap-through, unsubscribe, revoke in OS settings then confirm the target is deleted on the next send, sign-out behaviour, Google sign-in inside the iOS Home Screen app.

## 14. Rollout

1. Merge the migration and server code with `settings.alerts.webpush` defaulting to **false** and no UI entry point. Deploy. Nothing visible.
2. Founder adds the VAPID secrets (§15); redeploy. Admin turns on the kill switch; only admins see the UI while `settings.alerts.adminOnly` is true (flag removed after QA).
3. QA runs the manual matrix on real devices, including iPhone. Fix the unverified items (Apple empty push, Google sign-in in standalone, endpoint hosts).
4. Open to all approved users. Watch the admin card (failing targets, pushes per day, last error) for a week.
5. Update docs in the same change: `docs/ai/ARCHITECTURE.md` (routes, tables, second cron, invariants: "push carries no payload; notification text uses only public-safe fields"), `docs/ai/COSTS.md` (alert step usage, $0), `docs/human/APP-FLOWS.md` and the privacy page, `docs/DEPLOY.md` (new secrets).

Rollback: code rollback leaves the new tables unused; the second cron trigger calling old code just runs the old `scheduled()` (which would then run the full hourly job every 10 minutes). **To avoid that, the rollback runbook must note: if rolling back past this feature, also revert the `crons` line in `wrangler.jsonc`** (it ships with the code, so a version rollback via `rollback.yml` restores the old trigger list **[unverified: confirm `wrangler rollback` restores triggers; if not, the old `scheduled()` must be guarded]**). Safer: in step 1 also make `scheduled()` ignore unknown cron strings, so any later rollback is harmless.

## 15. Founder actions

1. **Generate VAPID keys locally** (never in the repo, never in chat). With Node 22, no packages:
   ```sh
   node -e "(async()=>{const s=crypto.subtle;const k=await s.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']);const j=await s.exportKey('jwk',k.privateKey);const p=Buffer.from(await s.exportKey('raw',k.publicKey)).toString('base64url');console.log('VAPID_PUBLIC_KEY='+p);console.log('VAPID_PRIVATE_KEY='+j.d)})()"
   ```
2. **Add GitHub Actions secrets:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:<an alias you control>` or the app URL). Keep a copy in your password manager: rotating the key pair invalidates every subscription (users must turn alerts on again).
3. **Approve the deploy.yml change** (engineer makes it): add the three names to the optional-secrets `env` block and the `keys` array in "Deploy Worker (with secrets)", uploaded only when set like `GROQ_API_KEY`.
4. **Approve the second Cron Trigger** (`*/10 * * * *`; uses 2 of the 5 free triggers).
5. **Test on your iPhone** (iOS 16.4+): install to Home Screen, sign in there, turn on alerts.
6. Decide the open questions below.

## 16. Cost

**$0.** Web Push delivery through FCM, Mozilla autopush, Apple and WNS is free with VAPID. Workers Free: +144 cron invocations/day, ≤ 10 D1 queries each (2 when idle), ≤ 40 subrequests each, est. < 3 ms CPU; +1 Worker request and ~3 D1 queries per notification received; ≈ 3,000 queue rows written per day at 1,000 alert users. All far under the daily limits in `docs/ai/COSTS.md`. No Apify impact (no change to cutoff, groups or `resultsPerGroup`). No new npm dependency. No domain needed.

## 17. Open questions

- **Q1.** Defaults: quiet hours 22:00 to 08:00 IST, 30 listings and 6 digests per day, 60-minute gap. OK?
- **Q2.** If Google sign-in fails inside the iOS Home Screen app, do we add a "send me a sign-in link" flow (needs email sending, not free on Workers Free) or a one-time device-link code shown in Safari and typed in the installed app? Architect suggests the device-link code if needed.
- **Q3.** Alert on a repost that brings an old listing back (last post > 7 days ago)? v1 says no.
- **Q4.** Should seekers be able to alert on "looking for flatmate" posts (`kind='seeking'`)? v1 says offers only.
- **Q5.** Admin-only soft launch first (recommended), or straight to all approved users?
- **Q6.** Do we want a "+N more" link to open `#browse` filtered by area instead of `#alerts`? (`#browse` has no area-in-hash today.)

## 18. Engineer task breakdown

Ordered; each is one reviewable PR (or commit) with its tests. Run `npm test` green before each hand-off.

1. **Migration and repo.** `migrations/0004_alerts.sql`; repo functions in `src/db/repo.js`: `alertPrefs`, `putAlertPrefs`, `alertAreas`, `replaceAlertAreas`, `alertTargets`, `upsertAlertTarget`, `deleteAlertTarget`, purge additions in `purgeOld`. Unfollowing an area deletes its `alert_areas` row. Tests: §13.1, part of 13.13. Docs: ARCHITECTURE §6 table list.
2. **Enqueue in ingest.** `src/alerts.js` `enqueueStatement(newIds, now)`; pass it via `saveIngest({ extra })` from `ingestItems()` for live sources only. Tests: §13.2, 13.3.
3. **User API (no sending).** `alertsApi()` in `src/alerts.js`, routed from `src/app.js`: `config`, `prefs`, `areas`, `targets` POST/DELETE, endpoint allowlist, export exclusion, kill switch. Tests: §13.4, 13.5, 13.6, 13.17.
4. **VAPID channel.** `src/channels/webpush.js` (key import, JWT, request, response classification), `src/channels/index.js`. Tests: §13.14.
5. **Send step and second cron.** `alertStep()`, `countedFetch()`, quiet hours, caps, write-back; `scheduled()` dispatch on `event.cron` (ignore unknown strings); `wrangler.jsonc` `crons: ["30 * * * *", "*/10 * * * *"]`; Node timer hook in `src/node-server.js`. Tests: §13.9 to 13.13, 13.15, 13.16. Docs: ARCHITECTURE §5 (new cron), COSTS.
6. **Inbox and test send.** `GET /api/alerts/inbox`, `alertText()`, `POST /api/alerts/test` with `rate_limits`. Tests: §13.7, 13.8.
7. **Service worker.** `web/sw.js`; add `/sw.js` to `PUBLIC_ASSETS` with `Cache-Control: no-cache`; registration in `web/ui.js`. Test: `/sw.js` is served to the public with security headers and no-cache; CSP unchanged.
8. **Alerts UI.** Bell toggles and filter sheet on Areas, Alerts section on Account, `#alerts` route, iOS install card, sign-out unsubscribe, `app.css` classes. Designer spec first. Optional Playwright check (§13.18).
9. **Admin.** `GET|PUT /api/admin/alerts`, `POST /api/admin/alerts/test` in `src/admin.js`; admin card in `web/ui.js`. Tests: admin-only, counts-only output.
10. **Deploy wiring and docs.** `.github/workflows/deploy.yml` optional secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`); `docs/DEPLOY.md`; `docs/ai/ARCHITECTURE.md` routes/tables/invariants; `docs/ai/COSTS.md`; `docs/human/APP-FLOWS.md` and privacy copy; rollback note in `docs/DEPLOY.md`.

Size: about **M** overall (tasks 1 to 7 are S each; the UI task is M).
