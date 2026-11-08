# Costs and budget model

Inputs for an admin Finance page and for budget decisions. Researched 8 Nov 2026. Prices are in USD; ₹ figures use ₹89 per US$ (the rate used in `docs/DEPLOY.md`). Items marked **[unverified]** came from secondary sources or are our estimates; check them before they drive a money decision. Re-check every price at least once a quarter and whenever a provider announces a change.

**Bottom line:** at today's 4 groups the app costs ₹0 a month. Hosting stays free up to roughly 10,000 monthly users. The only cost that grows is Apify: about **$1.42 per Facebook group per month**. That means about 3 groups fit in the free $5. 5 or more groups need the Apify Starter plan ($19 a month), and above about 13 groups you pay the usage itself on top of that plan.

## 1. Service table (for the Finance page)

| Service | What we use it for | Free allowance | Unit price beyond free | How to measure our usage | Cost formula (per month) |
|---|---|---|---|---|---|
| **Apify platform: Free plan** | Runs the Facebook scraper | $5 usage credit / month. Cannot overspend: runs are blocked until the next cycle | n/a (upgrade instead) | `GET https://api.apify.com/v2/users/me/limits` (cycle usage vs limit; already cached in `settings.apifyUsage`); `GET /v2/users/me/usage/monthly` for a breakdown | `0` while usage ≤ $5 |
| **Apify: Starter plan** | Same, when the $5 is not enough | $19 / month ($17 billed yearly) includes $19 usage | Usage above $19 is billed, up to a usage limit you set (page says max $100 on Starter) | same | `max(19, apify_usage)` (cap at the limit you set) |
| **automly Facebook group posts actor** (`automly~facebook-public-group-posts-scraper`) | Scrapes posts from public groups, logged out | none (paid out of the plan credit) | **$1.20 per 1,000 dataset rows** (posts, and group rows when we ask for group info) + **$0.00005 per run start**. Same price on every paid plan. Plus Apify platform usage, measured at ≈ $0.00015 for a 10-post run | per run: `GET /v2/actor-runs/{id}` (`usageTotalUsd`, `chargedEventCounts`); ours: sum of `runs.cost_usd` (already computed by `runCost()`) | `rows × 0.0012 + runs × 0.00005 + platform` (see §2) |
| Official Apify actor (`apify~facebook-groups-scraper`), fallback only | Backup if automly breaks | none | $5.00 / 1,000 posts on Free, $4.00 on Starter; "from $2.60" on higher plans **[tier for $2.60 unverified]** | same | `posts × 0.004` on Starter: about 3.3× automly |
| **Cloudflare Workers: Free** | Hosts the app, API, hourly cron | 100,000 requests/day; 10 ms CPU per invocation; 50 subrequests; 5 cron triggers. Static asset requests are free, but with `run_worker_first` every request runs the Worker | n/a (upgrade instead) | Cloudflare dashboard → Workers & Pages → flat-hunt → Metrics; or GraphQL Analytics API (`https://api.cloudflare.com/client/v4/graphql`), dataset `workersInvocationsAdaptive` (requests, cpuTime) | `0` |
| **Cloudflare Workers: Paid** (only if needed) | Lifts CPU, request and D1 limits | $5 / month minimum includes 10M requests and 30M CPU-ms | $0.30 per extra million requests; $0.02 per extra million CPU-ms | same | `5 + max(0, req − 10M) × 0.30/1M + max(0, cpu_ms − 30M) × 0.02/1M` |
| **Cloudflare D1** | Database | Free: 5M rows read/day, 100k rows written/day, 5 GB total, 500 MB per database, 50 queries per invocation, 10 databases, 7-day Time Travel | On Workers Paid: 25B reads/month and 50M writes/month included, then $0.001 per million reads, $1.00 per million writes, $0.75 per GB-month above 5 GB; 10 GB per DB, 1,000 queries per invocation, 30-day Time Travel | dashboard → D1 → flat-hunt → Metrics; GraphQL datasets `d1AnalyticsAdaptiveGroups` (rowsRead, rowsWritten) and `d1StorageAdaptiveGroups` (databaseSizeBytes) | Free: `0`. Paid: included at our size |
| **Cloudflare Workers AI** | Reads posts (Gemma 4 26B, gpt-oss-20b fallback) | 10,000 neurons/day (also on Free) | $0.011 per 1,000 neurons above the free 10k/day, **only on Workers Paid** (on Free, calls fail with error 3036 and we fall back to Groq) | app counts it: `settings.ai.neurons` (shown on `#admin-ai`); dashboard → AI → Workers AI. GraphQL dataset for AI **[name unverified]** | `max(0, neurons_per_day − 10,000) × 30 × 0.011/1000` |
| Workers Logs | Debug logs | Free: 200k events/day, 3-day retention | Paid: 20M events/month included, then $0.60 per million. **From 1 Dec 2026 Logs move to "Cloudflare Observability" pricing [new pricing not yet checked]** | dashboard → Observability | `0` at our volume |
| **Web Push** (Google FCM, Mozilla autopush, Apple Push, Windows WNS) | Area alerts to browsers and installed PWAs (`src/alerts.js`, docs/ai/ALERTS-WEBPUSH.md) | Free with VAPID keys; no account, no per-message price | none | `#admin-alerts` (pushes today, devices, failures; `settings.alertsRun`) | `0` |
| **Groq** (optional AI fallback, `GROQ_API_KEY` not set yet) | Backup model when Workers AI quota is used up | Free tier for `openai/gpt-oss-20b`: 30 req/min, 1,000 req/day, 8k tokens/min, 200k tokens/day (≈ 300 posts/day) | not used (we stay on free) | Groq console → Usage; app counts `settings.ai.groqTokens` | `0` |
| **Reddit Data API** | Second post source (code ready, not connected) | Free for non-commercial use, 100 queries/min with OAuth **[secondary sources]**. Access needs approval under Reddit's Responsible Builder Policy. Some reports say new requests closed on 31 Oct 2026 **[unverified, may block us]** | Commercial use needs a contract; no public price | `settings.reddit` run log (`#admin-scraper`) | `0` |
| **Reddit public JSON** (no key) | Reddit source without API access: `old.reddit.com/r/<sub>/new.json`, 1 request per subreddit per run, 2 s apart | $0. **Unverified risk:** Reddit may block Cloudflare Worker IPs (403/429/HTML); we stop and back off 6 h after 3 failures and never work around a block. **ToS risk:** reading without the Data API is against Reddit's terms for automated access; the founder accepted this risk (HANDOFF D23) | `settings.redditStatus` (admin) | `0` |
| **GitHub** (private repo, Free personal account) | Code, Actions CI/CD, backups, Issues/Projects | Actions: **$12/month of included compute ≈ 2,000 Linux minutes** (GitHub now states it in dollars); 500 MB artifact/package storage; 10 GB cache per repo. Issues and Projects: free | Linux 2-core $0.006/min; artifacts $0.25/GB-month. Without a payment method on file, usage stops at the allowance (no bill) | `gh api /users/manny193/settings/billing/usage` **[endpoint for the new billing platform; verify]**; or github.com → Settings → Billing | `max(0, linux_min × 0.006 − 12)`; our estimate ≈ 500–700 min/month → `0` |
| **Google sign-in (OAuth / OIDC)** | User login | Free. With only `openid email profile` (non-sensitive scopes) no verification review is needed **[no official price page; based on Google docs on verification and secondary sources]** | none | Google Cloud console → APIs & Services → OAuth consent screen | `0` |
| **Domain** | Web address | `flat-hunt.<sub>.workers.dev` is free, HTTPS included | `.com` at Cloudflare Registrar (at cost): ~$10.46/yr until Oct 2026; Verisign raised the .com wholesale price on 1 Nov 2026, so expect ~$11.17/yr (≈ ₹1,000) **[post-1-Nov price unverified]**. `.in`: ~₹90–180 first year, then ₹510–1,150/yr + 18% GST (from `docs/DEPLOY.md`, checked Oct 2026) | registrar invoice | `price_per_year / 12` |

