# QA report: Flat Hunt

Date: 2026-11-07. Reviewed: `main` at 37fe3fb (SDE + SRE build). Fixes start at efbac50.

## Verdict: SHIP WITH NOTES

The app is ready for production once the fixes below are merged. The security model holds: nothing
private is reachable without login, and I found no XSS or SQL injection. Before my fixes, ingest
had three faults that would have lost or mislabelled data in production: long datasets were cut
off, saved progress dropped group names, and the per-invocation D1 query cap was exceeded. The
parser also misread the most common rent format. All of these are fixed and have regression tests.
The main open risk is that nobody has seen a real Apify dataset yet (see Open risks).

## What I tested

| Area | How | Result |
|---|---|---|
| Unit + e2e suites | `npm test`, `npm run e2e` | 62 pass, 1 skipped (real Apify fixture not provided); e2e passes on phone and desktop |
| UI, phone 390×844 and desktop 1280×800, light and dark | My own Playwright sessions (4 runs) with screenshots, which I looked at | All functional checks pass (list below) |
| Unauthenticated access | Every API route × GET/POST/PATCH/PUT/DELETE, every static file, encoded paths, traversal, trailing slashes, case variants | Only `/login`, `/api/login`, `/healthz` (and `/api/health`), `POST /api/ingest/apify` and the login page assets (`app.css`, icons, manifest) answer without a cookie. `app.js`, `index.html`, `samples.json` and all data return 401, or a redirect to login |
| Cookies | Tampered signature, extended expiry with the old signature, expired, signed with another secret, garbage, 5 KB value, wrong cookie name | All 401 |
| Brute force | 7 sequential wrong passwords; 30 parallel; spoofed `cf-connecting-ip` / `x-forwarded-for` | Sequential: locked after 5. **Parallel: bypassed (fixed)**. Spoofed headers ignored on Node unless `TRUST_PROXY=1`, **which trusted the wrong XFF entry (fixed)** |
| CSRF | Cross-site and same-site `Sec-Fetch-Site`, foreign `Origin`, `text/plain` form posts, login and logout CSRF | All 403 |
| Webhook | No secret, wrong secret, GET, 40 KB body, malformed id, replayed dataset id, other event types | 401 / 401 / 405 / 413 / 400 / skipped / 202 |
| SQL injection | Area names, keywords, notes, stage, id path, `status`/`area`/`since` query, import items (text, URL, group, author), settings groups | All parameterised. Bad input gets a 400, tables stay intact |
| Stored XSS | Script, `img onerror`, `svg onload` and quote-breaking payloads in post text, group, author, area name, notes, group settings, report rows. Checked cards, list rows, detail sheet, side pane, shortlist, passed, settings, import report | Everything escaped, no script ran, no CSP violations |
| Headers | HTML, API, static, healthz | CSP, HSTS, nosniff, XFO DENY, Referrer-Policy and COOP on all of them. `no-store` on HTML and JSON |
| Ingest | Re-import, repost in another group, URL-less repost, broker with 4 flats on one phone, seeking post, two-area post, rent-drop repost | Re-import is a no-op (6 dupes), reposts merge, broker flats stay separate, seeking is tagged, both areas are tagged, rent history is kept |
| Parsing | 35 messy Indian formats (₹, k, L/lakh, `/-`, per month, maintenance, years, PIN codes, sqft, spaced phone numbers) | **4 wrong (3 fixed, 1 noted)** |
| Apify (mocked fetch) | Input builders for both actors, webhook encoding, 80% / 95% budget rules, sweep idempotency, page cut-off and resume, killed invocation, D1 query count per invocation | **5 faults (fixed)** |
| CPU | Ingest JS time per page against 2,000 listings, all posts matching | Page of 25: 4–6 ms warm, ~10 ms cold. Page of 100: ~11 ms warm |
| Deploy config | YAML parse of all workflows, compose and dependabot. wrangler bindings and vars against the env names the code reads. Cron string, assets, `run_worker_first`, CI commands, Playwright install, secrets list, smoke-test expectations, Dockerfile paths, `DB_PATH` | All consistent (details below) |

UI checks that passed in all four runs:
- Login, and the first-run "Where are you looking?" screen.
- Adding an area, and importing the samples from the UI (4 new).
- Swipe at 60 px (springs back), 200 px right (shortlist, stage "To call") and 200 px left (pass). A 30 px flick does nothing, and a vertical drag does not decide.
- Tapping a card opens the details sheet, and Esc closes it.
- The deck buttons, and the keys ← → ↓ Z 1 2 3. Enter does nothing on the wide layout, where the details are already in the side pane.
- Undo, both via the button and via Z, also resets the stage.
- Filters: BHK, max budget, seeking and reset.
- List mode.
- Shortlist: the next-stage button and the stage select persist and regroup after a reload. Call links are `tel:+91…`. WhatsApp links are `wa.me/91…?text=…`.
- Notes save on blur and are searchable. Move to Passed, then restore.
- Areas: add, pause (the paused area no longer matches on the next import), edit keywords (a new keyword matches on the next import), rename and regenerate, delete (no longer matches).
- Group URL validation message. Paste import with its report.
- Refetch on `visibilitychange`.
- An expired cookie leads to the login page. A 401 during use leads to `/login?next=…`, and after login you return to where you were. Logout gives 401 on the API.
- No horizontal scroll at 390 px. No console errors apart from the 400/401 responses the tests caused on purpose.

## Bugs found and fixed

Each fix has a regression test that fails without it.

