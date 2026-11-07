# Deploying Flat Hunt

Production runs on **Cloudflare Workers (free plan)**: the Worker serves the UI and API,
**D1** stores the listings, a **Cron Trigger** starts the Apify scrape every 4 hours, and
**GitHub Actions** tests and deploys every push to `main`. It costs ₹0 a month, and you don't need a card.

## Architecture

```
 phone / laptop ──HTTPS──► flat-hunt.<you>.workers.dev  (Cloudflare edge)
                               │  every request runs src/worker.js first
                               │  (login check, then web/ assets or /api/*)
                               ▼
                       ┌──────────────┐   D1 binding   ┌───────────────────┐
  Cron 4-hourly ─────► │ Worker       │ ─────────────► │ D1 "flat-hunt"   │
  scheduled()          │ fetch() +    │                │ (SQLite, 7-day    │
                       │ scheduled()  │                │  Time Travel)     │
                       └──────┬───────┘                └───────────────────┘
          start run, then sweep│  ▲  POST /api/ingest/apify (X-Ingest-Secret)
                              ▼  │
                       ┌──────────────┐
                       │ Apify actor  │ scrapes public FB groups
                       └──────────────┘
 GitHub push to main ─► Actions: tests ─► D1 migrations ─► wrangler deploy ─► smoke test
 GitHub schedules     ─► weekly encrypted D1 backup, daily healthcheck (failures email you)
```

Public paths (no login): `/login`, `/api/login`, `/healthz`, and `POST /api/ingest/apify`, which is
protected by the `X-Ingest-Secret` header. Everything else needs a session.

## One-time setup (founder, about 15 minutes)

1. **Cloudflare account**: sign up at dash.cloudflare.com (free, email only). Open
   **Workers & Pages** once. If it asks you to choose a `workers.dev` subdomain, pick one
   (for example your name). Your app will be at `https://flat-hunt.<subdomain>.workers.dev`.
   Copy the **Account ID**: open the account home page, then the "..." menu next to the account name, then **Copy account ID**.
2. **API token**: open **My Profile → API Tokens → Create Token → Create Custom Token**.
   - Permissions (all *Account* scope):
     `Workers Scripts : Edit`, `D1 : Edit`, `Account Settings : Read`
   - Account Resources: *Include → your account only*. Zone resources: none.
   - TTL: 1 year (set a calendar reminder to roll it).
   - If the first deploy fails with an authentication error (code 10000), add the
     permission the error names. As a last resort, use the *Edit Cloudflare Workers* template, which grants broader access.
3. **Apify**: create a free account and copy the API token (**Settings → API & Integrations**).
   See docs/APIFY.md.
4. **GitHub**: create a **private** repo and push this code. Then open **Settings → Secrets and
   variables → Actions → New repository secret** and add these 7 secrets:

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | token from step 2 |
   | `CLOUDFLARE_ACCOUNT_ID` | account id from step 1 |
   | `APIFY_TOKEN` | token from step 3 |
   | `INGEST_SECRET` | random, 32+ chars (generate with the command below) |
   | `APP_PASSWORD` | your login password, 16+ chars (a 4–5 word passphrase is fine) |
   | `SESSION_SECRET` | random, 32+ chars |
   | `BACKUP_PASSPHRASE` | random, 20+ chars. **Also save it in your password manager**, because backups can't be decrypted without it |

   Generate random values with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   (or `openssl rand -base64 32`).
   Optional repository *variables* (same page, Variables tab): `PUBLIC_BASE_URL` (only
   if you add a custom domain) and `D1_DATABASE_ID` (only if you created the DB by hand).
5. **Deploy**: push to `main`, or open **Actions → Deploy → Run workflow**. The first run creates
   the D1 database (APAC location), applies migrations, deploys, uploads the secrets and checks
   that the site is locked. Open the URL shown on the run, log in, and on your phone use
   **Share → Add to Home Screen**.

That's all. You don't need to edit any config files, because `.github/scripts/prepare-wrangler-config.mjs`
finds the database id and URL during each run.

## What runs automatically

| What | When | Where |
|---|---|---|
| Unit + e2e (Playwright) tests, Worker dry-run bundle, Docker build + healthcheck | every PR and every push to `main` | `ci.yml` |
| Apply D1 migrations → deploy Worker + secrets → smoke test → auto-rollback on failure | every push to `main` | `deploy.yml` |
| Start the Apify run first (budget check, "newer than" cutoff, per-run webhook), then sweep one missed or partial run | every 4 h at 06:00/10:00/14:00/18:00/22:00/02:00 IST | Worker `scheduled()` |
| Ingest a finished run | when Apify's webhook fires | `POST /api/ingest/apify` |
| Encrypted D1 export, kept 30 days | Mondays 03:17 IST | `backup.yml` |
| Site up + last ingest < 12 h | daily 08:43 IST, failure emails you | `healthcheck.yml` |
| Action version bumps | weekly PRs | Dependabot |