Card note **[unverified]**: Apify and Cloudflare bill in USD. An Indian card usually adds a 2–3.5% forex markup (plus GST on that markup). Add about 4% to USD costs for the real rupee amount.

## 2. Apify cost model

Production measured about **1.5 new posts per group per hour** (HANDOFF §9.1). The scraper pays for every row it returns, so cost follows the number of new posts. How often it runs barely matters.

Per group per month (730 hours):
- New posts: 1.5 × 730 = **1,095 rows**.
- Overlap re-buys: each run's cutoff is the last start minus 15 minutes, so ~0.375 posts per group are bought twice on each run. With 8 runs a day that is ~3 a day, or **~91 rows**. They are deduped for free in `post_keys`, but we still pay for them.
- Group info rows: weekly, ~4 rows. Negligible.
- **Total ≈ 1,190 rows × $0.0012 = $1.42 per group per month.**

Fixed per month: 8 runs/day × 30.4 days = 243 runs × $0.00005 = $0.01 for run starts, plus platform usage of roughly $0.0005 per run, about $0.12 **[estimate, scaled from the $0.00015 measured on a 10-post run]**.

Formula for the Finance page:
```
apify_usage_usd = groups × posts_per_group_hour × 730 × (1 + overlap_share) × 0.0012
                + runs_per_month × (0.00005 + platform_per_run)
overlap_share   = (15/60) × runs_per_day / 24        # 0.083 at 8 runs/day
plan_cost_usd   = apify_usage ≤ 5  → 0 (Free)
                  otherwise         → max(19, apify_usage)   (Starter; set a usage limit)
```
Real usage replaces the estimate once runs exist: `sum(runs.cost_usd)` for the current Apify cycle, or `users/me/limits`.