| # | Sev | Bug | Commit |
|---|---|---|---|
| 1 | High | **Rent parsed wrong in the most common format.** `Rent 25000 deposit 100000` gave rent = none, deposit = 25,000. `Rent 25000 maintenance 2000 deposit 1 lakh` gave maintenance = 25,000. A label after a number always overrode the label right before it. `call 98765 43210 … 30k` gave rent ₹98,765. | efbac50 |
| 2 | High | **Long datasets lost posts.** After 10 pages the run was marked `done` and the rest of the dataset was silently dropped. | 00c5f95 |
| 3 | Med | **Resumed ingest lost group names.** Saved progress was built before the page's group rows were parsed, so after a cut-off every later post had no group name. | 00c5f95 |
| 4 | Med | **Webhook retries were cancelled.** A webhook arriving while another invocation held the dataset got `200 already ingested`, so Apify stopped retrying and the data waited up to 4 h for the sweep. It now answers 503 so Apify retries. Partial runs get 503 too. | 00c5f95 |
| 5 | Med | **`fields=` whitelist** (the risk you flagged). It could not be proven complete: the actors' real columns are unverified, and the normaliser reads names that were not in the list (`publishedAt`, `link`, `userName`, `content`, `caption`, `title` on group rows, top-level image fields). It is removed and replaced by `omit=topComments,latestComments,comments`. A test asserts every omitted key is one the normaliser ignores anyway. | 00c5f95 |
| 6 | Med | **Default `INGEST_PAGE_SIZE` was 100.** That is ~11 ms JS per page in the worst case, over the 10 ms budget, so a cut-off invocation might never finish a page. Now 25 (~4–6 ms). | 00c5f95 |
| 7 | High | **Over the D1 query cap.** One page is ~9 D1 statements. The 10-page loop, and the cron (sweep of up to 3 datasets, then startRun), exceeded the Workers Free cap of 50 queries per invocation. When the sweep failed, **no new scrape was ever started**. Now: 4 pages per webhook, 1 dataset (3 pages) per cron sweep, and the cron starts the run *before* sweeping. A test counts statements per invocation. | 7df35d5 |
| 8 | Med | **Pausing every area let all posts through.** With all areas paused, the keyword filter switched itself off, so every scraped post from the whole city went to Review. | 92622b3 |
| 9 | Med | **Open apps missed new listings.** `updated_at` was the ingest *start* time, so an app that synced during a multi-page ingest never fetched those listings until a full reload. | f89e265 |
| 10 | High (config) | **Access header trusted without the JWT.** `AUTH_MODE=cloudflare-access` without `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` trusted a bare `Cf-Access-Authenticated-User-Email` header. Anyone could send it whenever Access is not actually in front. That config now falls back to the password, or 503. | 212e233 |
| 11 | Low | **Lockout race.** Parallel wrong passwords all passed the 5-attempt check (30 of 30 were checked). The attempt is now counted atomically first. | 6344ce6 |
| 12 | Low | **Wrong XFF entry on Node.** Behind `TRUST_PROXY=1`, Node used the *first* `X-Forwarded-For` entry, which the client controls, so a self-hosted instance could be brute-forced. | 0075334 |
| 13 | Low | **Small touch targets.** On phones, Settings (32×40), Import, Call/WhatsApp (40×40), the stage pill and small buttons (34 px) were under 44 px. A `pointer: coarse` rule fixes this without changing desktop sizes, and the e2e now checks it. A duplicate `id="btn-reset"` is also fixed. | ca151ac |

Test-only commit: 2aaee55 (resume after a killed invocation, and timing at the new page size).
Files changed outside QA ownership (SDE files): `src/core/logic.js`, `src/apify.js`, `src/ingest.js`,
`src/db/repo.js`, `src/auth.js`, `src/app.js`, `src/node-server.js`, `web/app.js`, `web/app.css`,
`scripts/e2e-smoke.js`, and tests. New file: `test/node-server.test.js`.

## How ingest continues across invocations now

- **Webhook:** reads up to 4 pages of 25. Each page and its progress (offset plus group rows) are
  written in one atomic batch, so a cut-off can't double-count. When more pages remain, the run is
  saved as `partial` and the webhook answers 503 so Apify calls it again.
- **Killed by the CPU limit:** the run stays `ingesting`, and the lock expires after 5 minutes.
  Apify's retry, or the next cron sweep, resumes from the saved offset. This is tested end to end.
- **Cron:** starts the next run first, then sweeps at most one unfinished dataset (3 pages).

## Open risks, by severity

1. **High: the real Apify output has never been seen.** Field names in docs/APIFY.md come from Store
   pages, not from a run. The normaliser is tolerant and `fields=` is gone, but the first production
   run could still bring 0 listings or missing group names. **Action:** after the first run, export
   its dataset to `test/fixtures/apify-sample.json` (the skipped test then runs) and check the
   Settings "Recent imports" counts.
2. **Medium: CPU on real Workers is not measured.** My numbers come from Node on a dev box.
   `performance.now()` does not advance during CPU work in Workers, so `timings.jsMs` will read
   about 0 there. Paging now guarantees progress if one 25-post page fits. If logs show
   "Exceeded CPU", lower `INGEST_PAGE_SIZE` to 10 or move to Workers Paid (US$5/month).
3. **Medium: continuation depends on Apify retrying webhooks on 5xx.** Apify documents that it
   retries, but not the exact timing. If retries are slow, a large dataset finishes on the next
   4-hourly sweep instead.
4. **Medium: the healthcheck never alerts if no ingest has ever succeeded** (`lastIngestAgeMin:
   null` passes). A deploy where Apify was never wired up stays silent.
5. **Low: deck buttons below the fold on phones.** On 390×844 (and 375×667) the Pass/Shortlist/Undo
   buttons sit under the tab bar until you scroll. The deck height comes from the approved
   prototype. Swiping and the toast's Undo still work.
6. **Low: login lockout is per IP only.** A distributed guesser isn't stopped, but a 16+ character
   password, which deploy.yml enforces, makes this moot.
7. **Low: Google Fonts.** The CSP allows `fonts.googleapis.com`/`fonts.gstatic.com`, and the page
   loads fonts from Google. DEPLOY.md says `style-src 'self'`, so the doc doesn't match the code.
   It is also a third-party request on every visit.
8. **Low: parser and UI nits.**
   - `Expected rent 20-22k` gives 22,000, the top of the range.
   - Area keywords that are substrings of HTML entities (`amp`, `quot`) would show a broken `&amp;`
     in highlighted text. Cosmetic.
   - HEAD on API routes returns 404.
   - `docs/prototype-logic-test.js` hard-codes `/home/claude/flat-radar/…` (dead).
   - "Radar" naming remains only in the prototype reference file.
9. **Cannot verify here (no network):**
   - `wrangler deploy --secrets-file` in wrangler 4.156.2.
   - Whether D1 counts each statement in a batch against the 50-query cap. I assumed it does, which
     is the conservative choice.
   - The real deploy smoke test.

## Deploy config check

- **Bindings and vars:** `DB`, `ASSETS`, `APIFY_ACTOR` and `PUBLIC_BASE_URL` match what the code
  reads.
- **Assets:** `./web` with `run_worker_first: true`, and the Worker checks login before calling
  `env.ASSETS`.
- **Cron:** `30 */4 * * *` = 06:00/10:00/14:00/18:00/22:00/02:00 IST.
- **CI:** runs `npm test` and `npm run e2e`, both of which exist. Playwright 1.63.0 installed
  `--no-save` resolves for `createRequire(...)('playwright')`, the same version I tested locally.
- **Secrets:** deploy.yml pushes APIFY_TOKEN, INGEST_SECRET, APP_PASSWORD and SESSION_SECRET, which
  are exactly the secrets the code needs.
- **Smoke test:** expects `/healthz` 200 (`{"ok":true,…}`), 401 on `/api/listings` and 401 for a
  wrong ingest secret. These match the real responses.
- **Docker:** Dockerfile and compose paths are correct. `DB_PATH=/data/flat-hunt.db` sits on the
  volume, the container runs as non-root, and the healthcheck uses `/healthz`.
- **YAML:** every workflow, compose and dependabot file parses.

## For the founder to decide

- **Workers Paid (US$5/month):** only needed if production logs show CPU-limit errors after the
  first week.
- **Retention:** listings with third parties' phone numbers are kept forever (plus 30 days of
  backups). Consider auto-deleting passed listings after N days.