The smoke test checks that `/healthz` returns 200, that `GET /api/listings` without login returns **401**, and
that the ingest endpoint rejects a wrong secret. If any check fails, the deploy rolls back.

## Security

- **Login**: built-in password login (`APP_PASSWORD`) with an HMAC-signed, `HttpOnly; Secure;
  SameSite=Lax` session cookie (`SESSION_SECRET`). Failed logins are counted per IP in D1
  (`login_attempts`), and repeated failures are locked out. The Worker fails closed: if the secrets
  are missing, every private route returns 503. `AUTH_DISABLED` exists only for local `npm run dev`
  and is ignored by the Worker.
- **Why not Cloudflare Access?** Access (email one-time code, free for up to 50 users) is the
  stronger option, but Cloudflare asks for a payment method when you create the Zero Trust org,
  even on the free plan ("this step is still needed but you will not be charged"). If you're
  happy to add a card, it's a good optional extra layer:
  Zero Trust → Access → Applications → add a *self-hosted* app for
  `flat-hunt.<sub>.workers.dev` (Allow: your email, login method: One-time PIN) **and** a
  second app for path `flat-hunt.<sub>.workers.dev/api/ingest` with a **Bypass** policy, so
  Apify can still reach the webhook. Don't use the Worker's one-click "Protect this Worker"
  toggle, because it covers every path, including the webhook.
- **Webhook**: Apify sends `X-Ingest-Secret`. The Worker compares it in constant time, accepts
  only `POST` JSON under 16 KB, and ingests each `datasetId` once.
- **Secrets**: they live only in GitHub Actions secrets. Every deploy pushes them to the
  Worker with `wrangler deploy --secrets-file` (written to a `umask 077` temp file and
  deleted afterwards). They are never committed, and `.dev.vars`/`.env` are git- and docker-ignored.
- **Least privilege**: the Cloudflare token can only edit Workers scripts and D1 in one account.
  Workflows run with `permissions: contents: read`, checkout doesn't keep credentials, and every
  third-party action is pinned to a full commit SHA.
- **Headers** (set by the Worker on every response):
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.fbcdn.net; connect-src 'self'; manifest-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `Cross-Origin-Opener-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`,
  `Cache-Control: no-store` on HTML and `/api/*`.
- **Backups**: D1 Time Travel gives point-in-time restore for the last 7 days (free). A weekly
  `wrangler d1 export` is gzipped and AES-256 encrypted, then kept 30 days as an Actions artifact.
  A JSON/CSV export from the UI is requested from the app side. Don't add FTS5/virtual tables, because
  `d1 export` can't handle them.

## Rollback

- **Code**: run **Actions → Rollback → Run workflow**. Leave `version_id` blank to go back one version.
  This is instant, but the next push redeploys `main`, so also `git revert` the bad commit and push.
  A failed smoke test rolls back automatically.
- **Data**: in the same workflow, fill `d1_restore_timestamp` (within 7 days) and type `RESTORE`.
  For older data, download a backup artifact, decrypt it (command at the top of `backup.yml`)
  and import it with `wrangler d1 execute flat-hunt --remote --file restore.sql`.
- Write migrations as add-only (new tables/columns), so the previous code version still works
  after a code rollback.

## Rotating secrets

Update the GitHub secret, then run **Actions → Deploy → Run workflow**. The new value reaches the
Worker within a minute.

| Secret | Notes |
|---|---|
| `APP_PASSWORD` | takes effect at the next login |
| `SESSION_SECRET` | logs out every session |
| `INGEST_SECRET` | future runs use the new value, and the 4-hourly sweep catches any run whose webhook used the old one |
| `APIFY_TOKEN` | regenerate in Apify first, then update the secret and redeploy |
| `CLOUDFLARE_API_TOKEN` | use **Roll** on the token page, then update the secret |
| `BACKUP_PASSPHRASE` | keep the old one until the old artifacts expire (30 days) |

## Costs and free-tier limits we live within

Total: **₹0/month.** All limits below were checked on 2026-11-07.

| Service | Free limit | Our use |
|---|---|---|
| Workers requests | 100,000/day | a few hundred (UI + 6 crons + 6 webhooks) |
| Workers CPU | **10 ms per invocation, including cron** | the tight one. Ingest is paged and resumable (see below) |
| Cron Triggers | 5 per account | 1 |
| Subrequests | 50 per invocation | 2–4 per cron run, one per dataset page |
| D1 | 5 GB total, 500 MB/DB, 5M rows read/day, 100k rows written/day, 50 queries/invocation | ~10 MB, <0.5M reads/day |
| D1 Time Travel | 7 days | backups |
| Static assets | unlimited (with `run_worker_first` they also count as Worker requests) | small |
| Workers Logs | 200k events/day, 3-day retention | small |
| GitHub Actions (private repo) | 2,000 min/month | ~150–300 min/month |
| Apify | US$5 credit/month, can't overspend | see docs/APIFY.md |

