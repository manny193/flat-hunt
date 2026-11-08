# Flat Hunt: notes for AI agents

Flat Hunt is a free flat-hunting web app. It pulls rental posts from public Facebook groups (via Apify) and Reddit, merges reposts, extracts rent/BHK/deposit/contact, and shows every post in the city on the homepage with an area filter. Signed-in users review posts on a swipe deck and keep a shortlist. City today: Bangalore only (`CITY` in `web/ui.js`). The app stays free for users, so every change must keep running costs at or near zero.

## Commands

Node 22 is not on the default PATH. Prefix commands with it:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm test            # node:test unit + API tests (test/*.test.js), in-memory SQLite
npm run dev         # local server on :8787, auth disabled, node:sqlite (DB_PATH)
npm run e2e         # Playwright smoke; needs playwright installed ad hoc (CI does this), not a repo dep
npm run ai-eval     # regex vs AI extraction eval; --online calls Workers AI (needs CF token)
npm run migrate     # apply migrations to the local SQLite file
```

## Code map

- `src/worker.js` Cloudflare entry (fetch + scheduled). `src/node-server.js` Node entry for local/Docker (`CRON_ENABLED=1` runs the cron in-process).
- `src/app.js` router, auth gate, user API (`/api/listings`, `/api/browse`, `/api/areas`, `/api/import`, `/api/export`), webhook.
- `src/public.js` public browse API (`/api/public/*`) + per-IP rate limit. `src/serialize.js` role-based output (public allowlist).
- `src/admin.js` `/api/admin/*` (scraper, groups, sources, subreddits, runs, stats, users, settings, listings, phone-scan, ai).
- `src/apify.js` schedule, cutoff, budget guard, start run, sweep, paged dataset ingest, `budgeted()` D1 counter, `scheduledJob()`.
- `src/ingest.js` housing filter, exact dedupe (`post_keys`), fuzzy match on SQL candidates, one batch write.
- `src/reddit.js` Reddit OAuth source. `src/backfill.js` tag stored posts when an area is added. `src/ai.js` AI enrich queue.
- `src/auth.js`, `src/google.js` sessions, password break-glass, Google OIDC. `src/groups.js` Facebook URL checks. `src/http.js` headers/CSP, JSON helpers.
- `src/core/logic.js` regex extraction, dedupe scoring. `src/core/keywords.js` area keyword variants.
- `src/db/repo.js` all SQL. `src/db/drivers.js` D1 and node:sqlite drivers. `migrations/*.sql` schema.
- `web/` static UI (vanilla JS, hash routes, PWA). `test/` node:test suites, `test/helpers.js` gives `memoryDb()`.
- Deep reference: `docs/ai/ARCHITECTURE.md`. Costs: `docs/ai/COSTS.md`.

## Hard constraints (do not break)

1. **Zero npm dependencies.** No `dependencies`/`devDependencies` in package.json. Use Node 22 / Web platform built-ins.
2. **Workers Free limits:** 10 ms CPU per invocation (network/D1 waits do not count), 50 D1 queries per invocation (we budget 48 via `budgeted()`), 50 subrequests, 100k requests/day, D1 100k rows written and 5M rows read per day. Any new work in the cron or webhook must fit the remaining `repo.left()` budget and be resumable.
3. **Push to `main` = production deploy** (GitHub Actions: tests, migrations, deploy, smoke test, auto-rollback). Never push without the chief of staff's go-ahead after QA sign-off. Work on a branch.
4. **Migrations are add-only**: new tables/columns only, no `BEGIN/COMMIT`, no FTS5/virtual tables (breaks `d1 export`). Old code must still run on the new schema (rollback safety).
5. **Apify costs money per row.** Never widen the cutoff, raise `resultsPerGroup` above 50, or add group-info rows per run without updating `docs/ai/COSTS.md` and getting founder approval.
6. **CSP is strict**: no inline scripts/styles, no `style=""`. New external hosts need a CSP change in `src/http.js`.

## Privacy rules

- The public (not signed in, or pending approval) must never receive phone numbers, emails, links, map links, author names, society names or post URLs. All listing output goes through `serializeListing()` in `src/serialize.js`; never return raw rows.
- Phones, emails and links are redacted before any AI call (`src/ai.js`). Never send third-party PII to a model or log it.
- Never commit secrets or paste them into docs, issues, or chat. Secrets live only in GitHub Actions secrets.
- Only logged-out scraping of public groups. No Facebook accounts, cookies, or ban evasion (decision D2/D3 in `docs/HANDOFF.md`).

## Testing rules

- Every behaviour change ships with a test in `test/*.test.js` (node:test, `memoryDb()` from `test/helpers.js`). Run `npm test` before handing off; it must be green.
- Mock all network (`fetchFn` is injected everywhere). Tests never call Apify, Reddit, Google, Groq or Cloudflare.
- Privacy and limits have tests (public serializer, D1 budget, CPU-sized pages). Do not weaken them to make a change pass.
- QA owns `docs/QA.md`; fixes found by QA go through the engineer with a note there.

## Docs and ownership

- Index and update rules: `docs/README.md`. Who owns which files: `docs/OWNERS.md`.
- Project history and decisions: `docs/HANDOFF.md`. Deploy/secrets: `docs/DEPLOY.md`. Scraper: `docs/APIFY.md`. Design: `docs/DESIGN.md`. AI: `docs/AI-EXTRACTION.md`.
- If you change architecture, data flow, a table, a limit or a cost, update `docs/ai/ARCHITECTURE.md` or `docs/ai/COSTS.md` in the same change, and the matching `docs/human/` page if a user or admin would notice.

## Tracking work

Work is tracked in GitHub Issues + the "Flat Hunt" GitHub Project (setup and conventions: `docs/TRACKING.md`), once the founder approves it. Until then, ask the chief of staff.
- Start work: move the issue to "In progress", label `owner:agent` plus your role label.
- Blocked on the founder: add `owner:founder`, set Status "Waiting on founder", and write the exact question or action in a comment.
- Finished: link the PR/commit (`Fixes #N`), move to "In review" for QA; QA moves it to "Done".
- New idea outside the current task: open an issue with `type:idea`, Status "Ideas". Do not start it.