Ways to cut it:
- Drop "Low value" groups. Admin → Groups already flags them.
- Shorten the 15-minute overlap. It is about 8% of cost; 5 minutes would still cover most late posts. Admin setting `schedule.overlapMin` (default 15; set 5 to save about 5%).
- Turn on the group plan (Admin → Group performance, `docs/ai/GROUP-SCHEDULING.md`). It never raises spend: a daily allowance of min(budget, Apify limit) × 95% over the days left caps every tick, and the money moves to groups with the best usable yield. Extra cost of the plan itself: up to 3 actor runs per slot instead of 1 (≈ $0.0005 each, worst case ≈ $0.37 a month, typical ≈ $0.18), and new groups' trials (≤ $0.15 each, about $0.08 a week for a busy group). No change to `resultsPerGroup` (still ≤ 50) or the cutoff floor. D1: one extra statement per planned ingest, ~11 statements once a day for the allocator.
- Prefer groups with fewer reposts.
Running less often does **not** save money. It only makes posts arrive later.

## 3. Monthly scenarios: Facebook groups (Bangalore)

Assumptions: 1.5 new posts per group per hour, 8 runs a day, automly actor, Workers Free, AI only on followed areas (≤ 300 posts/day, which fits the free neurons).

| Groups | New posts / day | Apify usage / month | Plan that covers it | **Total / month** | Notes |
|---|---|---|---|---|---|
| 4 (today) | 144 | ~$5.8 | Free covers ~85% | **$0** | The budget guard halves posts per group at 80% and stops runs at 95%, so the last ~4 days of each cycle get few or no Facebook posts |
| 5 | 180 | ~$7.2 | Free runs out around day 20; or Starter | **$0** (gap of ~10 days) or **$19 (≈ ₹1,700)** | 3 groups (~$4.4) is the most that fits in Free all month |
| 10 | 360 | ~$14.4 | Starter (included $19) | **$19 (≈ ₹1,700)**; $17 billed yearly | Starter covers up to ~13 groups |
| 25 | 900 | ~$35.7 | Starter + ~$16.7 usage | **~$36 (≈ ₹3,200)** | Set the Starter usage limit to ~$40 |
| 50 | 1,800 | ~$71.3 | Starter + ~$52 usage | **~$71 (≈ ₹6,300)** | 50 is the code's maximum (`validateGroups`). Check D1 purge capacity (§5) |

The same scenarios with the official actor at Starter's $4.00 per 1,000 rows would cost about 3.3 times as much: 10 groups ≈ $48, 50 ≈ $238.

## 4. Monthly scenarios: users

Scraping is shared, so the number of users barely changes the bill. What users do use is Workers requests and D1 reads and writes. Assumptions **[estimates]**: each monthly user visits 4 times a month. A visit makes ~12 Worker requests (6 asset files plus ~6 API calls), because `run_worker_first` sends every asset through the Worker. Each public API call writes 1 row to `rate_limits`. A browse query reads ~200 rows on average; a narrow rent/BHK filter can scan most of `listings`. Busy days are 3× the average.

| Monthly users | Worker requests / day (avg / busy) | D1 writes / day from users (busy) | D1 reads / day from users (avg / busy) | Fits Workers Free? | Cost / month |
|---|---|---|---|---|---|
| 100 | 16 / 50 | ~50 | ~3k / 10k | Yes, easily | $0 |
| 1,000 | 1.6k / 4.8k | ~2.4k | ~0.3M / 1M | Yes | $0 |
| 10,000 | 16k / 48k | ~24k | ~3M / **~10M** | Requests yes (< 100k). **D1 reads: no on busy days** (5M/day limit), and writes get tight once ingest is added (§5) | $0 if traffic is spread out and public browse is cached; otherwise **Workers Paid $5 (≈ ₹450)**, with usage well inside its included amounts |

Signed-in users cost more reads than the public, because `GET /api/listings` loads the user's whole deck. At 10,000 users, measure first, then choose between:
- (a) caching public browse at the edge with the Cache API (free, but an engineering change);
- (b) Workers Paid at $5 a month, which includes 25B reads.
CPU per request (10 ms) is the other unknown. Serialising 30 listings with the privacy regexes has not been measured on Workers (HANDOFF §9.5).

## 5. Ingest load on D1 (grows with groups)