**About the 10 ms CPU limit**: waiting on network and D1 doesn't count, only JavaScript execution does. To stay inside the
limit, ingest fetches the dataset in pages of `INGEST_PAGE_SIZE` posts (default 25; at most 4 pages per webhook call and one dataset per cron run, to stay under D1's 50 queries per invocation),
filters by keyword first, runs fuzzy matching only against SQL-selected candidates, saves
progress per page, and resumes from the saved offset (on Apify's webhook retry or the next sweep) if an
invocation is cut off. If CPU still proves too tight, the fix is Workers Paid (US$5/month,
30 s CPU per request). That would be the founder's call, and nothing is needed today.

## Domain

The default is free: `https://flat-hunt.<subdomain>.workers.dev`. A custom domain is optional, and buying one is
**your decision**. Prices were checked Oct–Nov 2026, at roughly ₹89 per US$:

| Option | Cost | Notes |
|---|---|---|
| `*.workers.dev` | ₹0 | already included, HTTPS automatic. **Recommended** |
| is-a.dev | ₹0 | GitHub PR, reviewed by volunteers. Gives you DNS records, not a Cloudflare zone, so a Worker custom domain needs extra work. Poor fit |
| eu.org | ₹0 | manual approval that can take weeks or months. You can then delegate it to Cloudflare as a free zone |
| `.com` at Cloudflare Registrar | ~$11.17/yr ≈ ₹1,000/yr, same price at renewal | at-cost, needs a card, attaches to the Worker in one click (**best paid pick**) |
| `.xyz` | ~₹180 first year (Porkbun/Dynadot), then ~₹1,260/yr. Cloudflare: ~₹1,100 then ~₹1,000 | cheap first year, then renewal is the trap |
| `.in` | ~₹90–180 first year on promos, then ~₹510–1,150/yr + 18% GST at Indian registrars | not sold by Cloudflare Registrar, so you'd point nameservers to Cloudflare |

If you add a domain later: Workers & Pages → flat-hunt → Settings → Domains & Routes → Add
Custom Domain. Then set the repository variable `PUBLIC_BASE_URL=https://your.domain` and redeploy.

## Local dev and self-host fallback

- `npm run dev`: node:sqlite with auth disabled, on http://localhost:8787.
- Docker: `docker compose -f infra/docker-compose.yml up --build` uses the same app on Node 22 slim,
  running as non-root, with a `/data` volume for SQLite and a `/healthz` healthcheck. To self-host for real (on any
  VM), keep the port on loopback and put an HTTPS proxy or tunnel in front. Set `CRON_ENABLED=1` so
  the Node server runs the 4-hourly job itself.

## Platforms considered (2026-11-07)

| Option | Free reality | Verdict |
|---|---|---|
| **Cloudflare Workers + D1 + Cron + Static Assets** | 100k req/day, 10 ms CPU, 5 crons, D1 5 GB, no card, never sleeps | **Chosen**. It matches the Fetch-handler + SQLite shape exactly |
| Vercel Hobby + Turso | cron **once per day** (±59 min), so it can't do 4-hourly; Vercel Authentication can protect production but only for Vercel accounts; Turso 5 GB, no card | runner-up. It would need GitHub Actions as the scheduler |
| Deno Deploy + Turso | 1M req/month, 10 CPU-h, sleeps when idle, KV not SQL | workable, but means more porting work |
| Netlify | 300 credits/month, one overrun pauses every project on the account | no |
| Render | sleeps after 15 min, no disk, free Postgres deleted after 30 (+14) days | no |
| Koyeb | one free service (Frankfurt/DC), card + $29 hold | no |
| Fly.io | trial only (2 h or 7 days), card | no |
| Cloud Run | always-free compute, card required, no persistent disk for SQLite | no |
| Oracle Always Free | card, ARM allowance cut in 2026, idle instances reclaimed, you run the VM | no |
| GitHub Actions schedule as ingest runner | min 5 min, can be delayed or dropped, disabled after 60 days of no activity on public repos | backup alerting only |

Sources (accessed 2026-11-07): Cloudflare Workers limits (updated 2026-10-29), Workers pricing
(2026-10-02), D1 pricing and limits (2026-10-30), Queues on free plan changelog (2026-02-04),
Workers + Access docs (2026-11-02), Access policies (2026-11-02), Zero Trust org setup
(2026-04-23, payment step), Wrangler commands docs, D1 import/export (2026-04-21), Vercel cron
usage (2026-07-15), Vercel deployment protection (2026-09-15), Vercel Hobby (2026-09-14),
flaviocopes.com hosting free tiers (checked 2026-09-16), Render free docs, Koyeb pricing FAQ
(2026-05-27), Turso pricing, GitHub Actions events docs, domainoffer.net (.com 2026-11-06, .in
2026-10-26), costgoat.com (.xyz 2026-10-20).
