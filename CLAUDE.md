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

Browser tasks: use the `agent-browser` MCP server (`.mcp.json`), which gives each session its own private Chrome, not Claude in Chrome. Setup and rules: `docs/AGENT-BROWSER.md`.

## Code map

- `src/worker.js` Cloudflare entry (fetch + scheduled). `src/node-server.js` Node entry for local/Docker (`CRON_ENABLED=1` runs the cron in-process).
- `src/app.js` router, auth gate, user API (`/api/listings`, `/api/browse`, `/api/areas`, `/api/import`, `/api/export`), webhook.
- `src/public.js` public browse API (`/api/public/*`) + per-IP rate limit. `src/serialize.js` role-based output (public allowlist).
- `src/admin.js` `/api/admin/*` (scraper, groups, sources, subreddits, runs, stats, users, settings, listings, phone-scan, ai).
- `src/apify.js` schedule, cutoff, budget guard, start run, sweep, paged dataset ingest, `budgeted()` D1 counter, `scheduledJob()`.
- `src/ingest.js` housing filter, exact dedupe (`post_keys`), fuzzy match on SQL candidates, one batch write.
- `src/reddit.js` Reddit OAuth source. `src/backfill.js` tag stored posts when an area is added. `src/reparse.js` re-check stored listings after a rule change (`RULES_VERSION`). `src/ai.js` AI enrich queue.
- `src/auth.js`, `src/google.js` sessions, password break-glass, Google OIDC. `src/groups.js` Facebook URL checks. `src/http.js` headers/CSP, JSON helpers.
- `src/core/logic.js` regex extraction, dedupe scoring. `src/core/keywords.js` area keyword variants.
- `src/db/repo.js` all SQL. `src/db/drivers.js` D1 and node:sqlite drivers. `migrations/*.sql` schema.
- `web/` static UI (vanilla JS, hash routes, PWA). `test/` node:test suites, `test/helpers.js` gives `memoryDb()`.
- Deep reference: `docs/ai/ARCHITECTURE.md`. Costs: `docs/ai/COSTS.md`.

## Hard constraints (do not break)

1. **Zero npm dependencies.** No `dependencies`/`devDependencies` in package.json. Use Node 22 / Web platform built-ins.
2. **Workers Free limits:** 10 ms CPU per invocation (network/D1 waits do not count), 50 D1 queries per invocation (we budget 48 via `budgeted()`), 50 subrequests, 100k requests/day, D1 100k rows written and 5M rows read per day. Any new work in the cron or webhook must fit the remaining `repo.left()` budget and be resumable.
3. **Push to `main` = production deploy** (GitHub Actions: tests, migrations, deploy, smoke test, auto-rollback). Only the senior engineer pushes (the architect if the senior engineer is busy), after reviewing the exact commits and QA sign-off; if the review finds issues, the engineer redoes the work first. Work on a branch.
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

## Team (AI agents, coordinated by the chief of staff)

- **Chief of staff:** talks to the founder, plans, assigns work, keeps the board current. Spawns agents deliberately and uses cheaper models for simple jobs.
- **Engineer:** builds features and fixes.
- **Senior engineer:** code review and production pushes; helps the architect with hard research.
- **Architect:** research (tools, costs, designs); backup reviewer and pusher.
- **QA:** testing and quality checks; signs off before a push.
- **Designer:** UI specs and mockups.

### Usage rules for the chief of staff (founder, 8 Nov 2026: Claude usage limits run out fast)

The founder's Claude plan is shared by every agent, so the chief of staff manages usage:
1. **One agent at a time.** No parallel agents unless the founder asks for it.
2. **Model by role:** Sonnet for engineer, QA, designer and docs work; Opus only for architect design and senior-engineer review; Haiku for lookups and board updates.
3. **Effort by job:** set `effort` low for mechanical work (board, docs, small fixes), medium for normal builds, high only for design or hard debugging. Never turn on Fast mode.
4. **Small briefs:** one build step per agent (e.g. "steps 1-2", not "the whole feature"), name the exact files to read, and ask for a short report.
5. **Do quick things directly** instead of spawning an agent.
6. **Fresh sessions:** offer a new session for each new, unrelated task; keep this file, the board and memory current so nothing is lost.

## Docs and ownership

- Index and update rules: `docs/README.md`. Who owns which files: `docs/OWNERS.md`.
- Project history and decisions: `docs/HANDOFF.md`. Deploy/secrets: `docs/DEPLOY.md`. Scraper: `docs/APIFY.md`. Design: `docs/DESIGN.md`. Agent browser: `docs/AGENT-BROWSER.md`. AI: `docs/AI-EXTRACTION.md`.
- If you change architecture, data flow, a table, a limit or a cost, update `docs/ai/ARCHITECTURE.md` or `docs/ai/COSTS.md` in the same change, and the matching `docs/human/` page if a user or admin would notice.

## Tracking work

Work is tracked in GitHub Issues + the "Flat Hunt" GitHub Project (setup and conventions: `docs/TRACKING.md`), once the founder approves it. Until then, ask the chief of staff.
- Start work: move the issue to "In progress", label `owner:agent` plus your role label.
- Blocked on the founder: add `owner:founder`, set Status "Waiting on founder", and write the exact question or action in a comment.
- Finished: link the PR/commit (`Fixes #N`), move to "In review" for QA; QA moves it to "Done".
- New idea outside the current task: open an issue with `type:idea`, Status "Ideas". Do not start it.
