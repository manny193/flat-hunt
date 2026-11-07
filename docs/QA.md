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