- **Deck layout:** whether to shrink the deck on short phones so the action buttons are visible
  without scrolling (a design change to the approved prototype).
- **Fonts:** keep Google Fonts, or self-host them so the app makes no third-party requests.

---

# Round 2: v2 (accounts, public browse, Reddit, AI, admin, hourly cron)

Date: 2026-11-07. Reviewed: `main` from bb64282 (live in production) to fe93f7b (v2, not pushed).
Fixes: d6457d1 to 52f3631.

## Verdict: SHIP WITH NOTES

Deploying v2 over production does not lock the founder out. The upgrade and a rollback are both
safe. The privacy model holds after my fixes: an allowlist serializer on the server, and roles re-read
on every request. I found and fixed two public leaks (phone formats and society names), one
upgrade data-ownership bug, an extraction gap that hid call buttons, and a CPU-budget regression.
The founder has one important decision to make: sign-ups are open by default (see below).

## Lockout and upgrade safety (priority 1)

| Check | Result |
|---|---|
| I built a 0001-only DB shaped like production (1 area "Green Glen", 4 groups in `settings.groups`, scheduler and Apify usage settings, one done and one running run, a login_attempts row), then applied 0002 and 0003 | Both apply cleanly. Re-applying is a no-op. Existing rows are kept |
| `APP_PASSWORD` + `SESSION_SECRET` only. No `ADMIN_EMAILS` (or `--var` failed), no Google secrets | `/healthz` 200, public `/` 200, public areas OK, `/login` shows the password form. Password login gives **admin**, and `/api/admin/*` and `/api/settings` return 200. `/auth/google` goes to `/login?error=google_unconfigured` (no crash) |
| `ADMIN_EMAILS` added later | Break-glass now signs in as that email, still admin. **Bug: his account had no areas or decisions (fixed, d6457d1).** |
| Old production code (bb64282) on the migrated 0003 schema (rollback) | Login, area, import, list and patch all work. The migrations are add-only, as documented |
| Deploy smoke test | `/healthz` 200, `/api/listings` 401 and wrong ingest secret 401 still match the real responses |
| Failed `--var` / wrangler deploy | The deploy step fails before the smoke test, so no new version goes live. The migrations already applied are safe for the old code (see the rollback row) |

The one-time takeover of global decisions is latched to the first admin who signs in. On the live
upgrade that is the break-glass password used before `ADMIN_EMAILS` is set, i.e. the placeholder
`break-glass@flat-hunt.invalid`. Fix: when the latch holder is the placeholder, the first real admin
account receives a copy of its areas and decisions.

## Privacy (priority 2)

- **Phone fuzzing.** I fed nasty inputs through the public serializer and the public API:
  - spaced dashes and slashes;
  - `+91`/`0` prefixes;
  - numbers split across lines;
  - zero-width separators;
  - Devanagari, Arabic-Indic, full-width and mathematical digits;
  - numbers in group names, area names and notes;
  - `wa.me`/`tel:`/Maps/Facebook links and emails.

  **Leaked before the fix:** `98765 - 43210`, `98765 / 43210`, `98765_43210`, zero-width-separated
  numbers and every non-ASCII digit form. The same gaps applied to the redaction before the external
  AI call (Groq). Fixed in 23b6500.
- **Area names.** Anyone signed in can create an area. Area names were listed unmasked on the
  public page, so a name like "Call 98765 43210" would be public. They are now refused at creation
  and masked in the public API (23b6500).
- **Society names.** These were hidden only when written exactly as in the newest post. Capitals,
  or a second merged post naming another building, leaked. Fixed in dd878fb, which also recognises
  more building suffixes. **Limit:** a building name the regex doesn't recognise as one stays
  visible, because hiding is detection-based.
- **Not exposed.** Author names, Facebook post URLs, map links, emails, notes, stage and `phones`
  are never in the public JSON. The DOM check across 54 screen renders found nothing private for
  public or pending users.
- **Roles.**
  - Pending users get 403 on private APIs and the public view in the UI.
  - Blocked users count as public.
  - Role and status are re-read from D1 on every request. The session's role hint is ignored.

## Google OAuth (priority 3)

- **Protocol:** state, nonce and PKCE S256 are used. The flow cookie is `__Host-`, HttpOnly, Secure,
  SameSite=Lax, 10 minutes, and is cleared after the callback.
- **id_token verification:** the token is checked locally against Google's JWKS. Only RS256 is
  accepted (**`none` and HS256 tokens are rejected, new test df6dd9c**). `iss`, `aud`, `azp`, `exp`
  (with 120 s skew) and `nonce` are checked, and `email_verified` must be true.
- **Return URLs:** `//evil`, `https://evil`, `/\evil`, a tab prefix and `/login?next=…` all collapse
  to a same-site path.
- **Logout:** needs POST plus the origin check.

## Budget and limits (priority 4)

- **D1 cap, worst hour:** new test 4b27e3e combines a scrape that is due, a 300-post sweep backlog,
  a 100-post Reddit backlog, an AI queue, an area backfill and the daily purge. Every cron
  invocation stays at or under 50 D1 statements. The webhook plus AI enrich in `waitUntil` is also
  at or under 50. The `budgeted()` gates hold.
- **CPU:** v2 fuzzy-matches **every** housing post, not only area matches. The SDE's own timing
  shows a 25-post page at about 10 ms JS against 3,000 listings (12.8 ms cold). That is at the
  Workers Free limit: a page that never fits would stall the resumable ingest forever. I lowered
  the default page to **15 posts** (about 4.5 ms) in 4b27e3e.
- **AI:**
  - Every money field must appear in the redacted post text, or it is set to null.
  - Dates must fall within -31 to +181 days of the post. Enum values and bounds are checked.
  - Phones and maps always come from the regex, never from AI.
  - Auto-merge happens only with the same phone, the same BHK and rent within 2 %. Anything else
    becomes an admin suggestion.
  - The daily cap is checked only at the start of a pass, so one pass can overshoot by up to about
    30 posts. Minor.

## UI (priority 5)

My Playwright matrix covered 390×844, 375×667 and 1280×800, light and dark, for public, pending,
user and admin, across browse, review, signin, shortlist, areas, account and all 6 admin pages.
That is 108 screenshots, and I looked at a sample of them.

