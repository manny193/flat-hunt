# Flat Hunt architecture (agent reference)

Dense reference for AI agents. Written 8 Nov 2026 against commit `d851063`. Plain-language version: `docs/human/ARCHITECTURE.md`. If code and this file disagree, the code wins; fix this file in the same change.

## 1. Runtime shape

One codebase, two entry points, one handler:

| Entry | File | Runtime | DB driver | Cron |
|---|---|---|---|---|
| Production | `src/worker.js` | Cloudflare Workers Free, Worker `flat-hunt` | `d1Driver(env.DB)` | Cron Triggers `30 * * * *` (= :00 IST, hourly job) and `*/10 * * * *` (area alerts only, §11) call `scheduled()` |
| Local / Docker | `src/node-server.js` | Node 22 | node:sqlite (`DB_PATH`) | in-process timer when `CRON_ENABLED=1` (`CRON_INTERVAL_MINUTES`) |

Both call `createApp({repo, assets})` from `src/app.js`, which exposes `fetch(request, env, ctx)` and `scheduled(event, env)`. `env.RUNTIME` is `'worker'` or `'node'`; `AUTH_DISABLED=1` only works when `RUNTIME==='node'`.

Bindings (`wrangler.jsonc`): `DB` (D1 `flat-hunt`), `ASSETS` (`./web`, `run_worker_first: true`, so every request, including static files, runs the Worker first and counts as a Worker request), `AI` (Workers AI). Vars: `APIFY_ACTOR`, `PUBLIC_BASE_URL` (filled at deploy by `.github/scripts/prepare-wrangler-config.mjs`). `observability.enabled` (Workers Logs).

## 2. Request routing (`src/app.js` `route()`)

Order matters; first match wins.

1. `/healthz`, `/api/health`: last ingest age. Public.
2. `POST /api/ingest/apify`: Apify webhook. Auth = constant-time `X-Ingest-Secret` vs `INGEST_SECRET`. Body ≤ 16 KB. Returns 503 + `retry-after` on partial ingest so Apify retries.
3. `/login`, `/api/login` (password break-glass, lockout 5 fails / 15 min / IP in `login_attempts`), `/api/logout`, `/auth/google`, `/auth/google/callback` (OIDC + PKCE, `src/google.js`), `/api/me`.
4. `/api/public/*` (`src/public.js`): GET only, per-IP fixed-window limit (`PUBLIC_RATE_LIMIT`, default 60/min) stored in D1 `rate_limits`. Output via `publicListing()`.
5. `PUBLIC_ASSETS` (UI JS/CSS/icons/manifest) and `/` HTML app shell: served to everyone (the shell holds no data). Fails closed (503) when no login method is configured.
6. No session: `/api/*` → 401. Pending user: `/api/*` → 403 `pending_approval`.
7. Signed in: non-GET `/api/*` passes `checkOrigin()` (Sec-Fetch-Site / Origin). `/api/admin/*` requires `role==='admin'` → `adminApi()` in `src/admin.js`. Other `/api/*` → `api()` in `src/app.js`.
8. Else static asset from `ASSETS`.

Every response goes through `secure()` (`src/http.js`): strict CSP (`script-src 'self'`, `style-src 'self' fonts.googleapis.com`, images only from self, fbcdn, i.redd.it, preview.redd.it, googleusercontent), HSTS, no-store on HTML/JSON, `X-Robots-Tag: noindex`.