Estimate **[unverified; D1 counts index updates as written rows]**:
- A new listing writes about 12 rows: the listing and its 3 indexes, 2 `post_keys` and their index, `listing_match` and its 2 indexes, and `ai_queue`.
- A merge writes about 6 rows.
- The daily purge deletes about the same number of rows later.

| Groups | Ingest + purge writes / day | Listings kept (30-day retention) | DB size |
|---|---|---|---|
| 10 | ~9k | ~6k | ~30 MB |
| 25 | ~22k | ~16k | ~80 MB |
| 50 | ~43k | ~32k | ~160 MB (limit 500 MB per DB on Free) |

**Finding for the engineer:** `repo.purgeOld()` deletes at most **500 listings per day**. At about 60% of new posts becoming new listings, 25 groups create ~540 listings a day and 50 groups ~1,080. Above ~23 groups the purge falls behind, and the database grows without limit. At 50 groups it would reach the 500 MB Free cap in roughly 7–8 months. Raise the cap or run the purge in more than one tick before going past ~20 groups.

## 6. Other running costs today

| Item | Today | Note |
|---|---|---|
| Workers AI | ~0–3k neurons/day (well under 10k) | Production AI currently fails with "invalid JSON" (HANDOFF §9.2), so real use is ~0 |
| GitHub Actions | ~500–700 min/month estimated, out of ~2,000 | Many agent pushes in a day add up: each push runs CI + deploy (~15 billed minutes). Making the repo public would make Actions free, but it is a privacy decision |
| Backups | weekly artifact, 30 days | far below 500 MB |
| Area alerts (Web Push) | $0 | Second Cron Trigger `*/10 * * * *` (2 of 5 free): +144 invocations/day, 2 D1 queries when idle, ≤ 10 and ≤ 40 push subrequests when sending, est. < 3 ms CPU. +1 D1 statement per ingest call (enqueue). Each notification = 1 Worker request + ~4 D1 queries (inbox). ≈ 3,000 queue rows written/day at 1,000 alert users (< 3% of the 100k/day write limit). Caps: 2,000 pushes/day (`settings.alerts.maxPushesPerDay`). No Apify impact |

## 7. Finance page: what the engineer needs

Live (APIs the Worker can call):
- **Apify**: `users/me/limits` (already fetched and cached as `settings.apifyUsage`) and `sum(runs.cost_usd)` per cycle. Both need no new secret.
- **Workers AI**: `settings.ai` (neurons today, posts, Groq tokens). No new secret.
- **Cloudflare requests and D1 rows**: GraphQL Analytics API. This needs a new read-only token with "Account Analytics: Read" stored as a Worker secret. **Founder decision**, because it adds a secret. An alternative without a secret: count requests and D1 statements in-app per day (approximate).
- **GitHub Actions minutes**: needs a GitHub token in the Worker. Simpler to show as a manual monthly figure.

Fixed values to store in settings (admin-editable): Apify plan (Free/Starter), Starter usage limit, Workers plan (Free/Paid), domain cost per year, ₹/$ rate, posts per group per hour (measured: count of `runs.report.newByGroup` over 7 days).

Page formula:
```
monthly_usd = apify_plan_cost(apify_usage)
            + (workers_paid ? 5 + overages : 0)
            + (workers_paid ? ai_neurons_over_free × 0.011/1000 : 0)
            + max(0, actions_minutes × 0.006 − 12)
            + domain_per_year / 12
monthly_inr = monthly_usd × inr_per_usd × 1.04   # card forex allowance
```

## Sources (accessed 8 Nov 2026)

- Cloudflare Workers pricing (updated 2 Oct 2026): https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers limits (updated 29 Oct 2026): https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 limits (updated 30 Oct 2026): https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare Workers AI pricing (updated 20 Oct 2026): https://developers.cloudflare.com/workers-ai/platform/pricing/
- Apify pricing: https://apify.com/pricing
- automly actor: https://apify.com/automly/facebook-public-group-posts-scraper
- Official Facebook groups actor: https://apify.com/apify/facebook-groups-scraper
- Our live Apify experiment (row billing, platform cost, ms cutoff): `docs/APIFY.md` "Cost plan"
- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- Groq rate limits: https://console.groq.com/docs/rate-limits
- Reddit API status in 2026 (secondary): https://apiserpent.com/blog/free-reddit-api , https://www.keyapi.ai/blog/reddit-data-api-overhaul-major-changes-and-migration-guide/ (Reddit's own help page returned 403 to our fetch)
- Google OAuth verification (secondary): https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification , https://ssojet.com/ciam-qna/google-oauth-consent-screen-issues-verification-requirements
- Cloudflare Registrar (at cost): https://www.cloudflare.com/products/registrar/ ; .com price: https://domainoffer.net/tld/com/cloudflare
- Production post rate (1.5 / group / hour): `docs/HANDOFF.md` §9.1
