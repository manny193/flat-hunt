# Watching 10+ Facebook groups on the Apify free $5

Design note, 8 Nov 2026. Status: proposal, nothing built. Inputs: `docs/ai/COSTS.md`, `docs/APIFY.md` "Cost plan", `src/apify.js`, `src/admin.js` (`groupValue`, `LOW_VALUE`). Figures marked **[est]** are our estimates, not measurements. Check them against `runs.report` after one week of data.

## 1. Answer first

- **$5 buys about 3,800 dataset rows a month, whatever the number of groups.** Rows are the only real cost: $0.0012 each. A busy group (1.5 new posts an hour) uses about 1,125 rows, or $1.35, a month. So $5 fully covers **about 3 busy groups**. Today's 4 groups already overrun it (about $5.8).
- **10, 15 or 20 groups fit in $5 only as a sample.** Each group then gets 33%, 22% or 17% of its posts. Or they fit fully if the groups are quiet: the break-even is 0.50, 0.33 and 0.25 posts an hour per group.
- **More groups do not buy more listings. They buy a better choice of groups.** Total listings stay near 1,700 a month (3,770 rows x 45% usable **[est]**). The gain is in finding the groups with high usable-post rates and few cross-posts, then moving the money there. That matches the founder's goal: watch many, keep the best.
- **Frequency per group is a freshness feature, not a cost feature.** Your insight holds: each post is bought once, so reading a quiet group less often saves almost nothing (section 3).
- **Honest correction to idea (a):** we cannot avoid buying non-housing posts, duplicates, seeking posts or off-city posts one by one. The actor charges for each row it returns, and a search link or keyword is ignored (APIFY.md). We only see what a post was after we have paid for it. Idea (a) therefore turns into choosing groups well, which is (b).

## 2. Cost model

Constants: row $0.0012; per run about $0.0005 (start $0.00005 plus platform; 0.00015 was measured on a 10-post run, COSTS.md uses 0.0005 **[est]**); stop guard at 95%.

| Item | Per month |
|---|---|
| Credit | $5.00 |
| Keep unspent (stop guard at 95%) | -$0.25 |
| Runs: about 1.5 actor runs per slot x 8 slots x 30.4 days = 365 x $0.0005 | -$0.18 |
| Group details rows, weekly, 10 groups | -$0.05 |
| **Left for posts** | **about $4.52 = 3,767 rows = 124 rows a day** |

Cost of a group per month at rate r posts an hour: `r x 730 x (1 + overlap share) x 0.0012`.
- Overlap today: 15 min x 8 runs a day: about 91 rows a group a month, 8% of the cost.
- Overlap at 5 min: about 30 rows. That saves 61 rows ($0.07) a group, about 5%.
- A busy group (1.5 an hour): 1,125 rows = **$1.35**. A medium group (0.8): $0.72. A quiet group (0.3): $0.27.

Break-even posts an hour per group, if all groups are covered fully: `3,767 / (N x 750)`:

| Groups N | Break-even rate | Full coverage at 1.5 an hour would cost | Coverage the $5 allows at 1.5 an hour |
|---|---|---|---|
| 3 | 1.67 | $4.1 | 100% |
| 10 | 0.50 | $13.7 | 33% |
| 15 | 0.33 | $20.4 | 22% |
| 20 | 0.25 | $27.2 | 17% |

Groups are not equal. If the real mix is 2 hot (2 an hour), 4 normal (1) and 4 cold (0.3), 10 groups need about 6,900 rows, $8.3. That is still over, so sampling still applies, just less of it.

**Listings per $5.** Usable rate (new listing per row) is the number that matters. A row is not usable when the post is non-housing (10-20%), a duplicate or cross-post, a seeking post, or off-city. Assume 45% usable **[est]**, so 3,767 rows give about **1,700 listings a month, 56 a day**. Moving to groups with 55% yield gives about 2,100. The existing `LOW_VALUE` flag fires below 15% and is too loose to steer money; the allocator below ranks all groups by yield instead.