| Check | Result |
|---|---|
| Horizontal scroll | None anywhere |
| Console errors | None |
| Deck buttons | Above the tab bar on both phone sizes |
| Charts | Render with data |
| Empty states | Present |
| e2e (phone + desktop) | Passes |
| Touch targets | Several v2 controls were under 44 px (area picker 35 px, "Sign in to call" 33 px, segmented chips, table selects 36 px, row checkboxes 20 px, the sign-in sheet's password link 17 px). Fixed for touch screens in 52f3631. Desktop is unchanged |

**Extraction bug found through the UI.** A signed-in card read "No number in post" for "Call
98765 - 43210". Extraction used a narrower pattern than the public mask, so the call and WhatsApp
buttons were missing. Fixed in 52f3631: one matcher now serves both, and "rent 65000 - 70000" is
treated as a range, not a phone.

## Deploy config (priority 6)

- **wrangler.jsonc:** the `ai` binding `AI` and the hourly `0 * * * *` cron match the code.
- **deploy.yml:** optional secrets are uploaded only when set, and optional vars are passed with
  `--var` only when set. The env names match what the code reads.
- **ai-eval.yml:** valid, and `npm run ai-eval` exists.
- **YAML:** all workflows parse.
- **`test-results/`:** it is not tracked in git (`git ls-files test-results` is empty) and is already
  in `.gitignore`. The PNGs there were local leftovers from a failed e2e run; I deleted them.

## Open risks (round 2), most severe first

1. **High (founder decision): sign-ups are open by default.** Any Google account becomes an active
   user and sees every third party's phone number. "Require approval" is off until an admin turns
   it on. I recommend turning it on right after the first admin login, or defaulting it to on.
2. **Medium: the public rate limiter writes one D1 row per public API request.** A single IP
   staying under 60 a minute can make about 86k writes a day, close to D1 Free's 100k rows-written
   cap. That would stop ingest for the day. Consider the Workers Rate Limiting binding or an
   in-isolate pre-check.
3. **Medium (carried over): the real Apify dataset shape is still unverified.** The fixture test is
   still skipped. Also, CPU on real Workers is not measured; if logs show CPU-limit errors, set
   `INGEST_PAGE_SIZE=10`.
4. **Low: secrets removed from GitHub are not removed from the Worker.** `--secrets-file` adds and
   updates secrets. DEPLOY.md says removing `APP_PASSWORD` switches break-glass off; in practice you
   also need `wrangler secret delete APP_PASSWORD`. Unverified here (no network).
5. **Low:** society hiding is detection-based; the AI daily cap can overshoot by one pass; and
   `ADMIN_EMAILS` unset under Cloudflare Access makes every Access user admin (documented).

## Before and after deploy (founder)

- **Before:** nothing is required. To get Google sign-in, set the `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` secrets and the `ADMIN_EMAILS` variable (your Gmail) first.
- **After:**
  1. Log in once with Google using the `ADMIN_EMAILS` address, or with the password, and check that
     "Green Glen" is under My areas.
  2. Decide on "Require approval for new users" (Admin → Users).
  3. After the first scrape, save the dataset export to `test/fixtures/apify-sample.json`.

---

# Round 3: group rotation (`feat/group-rotation`, issue #28)

Date: 2026-11-08. Branch head 69d6a55. Tested only in the worktree: no push, no APIFY_TOKEN, no production.

## Verdict: SIGN-OFF WITH NOTES (one fix required before the push)

`npm test`: 133 tests, 132 pass, 1 skipped (the known real-fixture skip), 0 fail. Plan off leaves the
actor request byte-for-byte unchanged (tested). The cron with 3 cohorts plus a 3-page sweep, and the
allocator tick, are tested at 48 D1 statements or fewer.

## Do the tests cover the rules?

| Rule | Covered? |
|---|---|
| minActive, money short (best 6 sampled, not paused) | Yes (`minActive:` test) |
| minActive after a rotation pause when the pool is empty | **No, and the code does not hold it (issue 1)** |
| Rotation (low yield, echo, hysteresis, trial verdicts) | Yes |
| Retry after cool-off | Yes, one group. The re-pause edge in issue 3 is untested |
| Manual pause, promote and resume survive the allocator | Yes (unit and API) |
| 3 unscrapable runs pause a group; 2 do not | Yes |
| Daily allowance never exceeded | Yes for allowance and plan arithmetic; cohort caps are scaled to `tickUsd` |
| Plan-off body unchanged | Yes |
| D1 statements at most 48 | Yes |
| lastRead only after full ingest, failed cohort keeps cutoff, cut-short cohort re-read once | Yes |

## Issues, most severe first

1. **MEDIUM, must fix: minActive is not guaranteed.** `src/groupplan.js:249-251` (and 243-247) pause for
   low yield or echo with no check on how many groups stay read; the pool (`:259`) holds only queued
   groups and groups past `retryDays`. I ran 7 watched groups, 3 good and 4 at 5 % yield, all active for
   30 days: the allocator leaves **3 read** (founder rule: at least 6). Fix: when reading < minActive and
   the pool is empty, bring back the best-ranked paused (non-manual, non-unscrapable) groups early, as
   trial or sample, and add a test. The UI already shows "Below the minimum" so it is visible, not silent.
2. **LOW, deviation 3 (money short, even sharing): acceptable, with a note.** `src/groupplan.js:288-294`.
   Only the best `minActive` by yield share the money, so a lower-ranked group is never read while a better
   one is paused. But inside that set, a cheap group is read in full while pricier better ones are sampled.
   Example run: 5 groups at 6 rows/h (yields 80 to 40 %) sampled at 27 %, the 30 % group at 0.5 rows/h read at 100 %.
   Spend stays within the allowance, so this is not a spend bug. If wanted later, weight shares by yield.
3. **LOW: re-pause after retry.** `src/groupplan.js:158-160,239`. `fails` is recomputed from run history
   in the window (7 days or the cycle). If the three failing runs are still in that window when the
   30-day retry starts (31-day cycle), the group is paused again the next day without being read. Rare. Fix:
   count failures only from runs after `since`/`at` of the current status.
4. **LOW: crash window.** `src/apify.js:~268`. `markGroupsRead` runs after the run is marked done. If the
   invocation dies between the two, the run is never re-ingested and lastRead stays old: the next read
   re-fetches the window (extra cost, no loss). The safe direction.
5. **LOW: allowance exhausted.** `src/apify.js:~337`. A skipped slot does not set `lastStartedAt`, so every
   cron tick until the next slot calls Apify usage and writes `apifyUsage` (1 subrequest, 1 write a tick).
   Within limits; same pattern as the existing budget stop.
6. **INFO:** a manual promote with no money is read at the 1-hour sample, outside the ranking. Capped
   by the tick allowance. Matches "manual is never overridden".

## Reviewed, no fault found

- Spend: `dailyAllowance` caps at min(budget, Apify limit) x 0.95, subtracts today's runs (cost, or rows
  x price, or the charge cap of a running run), cohorts are scaled down to the tick. Hard stop is the per-run `maxTotalChargeUsd`.
- Cutoffs: active groups resume from lastRead minus overlap, no gap; only sample and trial groups skip
  posts, by design. A start failure or failed ingest moves nothing.
- Settings: `patchSettings` (json_patch) and `markGroupsRead` cannot clobber each other. Planner patch
  omits lastRead and recoverNext. The planner's `history` array can lose a manual click made in the same
  tick (milliseconds; ignored).
- Privacy and access: `/api/admin/group-plan` is behind the admin gate in `src/app.js:109`; output has group
  names, group URLs and counts only, no phone, email, author or post URL. Group id is validated
  (`/^g[0-9a-z]{1,16}$/`), body validated with ranges and types, 400 on bad input.
- crossFrom in `src/ingest.js`: counts only, no extra query, merged across pages by `mergeReports`.

