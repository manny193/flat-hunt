# Flat Hunt: handoff

Written 8 Nov 2026, covering 6–8 Nov 2026 (updated 8 Nov evening: city-wide homepage and area filter, see D22). The founder is a software engineer in Bangalore (IST) who works at PhonePe, Green Glen Layout, Bellandur. Claude acts as chief of staff and directs specialist agents (SDE, SRE, QA, design head, research analyst). This document is the starting point for whoever picks the project up next.

---

## 1. The problem and the goal

> **Scope (founder, 8 Nov):** Flat Hunt is a flat-hunting app for **any city in the world**, not a Green Glen tool. Green Glen was only the founder's own starting need. **Current focus: Bangalore.** The app pulls in every rental post from Bangalore sources and shows them **all on the homepage**; an **area filter** narrows the list to one area (Green Glen, HSR, Indiranagar…).

- **The problem (the founder's origin story):**
  - The founder needs a new flat in Green Glen Layout (near the office and friends) within 2–2.5 months. He has moved 3 times in 3 years.
  - Brokers are expensive, and NoBroker is full of stale listings.
  - The best fresh listings appear in Facebook flat and flatmate groups, and they get taken fast, so speed matters.
- **His manual routine before this project:**
  - checked Facebook twice a day;
  - used FB Lite because it shows post text before photos;
  - searched "Green glen" and sorted by most recent;
  - waded through the same posts reposted many times.
- **The goal:** a fully automated, free app.
  - Posts are pulled from Facebook groups (and now Reddit) automatically.
  - The homepage shows every rental post in the city (Bangalore for now), newest first, with reposts merged. An area filter narrows it to one area.
  - Signed-in users still follow their own areas: their swipe deck (Review) only holds posts from those areas.
  - Rent, BHK, deposit, brokerage, contact, map link and photos are extracted.
  - The user approves or rejects listings on a swipe deck and tracks a shortlist.
  - It works on iPhone, Android, Mac and Windows.
- **Product direction:**
  - Worldwide, one city at a time. Bangalore is the only city today; the city name is a single constant in the UI (`CITY` in `web/ui.js`). Multi-city is not built yet (see §9.8).
  - Areas are filters inside a city, not the scope of the app: users type area names and the app generates keyword variants.
  - It will be shared with other people: a public browse view, Google sign-in for full details, and an admin role for scrapers and data.

---

## 2. Live system (as of 8 Nov 2026, 11:30 IST)

| Item | Value |
|---|---|
| Repo | github.com/manny193/flat-hunt (private), branch `main`, last commit `132579c` |
| Hosting | Cloudflare Workers Free, Worker name `flat-hunt` |
| URL | `https://flat-hunt.<founder's subdomain>.workers.dev` (Workers & Pages → flat-hunt → Domains & Routes) |
| Database | Cloudflare D1 `flat-hunt`, id `989e4e92-3549-4199-8cc9-2a6bc5f2babe`, migrations 0001–0003 applied |
| Deploys | GitHub Actions on push to `main`: tests, D1 migrations, deploy, smoke test, auto-rollback on failure |
| Cron | Hourly at :00 IST (`30 * * * *` UTC). A scrape starts at the admin's IST run hours (default 6, 9, 11, 13, 15, 17, 19, 21) or every N hours. |
| Scraper | Apify actor `automly~facebook-public-group-posts-scraper` (logged-out, public groups) |
| Cost | ₹0 so far. Apify free plan has $5/month credit and cannot overspend. **This is at risk; see §9.1.** |
| Old prototype | A claude.ai artifact ("Green Glen Flat Hunt"), superseded by the real app |

**Production data on 8 Nov, 11:30 IST:**
- **Runs:** 3 Apify runs succeeded (Nov 7 22:06 IST, Nov 8 ~04:30, ~10:30).
- **Listings:** 94 stored; 2 match Green Glen.
- **Per run:**
  - 84–89 posts fetched;
  - 52 duplicates on the latest run, which costs money (see §9.1);
  - about 16–55 new listings and 8–14 merged reposts;
  - about 7–9 non-housing posts dropped;
  - about 75 posts didn't match the area. They are still stored, by design.
- **Users:** 1 (the founder, via password).
- **Not set yet:** the "require approval" setting, and Google sign-in.

**GitHub configuration.** These are Actions secrets; their values are never stored in the repo or in chat.

| Name | Kind | Status |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | set. Permissions: Workers Scripts Edit, D1 Edit, Account Settings Read. Add **Workers AI: Read** (needed by the AI eval job, possibly by deploy). |
| `CLOUDFLARE_ACCOUNT_ID` | secret | set |
| `APIFY_TOKEN` | secret | set. **The founder pasted an earlier token in chat on 7 Nov; it should have been regenerated. Confirm.** |
| `APP_PASSWORD` | secret | set; must be at least 16 characters (enforced). Also the break-glass admin login. |
| `INGEST_SECRET` | secret | set (random hex; Apify webhook header `X-Ingest-Secret`) |
| `SESSION_SECRET` | secret | set (random hex; HMAC for session cookies) |
| `BACKUP_PASSPHRASE` | secret | set (AES-256 for the weekly encrypted D1 backup; the founder keeps a copy) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret, optional | **not set yet**. Google sign-in stays off until set. |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | secret, optional | **pending**. The founder is creating a "script" app; Reddit API access needs approval. |
| `GROQ_API_KEY` | secret, optional | not set. AI fallback provider. |
| `ADMIN_EMAILS` | variable | **not set yet** (the founder's Gmail) |
| `REDDIT_USERNAME` | variable | to set: `Aggressive-Emu-2467` (used in the Reddit User-Agent) |
| `PUBLIC_RATE_LIMIT` | variable, optional | default 60/min/IP |

Optional secrets are uploaded only when present. A deploy without them still passes.

---

## 3. Key decisions (with why)

| # | Decision | Why |
|---|---|---|
| D1 | **Don't use the official Facebook API.** | The Groups API was removed in Graph API v19 (2024), and admins can no longer install apps on groups. This is why the founder's earlier crawler failed. |
| D2 | **Scrape public groups logged-out, via Apify.** | No account, so nothing to ban. *Meta v. Bright Data* (N.D. Cal., Jan 2024) held that logged-out scraping of public data isn't bound by Meta's terms; India's DPDP Act exempts data the person made public. |
| D3 | **Declined: dummy accounts that get recreated after bans.** | It's ban evasion, the account-holder terms apply, and practically it means SIM churn and checkpoints. Claude refused to build this part. |
| D4 | **Private groups: measure before investing.** | A phone experiment (FB Lite scan on Android, uiautomator2, human-like scrolling, read-only) counts how many Green Glen posts come from groups we don't scrape. If the count is low, drop it; if high, explore further. The script exists; it hasn't been run yet. |
| D5 | **Stack: Cloudflare Workers + D1 + Cron + Static Assets, deployed only from GitHub Actions.** | The only free option that never sleeps and runs our Fetch handler and SQLite schema unchanged. Vercel Hobby allows cron only daily; Render, Koyeb, Fly.io, Oracle and Cloud Run need a card, sleep, or lose the database. |
| D6 | **Zero npm dependencies.** | The build workspace has no package network, and it reduces supply-chain risk. Node 22 built-ins (node:test, node:sqlite, fetch, Web Crypto) are enough. |
| D7 | **Free `workers.dev` domain for now.** | ₹0. A paid domain is the founder's call: `.com` at Cloudflare is about ₹1,000/yr; `.in`/`.xyz` start at ₹90–180 for the first year but renew at ₹500–1,260. Claude can't buy one. |
| D8 | **Apify actor: automly primary, official `apify~facebook-groups-scraper` fallback** (one config value: `APIFY_ACTOR`). | automly costs $1.20/1,000 posts, has a date cutoff, and reports private groups. The official one costs from $2.60/1,000 but has 47K users. memo23 was rejected (1.3★). |
| D9 | **Our cron starts the Apify runs (no Apify Schedule)**, with a per-run webhook and an hourly sweep for missed runs. | Gives a dynamic "posts newer than" cutoff and a budget check before every run. |
| D10 | **Data window:** cutoff = max(last successful start − 15 min, now − `backfillDays`), sent as an exact UTC time without milliseconds (8 Nov; was date-only). backfillDays defaults to 3; admin can set 1–5. | Pay only for new posts. The 15-min overlap covers late admin approvals. |
| D11 | **Budget guard:** read Apify usage before each run. Above 80%, halve posts per group; above 95%, skip runs until the cycle resets. Every run also passes Apify's `maxItems` and `maxTotalChargeUsd` (admin "max spend per run", default $0.50). | Stay inside the $5 credit. |
| D12 | **Store all posts** (not just matching ones), tagged by area at ingest. A new area triggers a backfill scan of stored posts. Retention is 30 days, except shortlisted listings. Applies to every source, including the admin's manual import since 8 Nov (samples aside). | Founder: make it useful for other people and areas. |
| D13 | **Reddit through its official API directly (not Apify).** | Free for non-commercial use, 100 req/min OAuth, adds no Apify cost. Unauthenticated `.json` access has been blocked since mid-2026. |
| D14 | **Three roles: Public / User (Google sign-in) / Admin (`ADMIN_EMAILS`).** Public gets browse with sensitive data stripped on the server. Users get full details and their own deck, shortlist and areas. Admin gets scrapers, data and users. `APP_PASSWORD` is the break-glass admin login. | Founder's decision. The privacy risk of signed-in users seeing third parties' phone numbers was flagged; an admin "require approval" toggle exists (default off, as the founder asked; Claude and QA recommend on). |
| D15 | **AI post-reading: Cloudflare Workers AI** `@cf/google/gemma-4-26b-a4b-it`; auto-fallback to `@cf/openai/gpt-oss-20b`, then Groq `openai/gpt-oss-20b` on quota error 3036. | Free (10k neurons/day, about 1,000 posts/day vs ~150 needed), and no training on our data. Gemini free tier was rejected because Google trains on it; OpenRouter (50/day) and Hugging Face (no free credits) were rejected too. Avoid llama-3.1-8b-instruct-fp8 and qwen3-30b-a3b-fp8 (retired 20 Nov 2026). |
| D16 | **AI privacy:** phones, emails and links are redacted locally before any model call; phones always come from regex. | Third-party PII. |
| D17 | **AI merge rules:** AI wins on kind/type/gender/furnishing/brokerage. Money comes from AI only if the number literally appears in the post AND (regex found nothing OR confidence ≥ 0.7). User edits always win. | AI can't invent numbers. |
| D18 | **Multi-flat broker posts stay one listing (`multiFlat=true`).** After AI corrections, merge automatically only on same phone + same BHK + rent within 2%; otherwise create a merge suggestion on #admin-ai. | Claude's default, open to the founder's view. |
| D19 | **Same phone number doesn't merge listings on its own.** It also needs rent within 2% or overlapping text. | Keeps a broker's different flats apart. |
| D20 | **Renamed Flat Radar → Flat Hunt (`flat-hunt`)** everywhere. | Founder's request. |
| D22 | **City-wide homepage, area as a filter** (8 Nov). Browse with no area returns every stored housing post in the city, including posts that match no area. The area picker (top bar, page heading, and an "All areas" chip at the start of the filter row) offers "All Bangalore" plus every area. The app opens on "All Bangalore"; adding an area no longer switches browse to it. Review/Shortlist stay per-user and area-scoped. | Founder: the app is for the whole city (and later the world), not one area. |
| D21 | **Visual identity: "enamel To-Let board"**: red tin-board rent plate with rivets, and a dashed strip carrying the phone ("••••• / Sign in to call" when logged out). Cool neutrals, blue-slate dark mode, one red. Fonts: Archivo (condensed rent), Atkinson Hyperlegible Next, Atkinson Mono. | Design head's v2. Swipe review, a separate Shortlist and a separate Passed screen were founder requirements. |

---

## 4. Architecture

```
Apify (Facebook public groups) ──run+webhook──┐
Reddit API (OAuth, direct) ──hourly fetch─────┤
Phone scan JSON (admin upload) ───────────────┤
                                              ▼
            Cloudflare Worker  src/worker.js  (fetch + scheduled)
              ├─ hourly cron: sweep missed/partial Apify runs → start new run if due
              │               → Reddit fetch → area backfill → AI enrich → retention purge
              ├─ POST /api/ingest/apify (X-Ingest-Secret) → paged dataset read → ingest
              ├─ ingest: housing filter → exact dedupe (post_keys) → candidate fuzzy match
              │          → store listing → tag areas (listing_match) → enqueue AI (ai_queue)
              ├─ auth: Google OIDC (PKCE) or APP_PASSWORD → __Host- HMAC session cookie
              ├─ browse: no area = all city posts; ?area=<id> narrows via listing_match
              ├─ serializer strips phones/links/maps/authors/society for public
              └─ static UI (web/) via Workers Static Assets, run_worker_first
                                              ▼
                               D1 (SQLite)  ←→  Workers AI (binding AI) / Groq
```

**Limits we design around (Workers Free / D1 Free):**
- 10 ms CPU per invocation (waiting on network or the database doesn't count);
- 50 D1 queries per invocation, with a counted budget of 48 shared across cron steps;
- D1: 5 GB storage, 5M reads and 100k writes per day.
- Hence ingest pages of `INGEST_PAGE_SIZE` = 15 posts (about 4.5 ms measured in Node), 4 pages per webhook call, one dataset per cron tick, and partial ingests resumed from a saved offset.

**Code map** (`/src`):
- `app.js`: the shared request handler.
- `worker.js`: Cloudflare entry. `node-server.js`: Node entry for local/Docker (`CRON_ENABLED=1` runs the scheduler in-process).
- `ingest.js`, `apify.js`, `reddit.js`, `backfill.js`, `ai.js`: data in and AI.
- `auth.js`, `google.js`, `public.js`, `serialize.js`: login and role-based output.
- `admin.js`, `groups.js`, `http.js`.
- `core/logic.js`: extraction (regex). `core/keywords.js`: area keyword variants (up to 8: spaced and joined, suffix kept and dropped, doubled letters).
- `db/{drivers,repo,node-sqlite,fs-migrations}.js`.

**Data model** (migrations 0001–0003, add-only, no BEGIN/COMMIT, no FTS5):

| Table | Purpose |
|---|---|
| `areas` | id, name, keywords JSON, active |
| `listings` | shared: status (legacy), kind, bhk, rent, last_posted_at, data JSON, ai_status, ai_confidence |
| `post_keys` | url key / text hash → listing (exact dedupe) |
| `listing_match` | listing ↔ area join, indexed by (area_id, last_posted_at) |
| `runs` | per source run: dataset_id, report JSON, actor, cost_usd, finished_at |
| `settings` | key → JSON: groups, keywordFilter, schedule, backfillDays, retentionDays, requireApproval, apifyUsage, … |
| `users`, `user_listing`, `user_areas` | accounts and per-user decisions, stages, notes, areas |
| `login_attempts`, `rate_limits` | lockout (5 fails / 15 min per IP) and public rate limit |
| `ai_queue`, `merge_suggestions` | AI work queue and suggested duplicate merges |

**UI** (`/web`: `index.html`, `ui.js`, `app.css`; hash routes, PWA):
- Screens: `#browse`, `#review`, `#shortlist`, `#passed`, `#areas`, `#account`, `#listing-<id>`, plus admin `#admin-scraper`, `#admin-groups`, `#admin-phone`, `#admin-ai`, `#admin-data`, `#admin-users`.
- Navigation: phone uses bottom tabs (admin pages under "Me"); desktop uses a left rail.
- Charts are plain SVG.
- CSP is `script-src/style-src 'self'` (no inline anything) plus Google Fonts.

**CI/CD** (`.github/workflows`):
- `ci.yml`: unit tests, Playwright e2e, a credential-free Worker bundle check, Docker build plus healthcheck.
- `deploy.yml`: on main, CI, then secrets check, D1 create/resolve, migrations, deploy, smoke test (`/healthz` 200, `/api/listings` 401, wrong ingest secret 401), auto-rollback.
- `rollback.yml`: one click, including D1 point-in-time restore within 7 days.
- `backup.yml`: weekly encrypted D1 export, kept 30 days.
- `healthcheck.yml`: daily; alerts if no ingest for over 12 h.
- `ai-eval.yml`: manual.
- Dependabot is on, and every action is pinned to a commit SHA.

**Docker:** `Dockerfile` (node:22-slim, non-root, `/data` volume, healthcheck) and `infra/docker-compose.yml`, for local runs or self-hosting.

**Local commands:** `npm run dev` (auth off, :8787), `npm test` (93 pass, 1 skipped: the real Apify fixture), `npm run e2e`, `npm run ai-eval` (`--online` runs the model).

---

## 5. Sources watched

**Facebook groups** (in production `settings.groups`):
1. Flats and Flatmates Bangalore: facebook.com/groups/flatsandflatmatesbangalorefacebook
2. Flat and Flatmates without Brokers Bangalore: facebook.com/groups/flat.and.flatmates.without.brokers.bangalore
3. Flat & Flatmates Bengaluru: facebook.com/groups/flatandflatmatesbengaluruu
4. FindMyRoom Bangalore: facebook.com/groups/findmyroombangalore (replaced the *Page* facebook.com/FindMyRoomBangalore, which the group actor can't read; Pages are now accepted with a warning and skipped)

Run reports also show posts labelled with other group names ("…Without Brokers", "Bangalore (Decent Homes)"). These are probably cross-posts or renamed groups.

**Reddit** (defaults; active once secrets are set): r/bangalorerentals, r/BangaloreFlatsRental, r/BangloreClassifieds, r/Real_Estate_Bangalore, plus an r/bangalore search for flat / flatmate / rent / bhk over the past week.

**Founder wants about 10 Facebook groups.** Web search can't list more, because Facebook hides groups from search engines. The founder needs to run Facebook's own search for "flat and flatmates bangalore" and paste the links.

---

## 6. Phone experiment (private groups)

- **Files:** `/home/claude/phone-scan/fb_lite_scan.py`, `README.md`, `groups.txt`. Delivered to the founder on 6 Nov; not in the repo.
- **How it works:**
  - Android + USB debugging + `uiautomator2`.
  - The founder runs the FB Lite search himself ("Green glen" → Posts → Most recent).
  - The script scrolls 30–50 posts with random dwell times and reads author, group, time and text, read-only. It saves screenshots and writes `scan_*.json`.
  - Upload under Admin → Phone scans for a report on "X of Y posts from groups we don't scrape".
- **Run `--probe` first.** If FB Lite hides its text from the accessibility layer, use screenshots instead. (Screenshot import used Claude in the artifact prototype and isn't in v2.)
- **Status:** not run yet.

---

## 7. Team and process

- **Chief of staff (Claude):** coordinates, decides defaults, pushes only after QA sign-off. A push to main deploys straight to production.
- **Agents:** SDE (built v1, then the v2 backend, AI and UI), SRE (stack, CI/CD, Docker, DEPLOY.md), QA (2 rounds, verdict "SHIP WITH NOTES" both times; 13 + 7 bugs fixed), Design head (v1 swipe spec, v2 enamel-board DESIGN.md + `docs/mockups/v2.html`), Research analyst (AI models → `docs/AI-EXTRACTION.md` + 32-post eval set `test/fixtures/ai-eval-posts.json`). An Apify specialist couldn't reach Apify from the workspace; Claude did that research from public store pages.
- **Workspace limits:**
  - No package/API network from the build shell. Everything goes live via GitHub Actions.
  - Claude can read and query Cloudflare (Workers, D1) through the Cloudflare connector, but can't deploy or set secrets with it.
  - Claude can push to the repo through the GitHub app.
- **Docs in the repo:** `docs/DEPLOY.md`, `APIFY.md`, `DESIGN.md`, `AI-EXTRACTION.md`, `QA.md`, `OWNERS.md`, this file.

---

## 8. Founder to-do (in order)

1. **Admin → Users → turn on "Require approval"** before sharing the link.
2. **Confirm the Apify token was regenerated** after being pasted in chat.
3. **Add "Workers AI: Read"** to the Cloudflare API token.
4. **Google sign-in:**
   - In Google Cloud Console: create project `flat-hunt` → OAuth consent screen (External, scopes email/profile/openid, publish).
   - Create an OAuth client of type Web, with redirect `https://flat-hunt.<sub>.workers.dev/auth/google/callback`.
   - Add the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` secrets and the `ADMIN_EMAILS` variable, then re-run Deploy.
5. **Reddit:**
   - Create a "script" app at reddit.com/prefs/apps: redirect `http://localhost:8080`, read-only non-commercial description.
   - Complete "register to use the API".
   - Add the `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` secrets and the `REDDIT_USERNAME` variable.
6. **Paste about 6 more Facebook group links.** Since the homepage is now city-wide, Bangalore-wide groups are the better pick; area-focused groups (Bellandur / HSR / Sarjapur / ORR) are cheaper but narrower.
7. **Optional:** run the phone-scan probe and a scan.
8. **Optional:** decide on a paid domain.

---

## 9. Open issues and questions (prioritised)

### 9.1 FIXED 8 Nov (pending deploy): Apify re-buying posts
Root cause confirmed live: the actor rejects milliseconds, so the cutoff fell back to a date. Now exact time, no group rows per run, IST run hours, per-run caps, real run cost and per-group value (docs/APIFY.md "Cost plan"). Remaining limit: at ~1.5 new posts/group/hour, $5/month covers about 4 busy groups; 10 groups ≈ $13/month, 50 ≈ $65/month. **Production `resultsPerGroup` is 100**; the code now caps it at 50; set it to 30 after deploy.

#### Original note
### 9.1 (old) HIGH: Apify spend will exceed the free $5/month at current settings
- Each run fetches about 85–89 posts ≈ **$0.11 per run**; at 6 runs/day that's about **$0.65/day ≈ $19/month**.
- Cause: on 7 Nov the cutoff was changed to **date-only** (`YYYY-MM-DD`) to fix an HTTP 400. Each run now re-fetches everything since midnight UTC of the cutoff day: 52 of 89 posts on the latest run were duplicates we paid for.
- The budget guard will halve fetches at 80% and stop at 95%, so there's no bill, but scraping would pause for the rest of the month.
- **Options:**
  - Check whether the actor accepts a full timestamp. The 400's real reason is now shown in the admin error text, so retry the timestamp once to see.
  - Set `intervalHours` to 8–12.
  - Lower `resultsPerGroup` (25 → 10–15).
  - Prefer area-focused groups.
  - Switch to the official actor if it supports finer cutoffs.
  - Keep Reddit as the free source.

### 9.2 HIGH: AI extraction is failing in production
- Both queued posts ended `failed` after 5 attempts with error **"invalid JSON"**.
- 0 listings have been read by AI; regex extraction still works.
- Likely causes: the model's response shape (Workers AI wraps output, e.g. `response` vs `result`, or JSON-mode isn't honoured by Gemma 4), or Gemma 4 isn't available on Free and the fallback isn't triggered by this error type.
- **Next:** log one raw response (redacted), make the parser handle the Workers AI envelope and fenced JSON, treat "invalid JSON" twice as a reason to switch model, and run `ai-eval --online` (needs the Workers AI Read token).

### 9.3 HIGH (founder decision): open sign-ups expose third-party phone numbers
- Any Google account becomes a user who sees every number.
- Turn on "require approval", or make it the default in code.
- Also decide **retention** (currently 30 days, except shortlisted listings).

### 9.4 MEDIUM: public rate limiter writes one D1 row per public request
- Heavy traffic could use most of the 100k writes/day and starve ingest.
- Move to Cloudflare's rate-limiting binding. The code has a commented `ratelimits` block in `wrangler.jsonc`; check it's available on Free.

### 9.5 MEDIUM: real CPU on Workers is unmeasured
- If logs show CPU-limit errors, set `INGEST_PAGE_SIZE=10`, or Workers Paid at $5/month (founder's call).

### 9.6 MEDIUM: no real Apify sample fixture yet
- Save a redacted export of a real run as `test/fixtures/apify-sample.json`; one test is waiting for it.
- Verify group names and timestamps map correctly (runs show group names arriving).
- The "report" row layout was guessed.

### 9.7 LOW
- The healthcheck passes if no ingest ever succeeded.
- Deleting a GitHub secret doesn't remove it from the Worker (`wrangler secret delete` is needed, e.g. to disable break-glass).
- Lockout is per IP only.
- "20–22k" is read as 22k.
- Fonts are loaded from Google; the founder may want them self-hosted.
- Google sign-in and Reddit are mocked in tests only; verify on first real use.
- Check whether `--var` handles a comma-separated `ADMIN_EMAILS`; otherwise move it to the secrets file.
- The phone-layout check at 375×667 only fits when no banner is showing.

### 9.8 Product questions still open
- **Multi-city:** how to add a second city. Likely a `city` on groups/subreddits and areas, a city picker in the UI, and `?city=` on browse. Not started; Bangalore is hard-wired as the only city.
- **Groups should be city-wide:** now that the homepage shows the whole city, prefer large Bangalore-wide groups over area-only ones (this changes the advice in §8 item 6).
- Should broker multi-flat posts be split into separate listings? (Currently one listing, flagged.)
- Auto-merge vs suggest after AI changes BHK or rent? (Currently strict auto-merge, otherwise suggest.)
- How many Facebook groups, and which, within the budget?
- Paid domain?
- Is the private-group phone method worth it? This waits on the scan results.

---

## 10. Timeline (short)

- **6 Nov:**
  - Research on Facebook access: API dead, logged-out public scraping is viable, dummy accounts declined.
  - Built the single-file prototype tracker (claude.ai artifact) with a regex extractor, dedupe and a swipe UI designed by the design-head agent.
  - Wrote the Android FB Lite scan script.
- **7 Nov morning:**
  - Founder asked for full automation, a free stack, a team of agents, GitHub/Docker/CI-CD.
  - The SRE chose Cloudflare; the SDE built the zero-dependency app.
  - QA round 1 fixed 13 bugs.
  - Rename to Flat Hunt. The founder created the repo, Cloudflare account and secrets.
  - First deploys failed on `APP_PASSWORD` length, then a flaky e2e test; both fixed, and it went live at about 20:27 IST.
- **7 Nov evening:**
  - Loaded Green Glen and 4 groups into D1.
  - Founder asked for roles (public / Google user / admin), admin dashboards, store-all-posts, Reddit, a 3–5-day window and AI extraction.
  - Design v2, the AI research and the SDE v2 build followed, then QA round 2 (7 fixes), pushed at about 22:00 IST.
  - First "Run now" failed with HTTP 400; fixed with a date-only cutoff and Apify error reasons shown, then the run started at 22:06 IST.
- **8 Nov:**
  - 3 scheduled runs succeeded, 94 listings stored, 2 in Green Glen.
  - Found the Apify cost risk (9.1) and the AI failures (9.2).
  - Agent team set up (chief of staff + engineer, QA, designer, architect). Docs for AI (CLAUDE.md, docs/ai/) and humans (docs/human/), tracking plan (docs/TRACKING.md, awaiting founder approval), Finance & budget admin page (#admin-finance) built and QA'd.
  - Apify cost work: live experiment found the millisecond bug; exact cutoff, weekly group details, IST run hours, run caps, run cost and group value built (D10, D11, §9.1).
  - Founder reset the scope: a worldwide flat-hunt app, Bangalore first. Homepage now shows every Bangalore post with an area filter (D22); manual imports keep unmatched posts too. Not deployed yet.