## 3. What per-group frequency does and does not do

Cost = rows + runs. A post is bought once whenever it is read, as long as the cutoff is exact.

- Reading a group 2 times a day instead of 8 saves overlap rows only. For a quiet group (0.3 an hour, 5 min overlap) that is about 3 rows a month. Run cost is shared, because groups ride in the same actor run.
- It does change **freshness**. A post is seen on average half a gap after it is posted. Rentals go in hours, so hot groups deserve short gaps; a cold group can wait.
- It reduces ingest invocations a little (fewer rows per slot).

So tiers by frequency are worth building only as a cheap by-product of cohorts (section 5). They are not the savings lever.

**The one frequency-linked lever that does cut rows is a lookback window** (call it SAMPLE mode). The actor never returns posts older than `postsPublishedAfter`, so we never pay for them. If a group is read in two slots a day (say 13:00 and 21:00 IST) with `cutoff = now - 3 h` instead of the last read, we buy only the 3 hours before each read: coverage 25% by time (more by posts, as the afternoon and evening are the peak). Cost falls in proportion. The posts skipped are the older ones in the gap, the least valuable for rentals. This is the knob that makes 10-20 groups fit.

## 4. The design

### 4.1 Per-group state

One settings key `groupState`, keyed by group id (`groupId(url)`):

```
groupState[gid] = {
  status: 'trial' | 'active' | 'sample' | 'paused',
  since: <ms>,                  // trial start
  lastRead: <ms>,               // exact start of the last run that read this group and ingested ok
  mode: 'full' | 'sample',
  lookbackH: 3,                 // sample only
  tier: 'hot' | 'normal' | 'cold',
  rate: <rows per hour, 7 d>,   // from runs.report.fetchedByGroup
  yield: <usable / rows, 7 d>,  // from newByGroup / fetchedByGroup
  echo: { of: <gid>, share: 0.6 } | null,
  pausedWhy: 'low yield' | 'echo' | 'budget' | 'manual' | null
}
```

`settings.groupPlan` is the admin policy: `{ enabled:false, trialDays:7, trialMaxUsd:0.15, minYield:0.25, echoShare:0.6, sampleFloor:0.15, reservePct:10, budgetUsd:null }`. **`enabled` defaults to false.** With it off, `startRun` behaves exactly as today: one run, all active groups, cutoff from the last good run. That makes the deploy safe and the feature opt-in.

### 4.2 Per-group cutoff and cohorts

The actor takes **one** `postsPublishedAfter` per run. So per-group cutoffs mean one run per distinct cutoff. We group due groups into **cohorts** that share a cutoff:

- FULL group: `cutoff = lastRead - overlap` (overlap 5 min, setting).
- SAMPLE group: `cutoff = max(lastRead - overlap, now - lookbackH)`, with `lookbackH` taken from a short ladder (3, 6, 12) so cutoffs collapse into few cohorts.
- New or just-resumed group (no `lastRead`): `cutoff = now - 6 h` (trial lookback), its own cohort.
- Groups read in the same slot have the same `lastRead`, so they share a cutoff for free. A cohort splits only when a group is added, resumed or changes mode.
- Hard cap: **at most 3 cohorts per cron tick**. Extra groups wait for the next slot. Expected average is 1.5 a slot.

`lastRead` is written only when that run's dataset ingests to `done` (not at start), so a failed run never skips posts. The existing truncated-run recovery works per cohort: store the cohort's group ids and `after` in `caps` and re-read that window once.

### 4.3 Tiers (freshness)

Tier is by usable posts per 6 h per group, from `groupState.rate x yield x 6`:

| Tier | Usable per 6 h | Read |
|---|---|---|
| hot | 4 or more | every slot (8 a day, IST hours 6-21) |
| normal | 1.5 to 4 | every second slot (4 a day) |
| cold | under 1.5 | 2 a day (13:00 and 21:00), SAMPLE if the budget needs it |