## UI (dev server on port 8799, scratch DB, no APIFY_TOKEN, stopped afterwards)

Seeded 8 groups, turned the plan on. Desktop and 375 px: page renders, 4 KPIs, plan form, table and log. No
horizontal scroll at 375 px (scrollWidth 375); cards stack with labels; Pause, Promote and Resume buttons are
44 px high. Pause set "Paused manual", Resume started a trial (6 d 23 h left), Save plan toasted "Plan saved
and groups placed". No console errors, no CSP violations. The only `style` attribute is the meter width set
from JS (CSSOM, allowed by the CSP, same as the other pages).

## Before the push

Must fix: issue 1 (with a test), then re-run `npm test`. Issues 2 to 6 can follow as tickets.

### Fixed (engineer, 8 Nov 2026, commit 8722581)

- Issue 1: when the pool cannot refill to minActive, the best groups paused for low yield or echo are kept early (never manual or unscrapable). Test: 7 groups (3 good, 4 at 5 %) keep 6 read.
- Issue 2: money-short sharing is now weighted by yield, so a better group is never read less than a weaker cheap one; allowance cap unchanged. Test added.
- Issue 3: unscrapable failures count only since the group's last status change. Test added.
- Issues 4 and 5: left as is (accepted). `npm test`: 136 tests, 135 pass, 1 skipped.

---

# Round 3: area alerts over Web Push (branch feat/web-push-alerts, issue #30)

Verdict: **sign-off with notes.** No blocker. `npm test`: 148 tests, 147 pass, 1 skipped, 0 fail.

## What was checked and how

1. **Tests judged.** test/alerts.test.js and test/webpush.test.js cover the risky parts for real: public 401 and
   pending 403 on every alerts route; soft launch (`adminOnly`), kill switch and missing VAPID; delete always works;
   10 devices cap; quiet hours incl. IST wrap-around; minimum gap, digests/day, listings/day (rows capped), admin
   ceiling, global pushes/day; samples, imports, seeking, old posts, no-area and reposts never queue; backfill never
   alerts; 404/410 delete the device, 429 not counted as a failure and the origin is skipped, 5xx keep rows pending;
   endpoint allowlist (SSRF) at subscribe time and again at send time; D1 budget (<= 10 queries per run, idle run 2,
   a full webhook ingest stays within 48); inbox text leak test; /sw.js public with `no-cache`. The VAPID JWT test
   verifies the signature with WebCrypto (raw r||s, aud, sub, exp = now + 3600). Gap: nothing checks that
   `VAPID_SUBJECT` is a `mailto:` or `https:` URL (see N3).