### User API (`api()`)
`GET /api/listings?status&area&since` (user's deck: listings in the user's areas or already decided), `GET|PATCH|DELETE /api/listings/:id` (PATCH sets the user's status/stage/notes in `user_listing`; edits to fields override extraction), `DELETE /api/listings?status=rejected|sample=1` (admin), `POST /api/import` (admin; sources `scraper|phone|manual|sample`, ≤ 3,000 items, ≤ 2 MB), `GET|PUT /api/settings`, `/api/areas` (CRUD; create triggers backfill and links the area to the user), `GET /api/browse` (signed-in twin of public listings, full fields), `GET /api/keywords?name=`, `GET /api/runs` (admin), `POST /api/apify/run` (admin, forced `scheduledJob`), `GET /api/export` (JSON download).

### Admin API (`adminApi()`)
`finance` (GET `[?refresh=1]`: spend this Apify cycle, forecast capped at the stop guard, per-group spend, run costs, free services; PUT `{monthlyBudgetUsd}` $0.50–$500 → `settings.budget`; logic in `src/finance.js`, client rules in `web/finance.js`, spec `docs/design/FINANCE.md`), `scraper` (GET view incl. live Apify usage; PUT schedule/resultsPerGroup), `scraper/run`, `sources`, `subreddits`, `runs`, `stats?days=`, `groups` (validate ≤ 50 Facebook URLs; Pages flagged and skipped; GET adds each group's `plan` status), `group-plan` (GET Group performance view; PUT policy, validated, runs the allocator when on; POST `/:gid {action: pause|promote|resume}`), `areas`, `users` (role/status), `settings`, `listings` (search, delete), `phone-scan` (POST scan JSON → ingest with `source:'phone'`), `phone-scans` (reports "posts from groups we don't scrape"), `ai` (status, config, run, retry, merge suggestions).

## 3. Roles and serialization

Roles: `public` (no session) < `pending` < `user` < `admin`. Session = `__Host-flat-hunt-session` cookie, HMAC-SHA256 with `SESSION_SECRET`, 30 days. Role and status are re-read from `users` on every request (block is immediate). Admin = email in `ADMIN_EMAILS`, or promoted in Users. `APP_PASSWORD` logs in as the first `ADMIN_EMAILS` account. New Google users are `pending` when `settings.requireApproval === true` (default off).

`serializeListing(l, role)` in `src/serialize.js` is the only exit for listing data:
- user/admin: `fullListing()` (everything except `fp`, `sk`).
- public/pending: `publicListing()` allowlist of scalars; phones replaced by `[[phone]]`; links, `tel:`/WhatsApp, bare map/facebook links → `[link]`; emails → `[email]`; society names (listing's and any named in shown posts) → `[society]`; no author, no post URL; images only from fbcdn/redd.it; list view shows 1 post, detail ≤ 15. `limited: true`.

## 4. Data flow: sources → listing

```
Apify run (Facebook public groups) ─webhook─► POST /api/ingest/apify ─► ingestDataset() ─┐
hourly sweep (missed/partial runs) ─────────────────────────────────► ingestDataset() ─┤
Reddit OAuth /new or search (redditStep) ──────────────────────────────────────────────┤
Admin: /api/import, /api/admin/phone-scan ─────────────────────────────────────────────┤
                                                                                       ▼
                                                                    ingestItems() (src/ingest.js)
```

### 4.1 Apify run lifecycle (`src/apify.js`)
- **Due?** `isDue(schedule, lastStartedAt, now)`. Mode `times`: start in an IST hour listed in `runHoursIst` (default 6, 9, 11, 13, 15, 17, 19, 21) if not already started in that hour. Mode `interval`: every `intervalHours`.
- **Cutoff** `cutoffFor()` = max(last successful start − overlap (`schedule.overlapMin`, 1–60, default 15 min), now − `backfillDays` (1–5, default 3)). Sent as `apifyTime()` = ISO without milliseconds (the actor rejects ms).
- **Budget guard** before each start: `GET /v2/users/me/limits`. Usage > `budgetStopPct` (95%) → skip. > `budgetWarnPct` (80%) → halve posts per group (min 5).
- **Input** `buildInput()`: automly `{groups, resultsPerGroup (default 30, max 50), sortOrder:'new', postsPublishedAfter, includeGroupInfo}`. `includeGroupInfo` only when `groupInfoStale()` (weekly or watched list changed), because group rows are billed like posts.
- **Run caps**: `maxItems` = groups × perGroup (+ group rows); `maxTotalChargeUsd` = min(natural ceiling × 1.2, `maxRunUsd` default $0.50).
- **Webhook** registered per run (`?webhooks=` base64), `ACTOR.RUN.SUCCEEDED` → our ingest endpoint with `{datasetId, runId}`.
- **ingestDataset()**: `claimRun()` (dataset_id UNIQUE → once only), then pages of `pageSize(env)` = `INGEST_PAGE_SIZE` (default 15, 10–500) rows, up to `MAX_PAGES`=4 per webhook call (`SWEEP_PAGES`=3 from cron). Progress (offset + group names) is saved in the same batch as each page's listings. Cut off → `partial` → 503 → Apify retries, or the next sweep resumes. At the end: real run cost from `/actor-runs/:id` via `runCost()` = platform usage + max(charged rows, rows read) × `ROW_PRICE` ($0.0012 automly, $0.005 official), stored in `runs.cost_usd`.
- **sweep()**: last 3 SUCCEEDED runs on Apify; ingests at most one dataset not `done` per invocation.

### 4.1a Group plan (`src/groupplan.js`, behind `settings.groupPlan.enabled`, default off)
Design and status: `docs/ai/GROUP-SCHEDULING.md`. Off: `startRun()` is unchanged (tested byte-for-byte). On:
- **Daily allocator** `runGroupPlan()` (cron tick with no ingest, at most once a day; also on plan save and on any watched-group edit): `repo.groupRuns()` (1 read: per-group report fields of done Apify runs over 7 days and the cycle) → `groupStats()` → `allocate()` → `repo.patchSettings('groupState', …)` (json_patch, never touches `lastRead`) + `groupPlanRun`. Rules are deterministic (no AI): trial for new groups, pause for low smoothed yield, echo (cross-posts) or 3 unscrapable runs, retry in trial after `retryDays`, manual pause/promote never overridden, at least `minActive` groups read (sampled rather than paused when money is short), last 10 status events per group.
- **Pace**: `dailyAllowance()` = (min(budget, Apify limit) × 0.95 − spent before today) / days left. Replaces the 80/95 % guard. Each tick may spend at most allowance − today's spend (`repo.apifySpentSince`: measured cost, else rows × price, else the charge cap of a running run).
- **Cohorts** `planCohorts()`: due groups (hot every slot, normal ≥ 3.5 h, cold/sample/trial after 13:00 and 21:00 IST) grouped by cutoff (full: lastRead − overlap; sample: now − lookback 1/2/3/6/12 h; new trial: now − 6 h), cutoffs within 1 h merged, at most 3 runs per tick. `caps.groupIds` recorded per run.
- **Ingest done**: `repo.markGroupsRead()` sets `lastRead = max(stored, run start)` for the cohort (1 statement); a cut-short cohort keeps its cutoff and sets `recoverNext` (re-read once with 50 posts per group). Group details from a cohort merge into `settings.groupInfo`. `annotateRun` keeps `caps` in the final report.
- **Cross-posts** (`ingestItems`): report `mergedByGroup` and `crossFrom[group][firstGroup]` from listings already loaded for the merge (no extra query).

### 4.2 Reddit (`src/reddit.js`)
**Public JSON mode (no key, issue #33):** when `REDDIT_CLIENT_ID/SECRET` are absent and `schedule.redditPublic` is true (off by default; `redditEnabled` stays the master switch), `redditPublicStep()` does one GET per subreddit to `https://old.reddit.com/r/<name>/new.json?limit=50&raw_json=1` (UA `FlatHunt/1.0 (+https://flat-hunt.19mnsh.workers.dev)`, no cookies/proxies), at most 3 subreddits per cron tick with a 2 s pause between requests, resumable through `settings.reddit.cycle`. Per-subreddit watermark (`settings.reddit.watermarks`) moves only after a page was ingested. A subreddit with search words keeps only posts containing one of them. Any 403/429/5xx or non-JSON response stops Reddit for that run (never retried), is recorded in `settings.redditStatus {mode, ok, code, error, at, lastSuccessAt, consecutiveFails, postsRead, backoffUntil}`, and after 3 consecutive failures Reddit is skipped for 6 h. Admin shows mode, last success, last error code and posts read (sources table, `#admin-groups` subreddits panel). OAuth mode below is unchanged and wins when secrets exist.

App-only OAuth (`client_credentials`), User-Agent `flat-hunt/1.0 by <REDDIT_USERNAME>`. Cycle every `intervalHours`; one subreddit per step; posts newer than cutoff and per-subreddit watermark; pages of 25; resumes across invocations. Off unless `REDDIT_CLIENT_ID`/`SECRET` set. Default subreddits in `DEFAULT_SUBREDDITS`.

### 4.3 ingestItems() (`src/ingest.js`), ~4–6 queries per call regardless of batch size
1. `prepareItems()` normalises rows (both actor layouts, Reddit, phone scan, pasted text); collects group rows and unscrapable groups.
2. `screenItem()` (core/logic.js): drop no-text and non-housing posts; regex extraction (kind offer/seeking, type, BHK, rent, deposit, brokerage, phones, society…); area tags from area keywords. With `storeAll` (all production sources) posts that match no area are still kept (area 0).
3. Exact dedupe: one `lookupKeys()` over `post_keys` (`u:<url>`, `h:<texthash>`, `n:<texthash>|<group>`). Same URL → duplicate (counted, dropped). Same text elsewhere → repost, merged into that listing.
4. Fuzzy match: `candidates()` = same area + kind, BHK compatible, rent ±12% (`RENT_WINDOW`), posted in last 60 days, ≤ 100 per post; MinHash sketch prefilter; token fingerprints fetched only for plausible candidates; `scoreCandidate() ≥ MATCH_THRESHOLD` → merge. Same phone alone never merges (D19).
5. One `saveIngest()` batch: new/changed listings, new keys, `listing_match` rows, run log + progress.

### 4.4 After ingest
- **AI enrich** (`src/ai.js`, `runEnrich`): right after a webhook ingest (`ctx.waitUntil`, if ≥ 16 queries left) and every cron tick. `aiEnqueue()` queues newest posts (last 7 days, ≤ 50 per call) of listings with `ai_status=''` **only in areas some user follows**. Batches of 5 posts. Phones/emails/links redacted first. Models: `@cf/google/gemma-4-26b-a4b-it` → `@cf/openai/gpt-oss-20b` → Groq `openai/gpt-oss-20b` on quota error 3036. Caps: `aiConfig.neuronCap` (8,000/day), `maxPostsPerDay` (300). Merge rules D17: AI wins on kind/type/gender/furnishing/brokerage; money only if the number appears literally in the text and (regex empty or confidence ≥ 0.7); user edits always win. Ambiguous duplicate after AI → `merge_suggestions`. Known issue: production AI fails with "invalid JSON" (HANDOFF §9.2).
- **Area backfill** (`src/backfill.js`): new area or keyword change → scan stored listings by rowid chunks of 4,000 with LIKE patterns, tag `listing_match`; state in `settings.areaBackfill`; continues on cron.
- **Retention purge** (daily, in cron): delete listings older than `retentionDays` (default 30, 7–365) unless shortlisted (`status='approved'` globally or in any `user_listing`); 500 per run; also clears old `rate_limits` and `login_attempts`.

## 5. Hourly cron: `scheduledJob()`

All steps share one `budgeted(repo, 48)` counter (`repo.left()`):
1. Apify: start run if due (or forced; with the group plan on, up to 3 cohort runs) → save `settings.scheduler` → `sweep()` one dataset. Measured worst case with 3 cohorts and a 3-page sweep: 46 statements.
2. `extras()` with what is left: the daily group allocator when due and nothing was ingested this tick (then the rest waits an hour; ~11 statements), else Reddit step (needs ≥ 26 left), AI enrich (≥ 20, 6 calls), area backfill (≥ 12), daily purge (≥ 10).
3. Save scheduler status and `nextRunAt`.
A step that throws records its error in the status and does not block later steps or the next run.

## 6. Data model (D1 / SQLite, migrations 0001–0004; alert tables in §11)

| Table | Key | Notes |
|---|---|---|
| `areas` | id | name, keywords JSON (≤ 8 variants from `core/keywords.js`), active |
| `listings` | id TEXT | shared across users. kind, bhk, rent, phones/areas/fp/sk JSON, first/last_posted_at, `data` JSON (posts[], groups, rentHistory, extracted fields), `ai_status`, `ai_confidence`, `is_sample`. Legacy single-user `status/stage/notes` still exist. Indexes on last_posted_at, (status,last_posted_at), updated_at |
| `listing_match` | (listing_id, area_id) | area 0 = no area. Indexes (area_id, kind, rent) for candidates, (area_id, last_posted_at) for area browse |
| `post_keys` | key | exact-dedupe keys → listing_id |
| `runs` | id; dataset_id UNIQUE | source, status (running/ingesting/partial/done/failed), report JSON (counts, per-group stats, progress, cost), actor, cost_usd, started_at, finished_at |
| `settings` | key | JSON values: groups, subreddits, schedule, resultsPerGroup, scheduler, apifyUsage, groupInfo, groupPlan (policy), groupState (per group id: status, why, at, since, lastRead, mode, coverage, lookbackH, tier, rate, yield, echo, fails, manual, history), groupPlanRun, unscrapableGroups, areaBackfill, purge, requireApproval, aiConfig, ai, reddit, keywordFilter |
| `users` | id; email UNIQUE | role admin/user, status active/pending/blocked |
| `user_listing` | (user_id, listing_id) | per-user status new/approved(shortlist)/rejected(passed), stage (To call … Token paid), notes |
| `user_areas` | (user_id, area_id) | areas a user follows (drives Review deck and AI queue) |
| `rate_limits`, `login_attempts` | key / ip | fixed windows; purged daily |
| `ai_queue` | post_id | status pending/retry/done/failed, attempts ≤ 5, next_at backoff, model, confidence, error |
| `merge_suggestions` | id | AI-proposed duplicate merges for `#admin-ai` |

## 7. Invariants (tests guard most of these)

1. Public responses contain no phone digits, emails, links, author names, society names or post URLs.
2. Each Apify dataset is ingested at most once (`runs.dataset_id` UNIQUE + `claimRun`); resume never double-counts (progress saved in the same batch).
3. No cron or webhook invocation exceeds 48 D1 statements; one ingest page fits in 10 ms CPU (~4.5 ms measured in Node for 15 posts).
4. The Apify cutoff never goes earlier than `now − backfillDays` and never includes milliseconds; every run carries `maxItems` and `maxTotalChargeUsd`.
5. AI never sees phones/emails/links and never invents numbers.
6. Migrations are add-only; previous code version runs on the new schema.
7. User edits override extraction and AI.
8. Browse with no `area` returns every stored housing post in the city (offers by default; `kind=seeking` for seekers); `area` narrows via `listing_match`.
9. Area alerts: a push carries no payload; notification text uses only public-safe fields (type/BHK, rent, area name) and is served only behind the session; push endpoints are never logged or returned by any API.

## 8. UI (`web/`)

Vanilla JS (`ui.js`), `app.css`, `index.html`, PWA manifest. Hash routes: `#browse` (default, opens on "All Bangalore"), `#listing-<id>` (detail sheet), `#review`, `#shortlist`, `#passed`, `#areas`, `#account`, `#signin`, `#alerts` (latest alert batches), `#area-<id>` (homepage filtered to an area, used by notifications), admin `#admin-scraper`, `#admin-groups`, `#admin-phone`, `#admin-ai`, `#admin-data`, `#admin-users`, `#admin-alerts`. `web/alerts.js` (alerts UI, imported by `ui.js`) and `web/sw.js` (service worker, push only, no fetch handler). Locked routes open the sign-in sheet for the public. Phone: bottom tabs; desktop: left rail. Charts are plain SVG. Design tokens: `docs/DESIGN.md`.

## 9. CI/CD (`.github/workflows`)

`ci.yml` (unit, Playwright e2e, Worker bundle dry-run, Docker build + healthcheck) · `deploy.yml` (on `main`: CI, secrets check, D1 resolve/create, migrations, `wrangler deploy --secrets-file`, smoke test, auto-rollback) · `rollback.yml` (version + D1 Time Travel ≤ 7 days) · `backup.yml` (weekly encrypted export, 30 days) · `healthcheck.yml` (daily, alert if no ingest for 12 h) · `ai-eval.yml` (manual). Actions pinned to SHAs; Dependabot on.

## 10. Extension points

| To add | Where | Watch out for |
|---|---|---|
| A new post source | new `src/<source>.js` with a resumable `step()` called from `extras()` in `src/apify.js`; feed rows to `ingestItems(repo, items, {source, storeAll:true, env})` | D1 budget (`repo.left()`), CPU per page, add `source` to run views, secrets optional and uploaded only when set |
| A new extracted field | `core/logic.js` (regex) + AI schema in `src/ai.js` + `PUBLIC_SCALARS` in `serialize.js` only if safe for public | privacy review; AI merge rule |
| A new public filter | `src/public.js` + `repo.publicListings()` + same in `/api/browse` | index use; D1 rows read per query (see `docs/ai/COSTS.md`) |
| A second city | planned: `city` on groups/subreddits/areas, `?city=` on browse, city picker replacing `CITY` constant | not started (HANDOFF §9.8) |
| An admin page | route in `adminApi()`, screen in `web/ui.js` SCREENS, admin-only guard both sides | CSP: no inline styles |
| Paid Apify actor switch | `APIFY_ACTOR` var; `ROW_PRICE` map in `src/apify.js`; field mapping in `prepareItems()` | official actor ≈ 3–4× the price per post |
| Edge rate limiting | commented `ratelimits` block in `wrangler.jsonc` | would remove one D1 write per public request (HANDOFF §9.4) |

## 11. Area alerts over Web Push (`src/alerts.js`, `src/channels/`, `web/sw.js`, `web/alerts.js`)

Design and reasoning: `docs/ai/ALERTS-WEBPUSH.md`. Payload-less VAPID pushes; the service worker fetches the text.

- **Switches** in `settings.alerts` (`ALERT_DEFAULTS`): `enabled` (default false), `adminOnly` (default true: soft launch), `maxPushesPerDay` (2,000), and defaults for new users `quietStart` 22, `quietEnd` 8 (IST), `maxListings` 30, `maxDigests` 6, `minGapMin` 60. `maxListings`/`maxDigests` also cap what a user may pick. Run stats in `settings.alertsRun` (day, pushesToday, lastRunAt, lastError). Missing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` = off (step idle, UI hidden).
- **Enqueue**: `ingestItems()` appends one `enqueueStatement()` to its `saveIngest()` batch when alerts are on and the source is live (`apify`, `reddit`, `phone`): brand-new listings only (reposts merge, samples/imports/backfill never), `kind='offer'`, area ≠ 0, posted in the last 24 h, user's max-rent/BHK filters (unknown values included), prefs enabled. +1 D1 statement per ingest call.
- **Send step** `alertStep()` on the `*/10 * * * *` trigger only (`scheduled()` dispatches on `event.cron`, ignores unknown strings; Node: 10-minute timer when `CRON_ENABLED=1` and VAPID set). Settings → due users (≤ 60, oldest first, one query with today's counts) → targets → ≤ 40 pushes in groups of 6 → one write-back batch (expire > 36 h, mark sent with `sent_at` = batch id, mark `capped` = over the listing cap or no working device, delete 404/410 devices, count failures, reset ok devices) → `settings.alertsRun`. ≤ 10 D1 queries, 2 when idle. Quiet hours (IST, wrap midnight), min gap, digests/day, listings/day, global pushes/day, admin-only all apply here; users who wait keep `pending` rows.
- **Channel** `src/channels/webpush.js`: endpoint allowlist (FCM, Mozilla, `*.push.apple.com`, `*.notify.windows.com`; https, port 443, no userinfo) checked on store and before every send (SSRF guard); `importVapid()` (JWK from the base64url secrets), one ES256 JWT per push-service origin per run, `POST` with no body, `TTL: 21600`, `Urgency: normal`, `Topic: flat-hunt-alerts`. `src/channels/index.js` is the plug-in point for Telegram later.
- **API** (behind the normal gate, `alertsApi()`): `GET /api/alerts/config` (enabled + reason, public VAPID key, prefs, areas, devices without endpoints), `PUT /api/alerts/prefs`, `PUT /api/alerts/areas` (≤ 10, followed areas only), `POST /api/alerts/targets` (≤ 5 per user, oldest replaced; an endpoint moves to the account that registers it), `DELETE /api/alerts/targets/:id` (always allowed), `GET /api/alerts/inbox` (service worker; `?full=1` for `#alerts`), `POST /api/alerts/test` (3/hour). Everything except config and DELETE answers 403 `alerts_off` when off, not configured, or admins-only. Admin: `GET|PUT /api/admin/alerts` (counts only), `POST /api/admin/alerts/test` (own devices only).
- **Notification text** `alertText()`: ≤ 3 lines `2 BHK · ₹28,000 · Green Glen` + `+N more`. URL: one listing → `/#listing-<id>`; several in one area → `/#area-<id>` (homepage filtered); mixed areas → `/#alerts`. Generic text if nothing was sent in 24 h or the fetch fails; test text for 10 min after a test send.
- **Tables** (`migrations/0004_alerts.sql`): `alert_targets` (device: channel, address = endpoint, keys, label, failures, last_ok_at, last_error; UNIQUE(channel, address)), `alert_prefs` (per user), `alert_areas` (user, area, max_rent, bhks `,1,2,1RK,`), `alert_queue` (PK (user_id, listing_id); status pending/sent/capped/expired; sent_at = batch id). Unfollowing or deleting an area removes its `alert_areas` rows; the daily purge drops queue rows after 7 days and devices with ≥ 5 failures after 7 days.
- **Rollback**: the tables are add-only. Rolling back past this release, also remove the `*/10` trigger from `wrangler.jsonc`, or the old `scheduled()` runs the hourly job every 10 minutes.