Cohorts then fall out naturally: hot+normal groups read on the same slots share a cutoff.

### 4.4 Monthly allocation by yield

Run once a day (at the daily purge tick), and on any admin change.

1. `B` = what is left to spend this cycle: `min(settings.budget, Apify limit) x 0.95 - spent - fixed run cost`. Per day: `A = B / daysLeft`. This **replaces the 80%/95% halve-then-stop guard**, which leaves the last days of the cycle dark. A daily allowance keeps all days alive.
2. Reserve `reservePct` (10%) of `A` for trials.
3. For each active group: `value = yield / 0.0012` (listings per $). Smooth yield with a prior: `yield = (usable + 0.35 x 20) / (rows + 20)`, so a group with 15 rows is not ranked on noise.
4. Sort by value descending. Give coverage `c = 1` (FULL) to groups in order while `sum(rate x 24 x c) <= A`. The next group gets the remainder as partial coverage (SAMPLE with `lookbackH` set to match). Groups after that get `sampleFloor` (15%) until the money is gone, then `paused (budget)`.
5. Echo rule (4.6) before ranking: an echo group's value is capped at its unique yield.
6. Each cohort's `maxItems` = sum of its groups' per-run allowance (`rate x gap x c`, plus 20% slack, minimum 5), and `maxTotalChargeUsd` = `maxItems x 0.0012 x 1.2`. Apify enforces the hard stop even if the actor misbehaves.

Hysteresis: a group changes mode at most once a week, and only when the new value differs by 25% or more. Otherwise cohorts churn.

### 4.5 Trial for new groups

A new group enters `trial` for `trialDays` (7).
- Mode SAMPLE, 6 h lookback, 2 reads a day, hard cap `trialMaxUsd` $0.15 (about 125 rows). At 1.5 an hour it costs about $0.08 for the week. **A 10-group trial costs under $1.**
- After 3 days with 20+ rows: pause early if `yield < 0.10`.
- At day 7: `active` if `yield >= minYield` (25%) and not an echo; else `paused (low yield)` or `paused (echo)`.
- Admin sees a countdown and the sample numbers, and can promote or pause by hand. A manual choice is never overridden (`pausedWhy: 'manual'`).

### 4.6 Cross-post detection

Today `ingestItems` counts `dupes` and merges, but not which group the first copy came from. Add to the run report:

- `mergedByGroup[g]`: rows from group `g` merged into an existing listing or exact-key duplicate.
- `crossFrom[g][g2]`: of those, how many matched a listing first created by group `g2`. Needs the listing's source group on a candidate (`listings` already stores the group name for the card; verify the column and that exact-key dupes via `post_keys` can resolve it with one extra column read).

Per group over 7 days: `echo.share = merged-from-other-groups / rows`. If `share >= echoShare` (0.6) and `echo.of` has the higher unique yield, the group is an echo. Pause the echo (or sample it at the floor).

Caveat: within a dataset, order decides who is "first". Compare pairs symmetrically (overlap of A with B vs B with A) and pause the partner with the lower rate. Do not trust a single run.

### 4.7 How it fits Workers Free