2. **Privacy.** Notification text is built from type/BHK, rent and area name only. The inbox is session-scoped,
   so a signed-out device gets 401 and the service worker shows the generic line. Endpoints and keys never leave the
   server (`rowToTarget` omits them; tested for config and export). `DELETE /api/alerts/targets/:id` is scoped by
   `user_id` (other user's id gives 404, tested). The admin card has counts only; the admin test send only
   reaches the admin's own devices. No `console.*` in alerts.js, channels or web code; the cron logs only the status
   object (counts and error codes). `lastError` and `alert_targets.last_error` hold short codes.
3. **Workers Free CPU (measured, scratch script, not committed).** Real crypto is cheap: first `importKey` 0.5 ms,
   first ES256 sign 0.65 ms, each further origin 0.12 ms, steady state 0.07 ms per import or sign. 39 more
   mocked sends cost 0.6 ms. The "29 ms cold" the engineer saw is **Node's lazy load of `Response`**: the first
   `new Response(null, {status: 201})` in a fresh Node process costs about 30 ms CPU, the second 0.01 ms. That is the
   test mock, not app code; Workers has `Response` built in and the real `fetch` replaces it. Estimated real cold cost
   of the send step: crypto about 1.2 ms + JSON/D1 glue about 1 ms. What is **not** measured is workerd's own CPU per
   real `fetch` (headers, TLS bookkeeping); worst case guess 0.1 to 0.3 ms each, so 40 sends could reach 4 to 12 ms.
   Risk is low in the soft launch (a handful of admin devices) and rises only when it opens to everyone.
   Mitigations if the dashboard shows CPU near 10 ms: lower `MAX_SENDS` from 40 to 20 (rows wait for the next run,
   no code design change). No key cache needed: import is 0.08 ms.
4. **Cron safety.** `scheduled()` runs the alert step only for `*/10 * * * *`, the hourly job only for
   `30 * * * *`, `node-interval` or no cron string, and ignores anything else (tested, and the test also checks
   wrangler.jsonc lists only known crons). **Residual risk (N1):** the guard is only in the new code. If the deploy
   auto-rolls back to the current production version, that old code runs the full hourly job on every `*/10` tick
   unless `wrangler rollback` also restores the trigger list (documented as unverified in docs/DEPLOY.md).
   Apify spend is still protected by `isDue(lastStartedAt)`, but the Reddit step, AI extraction (Workers AI
   neurons) and backfill/purge steps would run 6x as often and use D1 budget.
5. **deploy.yml.** The three VAPID secrets are optional (the node script only writes secrets that are set; the
   Worker reports alerts "not set up" and the cron returns `off`). Smoke test adds only two GETs (/alerts.js,
   /sw.js, both public static) and does not need VAPID. Secrets go through a 077-umask file that is removed;
   nothing echoes them. CSP unchanged.
6. **UI** (npm run dev, scratch DB, throw-away VAPID keys generated in the scratchpad, not committed). Checked
   My areas bell and sheet, Account alerts panel, #alerts, Admin -> Alerts on desktop and at 375 px: all render,
   no horizontal scroll (375 vs 375), no `style=""` attributes, no CSP violations. The only console error is
   "An unknown error occurred when fetching the script": the browser pane refuses service worker registration
   (`/sw.js` itself returns 200 with `no-cache`), and notification permission shows as blocked, so the UI's
   "blocked" branch rendered. Subscribe, push and notification click could not be exercised here: real device.

## Findings, most severe first

| # | Severity | Where | Finding | Fix before push? |
|---|---|---|---|---|
| N1 | Medium | wrangler.jsonc triggers, .github/workflows/deploy.yml:146, docs/DEPLOY.md:207 | Auto-rollback to the pre-alerts version could leave the `*/10` trigger live against old code (hourly job every 10 min). Unverified whether `wrangler rollback` restores triggers. | No, but the founder must know: after any rollback, check `wrangler triggers` / dashboard and delete the `*/10` cron. Better: confirm behaviour once, or add a rollback-step note/redeploy of crons. |
| N2 | Low | src/alerts.js (MAX_SENDS, alertStep) | Real workerd CPU per push fetch unmeasured. | No. Watch CPU in the dashboard after the first admin test send; lower MAX_SENDS if needed before opening to all users. |
| N3 | Low | src/channels/webpush.js importVapid | `VAPID_SUBJECT` format is not validated. Apple rejects tokens whose `sub` is not `mailto:` or `https:`, which would show as 403 and count failures against every Safari/iOS device. | No. Cheap to add a check and a test. |
| N4 | Info | web/alerts.js, src/app.js | Shared device: the inbox answers for whoever's session cookie is current, so user B can see B's alert text on a push meant for A. Signing out calls `beforeSignOut` to remove the device. Acceptable, documented. | No |
| N5 | Info | test/alerts.test.js:472 | CPU test passes at < 15 ms JS time (loose for CI) and excludes the mock-Response warm-up, so it guards regressions but does not prove the 10 ms budget. | No |

## Real-device checklist (founder)

1. Set the three VAPID secrets (generate a fresh key pair; never reuse test keys), deploy, then Admin -> Alerts: turn Alerts on, keep "Admins only" on.
2. Android Chrome: follow an area, tap the bell, allow notifications, "Send a test to my devices". Notification arrives, tap opens the app.
3. iPhone: Add to Home Screen first (the install card explains), open from the icon, turn alerts on, send test. Check it is not a 403 (N3).
4. Desktop Chrome/Edge/Firefox, one each if possible: test arrives while the tab is closed.
5. Lock-screen preview shows only type, rent and area (no phone, link, name).
6. Sign out in the browser: the device disappears from Alerts; sign in as a non-admin: alerts panel says admins only.
7. Quiet hours: set quiet to cover now, wait for a real new post, confirm nothing arrives until quiet ends.
8. After the first run, read Workers dashboard CPU time for the `*/10` trigger (N2).
9. Before pushing: note the rollback runbook item (N1).

## QA round: Reddit public JSON (#33)

Public JSON tested 9 Nov 2026; Reddit requires login (403 from Cloudflare, login redirect elsewhere); removed in favour of the official API (#35).

## QA round: Reddit API only + deleted-post clean-up (#35, branch chore/reddit-api-only)

Verdict: **do not push yet. One must-fix (data safety).** `npm test`: 179 tests, 178 pass, 1 skipped, 0 fail.

Passed:
- Public JSON mode is gone: no `redditPublic`, `redditMode`, `redditPublicStep` or `redditStatus` in src/, web/ or admin output. The only reddit.com fetches are the OAuth token URL and `oauth.reddit.com`. Reddit does not run without `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` (cron, manual run returns 503, clean-up returns `not_configured`; tested).
- `redditStep` (OAuth path) has no removed lines against the commit before #33.
- Clean-up: HTTP errors (500/429/401), non-JSON bodies and a missing `data.children` array throw before any write, so the cursor does not move. Facebook posts in a mixed listing are kept (`p.source !== 'reddit'`). 1 token call plus 1 info call per tick. The cron only starts it at `repo.left() >= 14`, and the D1 budget is respected.
- Docs use the one-line wording; nothing about accepting a terms risk.

MUST-FIX (src/reddit.js:187, 193): "missing from the response" counts as gone (`isGone(undefined)` is true), and only `Array.isArray(children)` is checked. Probed with a mocked HTTP 200 `{"data":{"children":[]}}`: 2 of 2 stored posts and listings were deleted. A partial response deletes every id it omits. Needed: if the response is empty or returns fewer than some safe fraction of the ids asked, throw and leave the cursor alone. The best fix is to remove only on an explicit signal (author `[deleted]`, selftext `[removed]`/`[deleted]`, `removed_by_category`) and never on absence alone, or to require children.length > 0 and the id be missing in a response that otherwise looks complete. Add tests for an empty and a partial 200.

Minor: the stray repo.putSettings of `done` at the end of a cycle is fine; no other issues.

## QA round: alerts test, room rent, Browse actions (#36–#41)

Run 8 Nov 2026 on main (c3680b0), after the six PRs were already deployed without a QA round. Verdict: **no data-safety or privacy problem found. Two Medium bugs in the new Browse buttons and one Medium rent-parsing false positive; none needs a rollback, all should be fixed before the next push.** `npm test`: 185 tests, 184 pass, 1 skipped, 0 fail. `npm run e2e` (scripts/e2e-smoke.js, phone and desktop): all passed.

| Area | How tested | Result |
|---|---|---|
| Unit and API suites | `npm test` | Green |
| e2e smoke (#37) | `node scripts/e2e-smoke.js`, Playwright preinstalled | Green; the phone-digit check no longer trips on listing ids |
| Public serializer | Local dev server, 53 seeded posts incl. phones, emails, society names, FB URLs; `GET /api/public/listings` | No phone, email, society, URL or author in output; new `totalRent`/`rentEstimated` are the only added keys (numbers/boolean) |
| Sample alert text and admin-only | Read `alertsBlocked`, `alertText`, `alertSampleItem` (allowlisted columns only), router gate (src/app.js:129); existing tests alerts.test.js:236-250 | Non-admin still gets `off`/`admin_only` while alerts are off; `/api/admin/alerts/test` is behind the admin gate; text holds only type, rent, area name; one user's devices only. Real push not run (no VAPID locally) |
| Rent parsing | 21 realistic posts (Hinglish, "per head", "each", total vs share, master bedroom, PG range, seeking, studio), new vs d675fdd code | 19 as expected; whole-flat posts unchanged (see F3, F4) |
| Reparse | `POST /api/admin/listings/reparse` on dev server: repeated run, bad `after`, bad JSON, cross-site; function tests on user/AI-set fields | Idempotent (second run changes 0); `fieldSource` user/ai kept; bad input rejected; 400 error on garbage body; cross-site refused. 50 listings of 2 KB text take about 4 ms JS (see F5) |
| UI flows | Playwright 390x844 light, 390x844 dark, 1280x800 dark: Like, Reject, keyboard Enter on buttons, Undo, Shortlist and Passed Details, Like from Passed, `#review` redirect, counts, focus ring, console and CSP errors | Works; no console errors or CSP violations; focus ring visible; 56 px tap targets; layout intact in both themes. Bugs F1, F2 |
| CSP | DOM scan for `style=""` | Only the 3 existing `animationDelay` from the card entrance (set through CSSOM, no violation) |

### Findings, most severe first

| # | Severity | Where | Finding | Fix before next push? |
|---|---|---|---|---|
| F1 | Medium | web/ui.js:331-339 (`cardAction`), 398 (`decide`) | Double tap on Reject or Like (the card stays clickable for the 200 ms fade) runs `decide` twice. Two undo entries are pushed, so the first "Undo" restores "rejected" to "rejected" and nothing happens. Repro: Browse, double-click Reject, click Undo, check the listing: still `rejected`, absent from Browse. Suggested fix: in `cardAction` return if `card.classList.contains('leaving')` or `card.hidden`; add `pointer-events:none` to `.lcard.leaving`. | Yes |
| F2 | Medium | web/ui.js:300-310 `drawGrid` empty state | Once every visible card is liked or rejected, the grid is blank with "0 listings from 3 groups". After a reload it says "No listings in Bangalore yet", which is false (the listings are in Shortlist or Passed) and gives no hint. Because only 30 are fetched, a power user hits this quickly; "Show more" is hidden when `next` is null. Fix: when signed in and the unfiltered page was non-empty, show "You have gone through every listing. Check Shortlist or Passed", with Show more if `next` is set. | Yes |
| F3 | Medium | src/core/logic.js `SHARED_RE` (`sharing`, pre-existing) amplified by the new estimate | "Rent 55000 for 3BHK, sharing allowed for bachelors" is typed Shared flat and now shows "Estimated ₹18,300 a room" (total 55000). Before, it was a wrong type but the right number. Same for any whole-flat post that merely says "sharing allowed". Fix: do not derive an estimate unless a room phrase matched (not only `sharing`/`replacement`), or require "room/bed/flatmate" for the estimate; add a test. | Yes, or accept and note |
| F4 | Low | src/core/logic.js `ROOM_RENT_MAX` | "Room available in 3BHK, 40k per month incl maintenance" is treated as the whole flat's rent and shown as an estimate of ₹13,300. A real 40k master room is shown at a third of its price. The threshold is a guess. | No; watch real posts after Re-check |
| F5 | Low | src/admin.js:18 `REPARSE_PAGE = 50` | 50 listings of normal size is about 4 ms of JS on Node plus row decode and the write batch; Workers Free has 10 ms CPU. Not measured in workerd. If the first Re-check returns 1102 errors, lower to 20-25. An adversarial 24 KB post took 14.6 ms in `extract` alone (pre-existing, but now run per row in one call). | No |
| F6 | Low | src/alerts.js `alertText` | Estimated rents are shown as exact in the push ("Room · ₹20,000") because `rentEstimated` is not read. Add "about" or a tilde. | No |
| F7 | Info | src/core/logic.js | "1RK studio ... 15000 deposit 45000" gets no rent (unlabelled number; unchanged from before #38). | No |

### Real-device checklist (founder)

1. Deploy is live: Admin -> Alerts -> Test notifications -> "Sample alert" on Android (already confirmed) and once on iPhone from the home-screen icon. Lock screen shows only type, rent, area; tap opens that listing.
2. While Alerts are off globally, sign in as a normal (non-admin) user: bell says alerts are off, no way to add a device.
3. Browse on your phone: tap Like and Reject once each, tap fast twice on one (F1), tap Undo, open Shortlist and Passed, tap Details on a row, tap Like on a Passed row.
4. Turn dark mode on and check the four buttons are readable and the Like pill is clearly the main one.
5. Admin -> Data -> "Re-check all listings": note the counts; open three room posts and confirm the rent label ("Estimated share" when only the total is in the post). Look for whole flats wrongly marked Shared (F3).
6. Press Tab through a card: Reject, Like, Details, Post each get a visible ring.

### Re-check after fixes

Verdict: signed off after the F8 fix (0c315a5) and the senior follow-up (no whole-flat false positives). `npm test` 186 pass, 0 fail (1 skipped); e2e smoke all passed.

- F1 double tap: fixed. `cardAction` sets `data-decided`, `browseClick` ignores decided cards, the leaving card keeps its space; e2e covers it.
- F2 all-decided empty state: fixed. `drawGrid` shows "You've been through every listing" with Shortlist and Passed links.
- F3 "sharing allowed": fixed. "Rent 55000 for 3BHK, sharing allowed for bachelors" gives rent 55000, no estimate.
- Room cases: "Room for rent in my flat ₹15000" and "Room available in 2BHK flat 15000" give 15000; whole-flat posts (28k, 45k, 18k) unchanged.
- F8: fixed in the next commit. "Available room rent" and "room rent" now mark a room in a shared flat, so the bare breakdown gives rent 22000, totalRent 71000 (test added). The real post already gave this because it says "female flatmate".
- F4, F5, F6, F7: unchanged, low or info, not blockers.

## PR #43 listing quality (2026-11-12)

Verdict: signed off. Branch `claude/flat-hunt-listing-quality-qtlfcp`, head bd1fcec on main 6264422.

What I tested:

| Area | How | Result |
|---|---|---|
| Suites | `npm test`; `npm run e2e -- --trace off` (preinstalled Playwright) | 196 pass, 0 fail, 1 skipped; e2e all passed |
| Homepage kinds | Dev server, Green Glen area, 14 realistic posts (sale with crore and EOI, two "looking for" posts, flatmate and "rent out" offers, HSR, Jeevan Bhima Nagar, rooms with attached and common bath, whole 2BHK, PG, "spacious hall", "rent negotiable, ready to occupy") at 390x844 | Sale and both seeking posts hidden; the 11 offers all visible, including the hall and negotiable posts |
| Attached-bath chip | Playwright | Cards show "Attached bath"; chip shows 2 rooms, toggles off to 11, Clear filters resets it (and No brokerage); Details show "Bathroom: Attached to the room"; chip stays on after navigating |
| Area from text | Area filter Green Glen | 9 offers; HSR and Jeevan Bhima Nagar posts absent although the group is "Bellandur Green Glen" |
| Public API | `/api/public/listings` | `bath` present; no phone, URL, map or author text anywhere in the JSON |
| Console and CSP | All Playwright runs | No errors or violations |
| Re-check | New memoryDb script with old-style rows | Room 71000 became 23700 with total 71000 and bath attached (see F2); sale became not_rental, seeking became seeking, HSR area dropped; second run returned null |

Findings:

- F1 (Low) The area picker count ("Green Glen, 10 listings") includes hidden sale and seeking posts, while the list shows 9.
- F2 (Info) "1 room in 3BHK, Rent 71000" with no breakdown shows an estimate of about 23,700 per room, as designed (test 6b). The 22,000 case needs the post to state it.
- Not run: logged-out browser view (dev server has auth off, so I checked the public API only), a real D1 or workerd run.

## PR #45 area picker count (2026-11-12)

Verdict: signed off. Branch `claude/flat-hunt-listing-quality-qtlfcp`, head 1ff656b. Closes F1 from PR #43.

- `npm test`: 197 pass, 0 fail, 1 skipped.
- Repro on a fresh dev DB: Green Glen area; imported a sale post, a seeking post, 3 rental offers (scraper) and 1 rental offer with source `sample`.
- Picker row (390x844) says "Green Glen, 3 listings"; the area view shows 3 cards and "3 listings from 1 group". `/api/public/areas` `listings` is 3 and `/api/public/listings?area=1` returns 3.
- Sale and seeking posts and the sample are in neither the count nor the list. No console errors.
- F1: fixed, closed.

## PR #46 AI extraction thinking off (2026-11-12)

Verdict: signed off. Branch `claude/flat-hunt-listing-quality-qtlfcp`, head bbb746c.

- `npm test`: 199 pass, 0 fail, 1 skipped.
- Scratch script on `memoryDb()` with a fake AI (not committed), 2 tests, all pass:
  - Thinking-only replies (empty content, finish `length`) go retry then failed. `aiStats().failures[].error` is "no answer: the model used the token limit thinking (invalid JSON)".
  - With `requeuedFix` at 0, parse failures are retried and done. A "listing or post gone" failure stays failed. `requeuedFix` becomes 1 and a second run is idle.
  - On a `daily_cap` day (`maxPostsPerDay` 0) nothing is requeued and `requeuedFix` stays 0. The next normal day requeues and reads the posts.
  - Primary model input has `chat_template_kwargs {enable_thinking:false}`. `@cf/openai/gpt-oss-20b` input has `reasoning_effort:'low'` and no template kwargs. No phone digits in either.
- Not run: real Workers AI (does the live model honour the flags), admin AI page in the browser, D1.

## PR #48 location from post text (2026-11-12)

Verdict: not signed off yet. Three Medium findings (F1 to F3) and two Low (F4, F5) for the engineer. Branch `claude/location-extraction-post-text-pbjthl`, head 1e297f3 on main a076fba.

What I ran:

| Area | How | Result |
|---|---|---|
| Suite | `npm test` | 207 tests, 206 pass, 0 fail, 1 skipped |
| Hard constraints | Diff review | No dependencies added; no CSP change; migration 0005 is two new tables plus an index (add-only, no BEGIN/COMMIT, no FTS); `loc_queue` rows are deleted on merge; tests inject every `fetchFn` |
| D1 budget | Throwaway script, 8 listings (6 due) on `budgeted()` | `runLocate` used 7 to 9 statements (LOC_QUERIES 12); cron gate `left() >= 24` is enough |
| Public output | `serializeListing(l, 'public')` with `place` set | No `place`, society, coordinates or map link; `publicListing` is an allowlist |
| Geocoder input | Read `nominatim()`, `findSociety`, `addressAt` | Only `"<society>, Bengaluru"` or lat/lon is sent, plus the User-Agent with `PUBLIC_BASE_URL` |
| `backfillChunk` | 20 keywords (16 patterns after `likePatterns`) | Batch binds 35, 37 and 1 parameters, far below 100; `UPDATE ... FROM` for `loc_queue` runs on node:sqlite (D1 uses SQLite 3.4x) |
| Edge cases | `parseMapUrl`, `resolveMapLink`, `findSociety`, `listingAreas` scripts | See findings |

Findings:

- F1 (Medium) Outbound request to any attacker-chosen host. `src/locate.js:19` `MAP_HOST` allows `google\.[a-z.]{2,8}`, so `google.evil.com`, `google.attack.io` and `google.com.evil.com` pass. Repro: `resolveMapLink('https://google.evil.com/x', fetch)` calls `fetch` on that URL (hop 0 is not a short host, so it is fetched). A poster can make the Worker request their server (leaks the Worker IP and `PUBLIC_BASE_URL` in the User-Agent, and a redirect can keep it going). It cannot reach private networks on Workers, but the allowlist is not an allowlist. Fix: anchor on real Google TLDs (`google.com`, `google.co.in`, a short list) or only fetch the three short hosts and parse full URLs without fetching. `serialize.js:26` uses the same loose pattern but only for masking, so it is harmless there.
- F2 (Medium) Map links reach the model. `src/ai.js:105-106` `redact()` only masks `http(s)://`, `www.`, `maps.app.goo.gl`, `goo.gl`, `wa.me`, `facebook.com`. Repro: `redact('see google.com/maps/place/Sobha+Dream/@12.93,77.72,17z')`, `redact('maps.google.com/?q=12.9,77.7')`, `redact('g.co/kgs/abc')` come back unchanged, with coordinates. Breaks "map links are not sent to the model" and the CLAUDE.md redaction rule. Fix: add `g.co`, `google.<tld>/maps`, `maps.google.<tld>` (the `BARE_LINK` pattern in `src/serialize.js:26` already has them). Add a test.
- F3 (Medium) Wrong place for one-word society names. `src/locate.js:96-103` `findSociety` accepts a hit when every core word is in the label, and `GENERIC` removes "Apartments", "Residency". Repro: `findSociety('Prestige Apartments', ...)` with a Nominatim row "Prestige Falcon City, Kanakapura Road" returns it (`coreTokens('Brigade Residency')` is just `['brigade']`). The address is cached under the society key for 30 days (negative) or forever (positive), tags the listing in the wrong area, and can alert that area's followers. Fix: require two core tokens or a city-wide unique name, or skip brand-only names; keep the "Sai Nest" rule.
- F4 (Low) Backfill ignores "nearby". `src/db/repo.js:309` matches the keyword against raw post text. Repro: listing "2BHK in Bellandur ... 10 min from HSR Layout" with `place.nearby` set; add area HSR Layout and run `startBackfill`: listing gets areas `[1, 2]`, while `listingAreas` gives `[1]`. It stays wrong until the next re-check.
- F5 (Low) Subrequests per run. `src/locate.js:59,135` `maxGeo` caps geocoder calls only; `resolveMapLink` follows up to 4 hops for each of 2 links per listing, 6 listings. Repro with a mock that always redirects to another short link: 53 fetches in one `runLocate` (50 is the Workers Free limit, before AI and Apify calls in the same cron). Normal links use 1 or 2 fetches per listing (12 in my second run), so this only bites with chains. The error is caught and retried, so it is not an outage. Fix: count hops against a per-run fetch budget (for example 20).
- Also noted, not findings: `loc_queue` uses `INSERT OR IGNORE`, so a listing already `done` or `none` is never looked up again if a later post adds a society; `place.guess` is not used by backfill.

Not run (disclosed): live Nominatim, Google and the real model; real D1; browser or e2e (no UI change in this PR).

To re-test after fixes: `npm test`; rerun the F1 to F5 repros above (each is a three-line script on `memoryDb()`/mocked `fetchFn`).

Engineer note (2026-11-12, after the findings above; for QA to re-test):

- F1 fixed: `MAP_HOST` now lists Google's own hosts only (`google.com`, `google.<cc>`, `google.co.<cc>`, `google.com.<cc>`), and only short links (`maps.app.goo.gl`, `goo.gl`, `g.co`) are ever requested; a full Maps URL is parsed, never fetched.
- F2 fixed: `redact()` masks scheme-less `google.*/maps`, `maps.google.*`, `g.co`, WhatsApp and `fb.me`/`m.me` links, and leftover `@lat,lon` coordinates.
- F3 fixed: the hit's own name must not carry identifying words the society name lacks, so "Prestige Apartments" no longer matches "Prestige Falcon City".
- F5 fixed: `runLocate` counts every request and starts no new listing once `MAX_FETCHES` (16) is reached; the rest stay queued.
- F4 not fixed, by choice: the backfill runs as one SQL text scan and cannot apply the AI's "nearby" list. It is a documented limit (ARCHITECTURE §4.4); the listing is corrected at the next re-check.
- Tests: `test/locate.test.js` "QA F1-F5". `npm test` 207 pass. The ingest timing test (`median < 10 ms`) fails intermittently on this sandbox today on `main` as well (10.8 to 15.1 ms in six runs on `origin/main`), so it is machine noise, not this PR.