- **Actor runs per tick:** up to 3 (one per cohort), not one per group. 10-20 groups still start 1-3 runs. Each start is one subrequest (limit 50). Apify Free concurrent-run and memory limits (assumed 8 GB total) must be checked; automly's default memory is unknown **[verify]**.
- **D1 statements per tick (cap 48):** `getSettings` 1 (it already returns `groupState` and `groupPlan`), `putSettings` for usage and scheduler 1 batch, `recordStartedRun` 1 per cohort (max 3). The planner is pure in-memory code. `lastGoodRun` is no longer needed on this path (saves 1). Net: about the same as today for 1 cohort, plus 2 for 3 cohorts.
- **Ingest done:** one extra statement to write `groupState.lastRead` for the cohort's groups, as a single `UPDATE settings SET value = json_patch(value, ?) WHERE key = 'groupState'`. It is one statement however many groups, and it cannot clobber a concurrent patch for other groups. `putSettings` overwrites whole keys, so do not use it here.
- **Allocator (daily):** one query `SELECT json_extract(report,'$.fetchedByGroup'), json_extract(report,'$.newByGroup'), json_extract(report,'$.crossFrom'), cost_usd, started_at FROM runs WHERE started_at >= ?`. About 170 rows for 7 days, a few hundred KB: about 2-4 ms CPU to parse **[est, measure on Workers]**. Run it in a tick of its own with the AI, Reddit and purge steps skipped. Rows read are about 170 a day against 5M.
- **Per-group cutoff storage:** about 200 bytes a group, 4 KB for 20 groups, inside one settings row. No migration. Nothing in the schema changes, so the deploy stays add-nothing.
- **CPU:** planner and allocator are O(N log N) for N under 50.

### 4.8 Run cost of cohorts

Cohort runs are not free: $0.0005 each. 365 runs a month is $0.18. Worst case 3 cohorts every slot is 730 runs, $0.37, which is 7% of the credit. The cap of 3 and the cohort-merging ladder keep it near the average.

## 5. Monthly cost under the design

Assumptions: busy groups (1.5 an hour) unless stated; 5 min overlap; 45% usable.

| Groups | Full watch would cost | Spend under the design | Coverage | Usable listings a month | Note |
|---|---|---|---|---|---|
| 3 busy | $4.3 | $4.3 | 100% | ~1,500 | Today's best case without the design |
| 10 | $13.9 | **about $4.75 (cap)** | about 33% each, or 3 groups full plus 7 sampled | 1,700-2,100 | 7-day trial for new ones costs about $0.08 each |
| 15 | $20.6 | **about $4.75** | about 22% | 1,700-2,100 | After 2-3 weeks about 8 survive as active/sample, the rest paused |
| 20 | $27.4 | **about $4.75** | about 17% | 1,700-2,100 | 5-7 days to rank them all; sample floor 15% needs about $0.6 for 20 groups |
| 10 quiet (0.5 an hour) | $4.9 | **about $4.9** | 100% | ~2,000 | Fits only if the groups are this quiet |

`Spend` is capped by construction: the daily allowance never exceeds what is left of 95% of the credit. The design never raises the bill above $5. It spreads $5 across more groups and moves money toward high-yield ones.

How many groups can $5 sustain? **3 fully covered (about 4 at 1.5 an hour with some days of gap). 10 to 20 only sampled, at 33% to 17% coverage each, for the same total listings. Fully covered only if they average at or under 0.5 posts an hour (10 groups) or 0.25 (20 groups).** The way to get more than about 2,100 listings a month is to raise yield (better groups), cut overlap, add the free Reddit source (`redditEnabled` is false in production; availability is unverified, COSTS.md), or move to Starter ($19).

## 6. Code changes

| # | Change | Files | Size |
|---|---|---|---|
| 1 | Overlap to 5 min as `sch.overlapMin` (default 15 so nothing moves until set); validate in settings | `src/apify.js` (`OVERLAP_MS`, `cutoffFor`), `src/admin.js` (`validateSchedule`) | S |
| 2 | Pure planner `src/groupplan.js`: `tierOf`, `yieldOf` (smoothed), `allocate(groups, budget)`, `trialDecision`, `echoOf`, `planCohorts(groups, now)` returning `[{groupIds, after, maxItems, maxCharge}]` | new `src/groupplan.js` | M |
| 3 | `startRun`: when `groupPlan.enabled`, call `planCohorts`, start up to 3 runs, record `caps.groupIds` per run. Off: today's path unchanged | `src/apify.js` (`startRun`, `scheduledJob`) | M |
| 4 | `ingestDataset` done path: `json_patch` `groupState.lastRead` for the run's groups; recovery per cohort; `caps` keeps `groupIds` | `src/apify.js`, `src/db/repo.js` (new `patchGroupState`) | M |
| 5 | Daily allocator tick: aggregate 7 days (SQL `json_extract`), update status, tier, rate, yield, echo; write one `putSettings({groupState})` | `src/apify.js` (`extras`), `src/db/repo.js` (`groupAgg`) | M |
| 6 | Budget-driven pace replaces the warn/stop halving; `settings.budget` finally drives the guard (finance.js Q1 says it does not yet) | `src/apify.js`, `src/finance.js` | S |
| 7 | Cross-post stats `mergedByGroup`, `crossFrom` in the run report (needs the first group of a matched listing) | `src/ingest.js`, maybe `src/db/repo.js` candidate query | M |
| 8 | Admin API: `groupPlan` get/put with validation; `/api/admin/groups` returns `groupState` fields; manual promote/pause | `src/admin.js`, `src/app.js` (`validateSettings`) | S |
| 9 | Admin UI: groups table columns (tier, status, usable per 6 h, rows and $ this month, echo of, trial countdown), pause/promote buttons, plan switch with the monthly allocation card on the Finance page | `web/ui.js`, `web/finance.js`, `web/app.css` | M |

No D1 migration is needed. If `json_patch` proves awkward on D1, the fallback is an add-only table `group_state(group_id PRIMARY KEY, ...)` in `migrations/0004`, written with one `UPDATE ... WHERE group_id IN (...)`.

**Build order, each step shippable behind `groupPlan.enabled=false`:**
1. Rows 1 and 6 (S+S, about 1 day): saves about 5% now and removes the dark last days.
2. Rows 7, 5 and 8 (M, 2 days): collect yield, rate and echo data and show it. Spend does not change. After a week we have real numbers to replace the **[est]** values above.
3. Rows 2, 3, 4 and 9 (M+M+M, 3 days): cohorts, sample mode and trial.

**Total: L, about 6 working days.**

## 7. Tests

- `test/groupplan.test.js` (new): tier boundaries; smoothed yield on tiny samples; `allocate` fills the budget exactly and orders by value; hysteresis; trial promote/pause rules; echo pairing and symmetric tie-break; `planCohorts` merges equal cutoffs and caps at 3; sample lookback ladder.
- `test/apify.test.js`: with `enabled=false` the request body is byte-for-byte today's; with it on, 1 vs 3 cohorts start the right runs with the right `postsPublishedAfter`, `maxItems` and `maxTotalChargeUsd`; `lastRead` advances only after a `done` ingest; a failed cohort keeps its cutoff; recovery per cohort; D1 statement count under 48 with 3 cohorts (`budgeted().used()`).
- `test/schedule.test.js`: pace per day from remaining credit and days left; a cycle rollover resets it; a zero budget pauses runs.
- `test/ingest*.test.js`: `crossFrom` counts for exact-key dupes and fuzzy merges across two groups.
- `test/api.test.js`: `groupPlan` validation; manual pause survives the allocator.
- Existing 114 tests stay green with `enabled=false` (acceptance check).

## 8. Risks and open questions

- All yields and the 45% usable rate are estimates. Phase 2 exists to replace them with measurements before any behaviour change.
- Sample mode misses older posts in each gap. Posts older than a few hours are least likely to still be available, but this is a judgement for the founder.
- Echo detection needs the first group of a listing; confirm the column before sizing row 7 (could turn M into L).
- Apify Free: concurrent runs and memory with 3 parallel cohorts are unverified.
- Platform cost per run is uncertain ($0.00015 measured, $0.0005 assumed). At 365 runs a month the gap is $0.13.
- Facebook may rate-limit or block groups the actor reads logged out; a failing group shows as `unscrapable` and should auto-pause after 3 failures (small add to the allocator).
