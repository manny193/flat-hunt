# Admin: Finance & budget (`#admin-finance`)

Status: design spec, ready to build. Owner: design. Date: 8 Nov 2026.
Mockup: `docs/mockups/finance.html` (static, self-contained; open in a browser, resize to 375 px for the phone layout, toggle the OS theme for dark mode).
Reads with: `docs/DESIGN.md` (tokens, components), `docs/APIFY.md` "Cost plan", `docs/HANDOFF.md` D10, D11 and §9.1.

## 0. Why this page exists

Flat Hunt is free for everyone, and the founder wants to keep it that way. Today the only real cost is Apify, which charges per dataset row. Its numbers are spread over three screens: the credit meter on Scraper, per-run cost in the runs sheet, and per-group spend on Groups. This page brings them together and answers four questions, in this order, from top to bottom:

1. **What are we spending this month?** The verdict line and the "Spent this cycle" tile.
2. **Will we stay inside the free allowances?** The forecast tiles, the cycle chart and the free-services table.
3. **Where does the money go?** The spend-by-group table and the run costs.
4. **What should I change?** The "What to change" list, plus the what-if calculator to test a change before making it.

Design stance: this is a calm page. There is **no primary (red) button** on it. Red appears only when a limit has actually been passed (§6), so a red mark here always means "act now".

---

## 1. Route, nav and loading

- Route `#admin-finance`. Admin only; a non-admin gets the existing redirect to `#browse` with the toast "That page is for admins."
- Add to `ADMIN_PAGES` in `web/ui.js`, **second**, right after Scraper:
  `['admin-finance', 'Finance & budget', I.coin]`.
  Desktop rail order: Scraper, Finance & budget, Groups, Phone scans, AI extraction, Data, Users. The phone "Me → Admin" list uses the same array, so it picks this up automatically.
- New icon `I.coin` (24×24, stroke, same style as the others):
  `svg('<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.7 0-2.8.8-2.8 2s1.1 1.7 2.8 2 2.8.8 2.8 2-1.1 2-2.8 2c-1.3 0-2.3-.4-2.8-1.2M12 6.5V8M12 16v1.5"/>')`
- Add `'admin-finance': renderFinance` to the route map (`web/ui.js` line ~789) and `#admin-finance` to the DESIGN.md §4 route table.
- **One request per paint:** `GET /api/admin/finance` (NEW, §8.1). It returns everything on the page. "Refresh usage" calls the same endpoint with `?refresh=1`.
- Loading: `adminHead('Finance & budget')` followed by the existing `.skel` block (2 bars). Show it only after 300 ms, as with the other admin screens.
- Guard after the await: `if (route() !== 'admin-finance') return;` (same pattern as `renderScraper`).

---

## 2. Page anatomy

Top to bottom. Every block sits inside `.wrap`. Panels use the existing `.panel` / `.phead` / `h2`.

| # | Block | Answers | Component |
|---|---|---|---|
| A | Header | – | `.ahead` |
| B | Verdict | Q1 + Q2 in one sentence | NEW `.verdict` panel |
| C | KPI row (4 tiles) | Q1, Q2 | `.kpis` / `.kpi` / `.meter` / `spark()` |
| D | What to change | Q4 | `.panel` + NEW `.sugg` list |
| E | Charts (2) | Q2 | `.charts` grid, `chart()` helper |
| F | Spend by group | Q3 | `.panel` + `.tbl` |
| G | What-if calculator | Q4 | `.panel` + `.form-grid` + steppers |
| H | Free services | Q2 | `.panel` + `.tbl` |
| I | Run costs | Q3 | `.panel` + `.tbl` |
| J | How we count | trust | `.help` paragraphs |

### 2.1 Desktop (≥ 900 px, beside the 240 px rail)

```
┌ Finance & budget   [● On track to go over]  Usage read 12 min ago     [Refresh usage] [Set budget] ┐
├───────────────────────────────────────────────────────────────────────────────────────────────────────┤
│▌ On track to go over. $1.86 spent of your $5.00 budget. At $0.19 a day you'll reach about $6.14 by   │
│▌ 1 Dec. Scraping pauses on 23 Nov when Apify credit hits 95%.                                          │
├──────────────────┬──────────────────┬──────────────────┬──────────────────┤
│ Spent this cycle │ Projected at     │ Scraping pauses  │ Cost per new     │
│ $1.86 of $5.00   │ cycle end $6.14  │ 23 Nov           │ listing $0.008   │
│ ▓▓▓▓░░░░░░|░|    │ ∿∿∿ (daily)      │ 15 days from now │ ∿∿∿              │
│ 37% · day 8 of 30│ $0.19/day, 7 d   │ Fetches halve 19 │ 18% cheaper …    │
├──────────────────┴──────────────────┴──────────────────┴──────────────────┤
│ What to change                                                            │
│ [Watch] Pause "Bangalore Flat & Flatmates" …  Saves ~$1.22  [Review group]│
│ [Tip]   …                                                                 │
├─────────────────────────────────────┬─────────────────────────────────────┤
│ Spend this cycle vs budget          │ Daily spend                         │
│ (cumulative line + projection)      │ (bars)                              │
├─────────────────────────────────────┴─────────────────────────────────────┤
│ Spend by group (table)                                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ What if … (calculator: inputs left 1fr, result right 1fr, chart below)    │
├───────────────────────────────────────────────────────────────────────────┤
│ Free services (table)                                                     │
├───────────────────────────────────────────────────────────────────────────┤
│ Run costs (table, last 20)                                                │
│ How we count (help text)                                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

- KPI row: 4 columns (existing `.kpis`), 2 columns below 900 px.
- Charts: the existing `.charts` grid (1 column, 2 from 1100 px).
- Calculator: `.calc` grid `grid-template-columns: minmax(0,1fr) minmax(0,1fr)` from 720 px, and 1 column below that.

### 2.2 Phone (375 px; 16 px gutter, so 343 px of content)

```
Finance & budget                       (h1, 32px)
● On track to go over                  (status pill, own line)
Usage read 12 min ago                  (muted 12px)
[Refresh usage] [Set budget]           (btn sm, 44px tall on touch)
┌───────────────────────────────┐
│▌ On track to go over. $1.86 … │  verdict, 16px text, wraps to 4–5 lines
└───────────────────────────────┘
┌──────────────┐┌──────────────┐
│Spent this    ││Projected at  │  KPI 2×2, each ~163 px wide
│cycle         ││cycle end     │  value 32px "$1.86"; "of $5.00" small wraps
│$1.86         ││$6.14         │  under the value if needed
└──────────────┘└──────────────┘
┌──────────────┐┌──────────────┐
│Scraping      ││Cost per new  │
│pauses 23 Nov ││listing $0.008│
└──────────────┘└──────────────┘
What to change: each suggestion stacks: pill, sentence, saving on its own line, full-width action button
Charts: full width, height 180, x labels every 4th day (existing xLabels rule for W < 720)
Spend by group: each row becomes a card (3-col grid of labelled stats, via data-l)
Calculator: inputs stacked, result card directly under the inputs, chart below
Free services: cards
Run costs: cards
```

- The header wraps naturally (`.ahead` is `flex-wrap`). Below 520 px the two buttons get `.btn.sm`, and the status gets `flex-basis:100%` so it sits on its own line.
- No horizontal page scroll. `.tscroll` stays as the wrapper, but below 720 px the card layout means nothing overflows.
- KPI `.v` stays 32 px. On a 163 px tile, "$1.86" plus "of $5.00" wraps, which is fine. Add `.kpi .v small{white-space:nowrap}` so "of $5.00" never splits.

---

## 3. Blocks: exact copy and data

Conventions: money is formatted with the existing `usd()` (2 decimals, or 4 below $0.01). Use NEW `usd2(v)` where the spec says "2 dp" (always 2 decimals, `'–'` for null), and NEW `cents(v)` for per-listing costs (3 decimals: `$0.008`). Dates use `toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })`, giving "23 Nov". Times are IST, as elsewhere. All numbers are `tabular-nums`.

`F` = the `GET /api/admin/finance` response (§8.1).

### A. Header

`adminHead('Finance & budget', extra)` where `extra` is:

1. **Status pill** (`.pill` plus the class from §6), with `F.forecast.status` mapped to text:
   - `ok` → `pill ok`, "Inside budget"
   - `watch` → `pill warn`, "On track to go over" (if the trigger is the warn %, instead "Near the warn level")
   - `over` → `pill bad`, "Over budget"
   - `unknown` → `pill` (neutral), "Not enough data yet"
   - Apify not configured → `pill`, "Nothing spent: Apify not connected"
2. **Freshness text** `<span class="small muted" id="fin-fresh">`: "Usage read {relative(F.apify.usage.checkedAt)}" (e.g. "12 min ago"), using the existing `when()`. If `checkedAt` is more than 6 h old, append " (old)". If usage was never read: "Usage not read yet".
3. `<span class="sp"></span>`
4. `<button class="btn" type="button" data-act="refresh">Refresh usage</button>`. Hidden when `!F.apify.configured`. While loading it uses the DESIGN.md §6 button loading state (label kept, spinner, width locked).
5. `<button class="btn" type="button" data-act="budget">Set budget</button>` opens the Budget sheet (§4).

### B. Verdict (`<section class="verdict" data-s="{status}" aria-labelledby="fin-verdict-h">`)

A surface panel with a 4 px left bar in the status colour (§6), 18 px text (`--fs-18`), `--ink`. A visually hidden `<h2 id="fin-verdict-h" class="sr">Summary</h2>` comes first. One or two sentences, built from `F.forecast` and `F.budget`. The first clause always repeats the status word, so the colour is never the only signal.

| Condition (first match wins) | Copy |
|---|---|
| `!F.apify.configured` | "Nothing is being spent. Apify isn't connected (APIFY_TOKEN is not set), so Facebook groups aren't scraped. Reddit, phone scans and AI extraction are free." |
| `status==='over'` and `mtdUsd >= budget` | "**Over budget.** {usd2(mtd)} spent of your {usd2(budget)} budget, with {daysLeft} days left in the cycle. {pauseClause}" |
| `status==='over'` and credit used up | "**Over budget.** Apify credit is used up ({usd2(used)} of {usd2(limit)}). Scraping is paused until {date(cycleEnd)}." |
| `status==='watch'` (projection) | "**On track to go over.** {usd2(mtd)} spent of your {usd2(budget)} budget. At {usd2(rate)} a day you'll reach about {usd2(projected)} by {date(cycleEnd)}. {pauseClause}" |
| `status==='watch'` (warn %) | "**Near the warn level.** Apify credit is {pct}% used, so each run fetches half as many posts per group until {date(cycleEnd)}." |
| `status==='ok'` | "**Inside budget.** {usd2(mtd)} spent of your {usd2(budget)} budget. At {usd2(rate)} a day you'll end the cycle near {usd2(projected)}, leaving {usd2(budget − projected)} spare." |
| `status==='unknown'`, no runs | "**Not enough data yet.** No paid runs this cycle, so nothing has been spent. {nextRunClause}" |
| `status==='unknown'`, under 1 day of data | "**Not enough data yet.** {usd2(mtd)} spent so far. A forecast appears after the first full day of runs." |

- `pauseClause`, when `F.forecast.pauseAt` is inside the cycle: "Scraping pauses on {date(pauseAt)} when Apify credit hits {stopPct}%." Otherwise it is omitted.
- `nextRunClause`: "The next run is at {time(F.schedule.nextRunAt)}." If the schedule is off: "Scraping is switched off in Schedule."
- If usage could not be read (`F.apify.usageError` or `usage==null`), add a second line in `--muted` 14 px: "Apify usage couldn't be read, so this uses our own run records, which can miss small platform charges. {Refresh usage}". The link is a `button.linkish` with the same `data-act="refresh"`.

### C. KPI row

Four `.kpi` tiles, in this order. Labels are exact.

**C1 "Spent this cycle"**
- `.v`: `{usd2(F.forecast.mtdUsd)}<small> of {usd2(F.budget.monthlyUsd)}</small>`
- `.meter` with `role="meter" aria-valuemin="0" aria-valuemax="{budget}" aria-valuenow="{mtd}" aria-label="Spent this cycle" aria-valuetext="{pct}% of budget"`. Fill width = `min(100, 100·mtd/budget)`%, set through the CSSOM (as with `#meter-fill`). The fill class follows §6 (keep, then `mid` amber at ≥ 80% of budget or when projected > budget, then `hi` red only at ≥ 100%).
- Ticks: only when `budget === limitUsd`, draw the existing warn and stop ticks at `budgetWarnPct` and `budgetStopPct` (they describe the Apify guard, so they only line up when the budget equals the credit). Each tick has a `title`: "Warn at 80%: posts per group halve" and "Stop at 95%: runs pause".
- `.d`: "{pct}% of budget · day {daysElapsed} of {daysTotal}". If the source is runs rather than Apify, append " · from our runs".

**C2 "Projected at cycle end"**
- `.v`: `{usd2(F.forecast.projectedUsd)}`, or `–` when `status==='unknown'`.
- `spark(F.perDay.map(d => d.costUsd))`, the daily spend this cycle (stroke `--chart-match`).
- `.d`: "at {usd2(rate)}/day, last {rateWindowDays} days". If `rateWindowDays < 3`, prefix "Early estimate: ". If projected > budget, add `<span class="warn-t">{usd2(projected − budget)} over</span>` (amber text, never red, because it hasn't happened yet). Otherwise add `<span class="up">{usd2(budget − projected)} spare</span>` (keep).

**C3 "Scraping pauses"**
- `.v`: `{date(F.forecast.pauseAt)}` when `pauseAt` falls inside the cycle; otherwise "Not this cycle".
- `.d`, in priority order:
  - inside the cycle: "{n} days from now · fetches halve from {date(warnAt)}" (omit the second part if `warnAt` is in the past or null);
  - not this cycle: "Credit resets {date(cycleEnd)} with {usd2(limit − projectedUsed)} to spare";
  - already paused (`used ≥ stop%`): `.v` shows "Paused", and `.d` shows "Resumes {date(cycleEnd)}".
- No meter or sparkline. A thin "cycle bar" is drawn instead: an 8 px `.meter.cycle` with the fill showing days elapsed (`--pass`) and a 2 px `--amber` tick at the `pauseAt` position. The tick is decorative (`aria-hidden`), and the text says it.

**C4 "Cost per new listing"**
- `.v`: `{cents(F.efficiency.costPerNewListingUsd)}`, or `–` when there are no new listings.
- `spark(F.perDay.map(d => d.newListings ? d.costUsd / d.newListings : 0))`
- `.d`: a NEW helper `costDelta(cur, prev)`. Lower is better, so the colours are the reverse of `delta()`:
  - cheaper: `<span class="up">{n}% cheaper</span> than previous 7 days` (keep)
  - dearer: `<span class="warn-t">+{n}% dearer</span> than previous 7 days` (amber, **not** red)
  - no previous data: "no earlier data"

### D. What to change (`.panel`, h2 "What to change")

Up to **4** suggestions, computed **client-side** from `F` with the rules below (pure function `suggestions(F)`, unit-testable). Sort by severity (over, then watch, then tip), then by `savingUsd` descending. Each suggestion is one `<li class="sugg">`:

```
[pill] Sentence with the numbers in it.               Saves about $1.22 this cycle   [Action]
```

- The pill text is always a word: "Over budget" (`pill bad`), "Watch" (`pill warn`), "Tip" (`pill run`, info blue).
- The saving is in `--keep` 14 px 700: "Saves about {usd2(s)} this cycle". Omit it when there is no saving.
- The action is `a.btn.sm` (a link to another admin route) or `button.btn.sm` (a sheet on this page).
- Empty list: `<p class="help">Nothing to change. Spending is on track and every group earns its keep.</p>`

| ID | Rule | Severity | Copy | Saving | Action |
|---|---|---|---|---|---|
| R1 | `mtd ≥ budget` | over | "You've spent {usd2(mtd)}, past your {usd2(budget)} budget. Lower the stop level or pause groups to stop spending this cycle." | – | "Open schedule" → opens the existing `scheduleSheet` (fetch `/api/admin/scraper` first) |
| R2 | `projected > budget` | watch | "At {usd2(rate)} a day you'll pass your budget around {date(budgetAt)}. Pausing {names} would bring the cycle to about {usd2(projectedAfter)}." `names` = the fewest groups, chosen in ascending `listingsPerUsd` order (low-value first), whose `dailyUsd × daysLeft` sum takes projected ≤ budget; at most 3 names, quoted; "and n more" beyond that | Σ `dailyUsd × daysLeft` of those groups | "Review groups" → `#admin-groups` |
| R3 | each group with `lowValue` (not already named in R2) | watch | "\"{group}\" cost {usd2(cycleUsd)} this cycle for {newListings} new listings ({yieldPct}% of its posts). Pausing it saves about {usd2(dailyUsd × daysLeft)}." | `dailyUsd × daysLeft` | "Review group" → `#admin-groups` |
| R4 | `F.capHits.length > 0` | watch | "{n} group(s) hit the {cap}-post cap in recent runs, so some posts were skipped: {names}. Add a run hour in the longest gap ({gapLabel}) rather than raising the cap; extra runs cost about $0.0002 each." | – | "Open schedule" |
| R5 | `F.budget.monthlyUsd > F.apify.usage.limitUsd` and `F.apify.plan==='free'` | tip | "Your budget is {usd2(budget)}, but the Apify free plan stops at {usd2(limit)}. Spending can't pass {usd2(limit)} unless you move to a paid Apify plan." | – | "Set budget" |
| R6 | `status==='ok'` and `projected < 0.6 × budget` and no R3 | tip | "You have room for about {k} more group(s) at today's rate ({usd2(perGroupMonthly)} a month each). Try it in the calculator first." `k = floor((budget − projected) / perGroupMonthly)` | – | "Try in calculator" → focuses `#wi-groups` and sets it to `groups + k` |
| R7 | any `F.free[i]` with `measured && used/limit ≥ 0.8` | watch | "{name} used {pct}% of its free {period} allowance ({used} of {limit} {unit})." Workers AI adds: "Extraction falls back to rules when it runs out." | – | for `workers_ai`: "Open AI extraction" → `#admin-ai`; otherwise none |
| R8 | usage older than 6 h, or not read | tip | "Apify usage was last read {relative}. Refresh to make the forecast exact." | – | "Refresh usage" |

Definitions: `budgetAt = now + (budget − mtd) / rate` days. `gapLabel` comes from `F.schedule.longestGap`, for example "9 PM to 6 AM, 9 h".

### E. Charts (`.charts`, 2 panels)

Both use the existing `chart(el, draw)` helper (real pixel width, ResizeObserver, `role="img"`, `<title>`, `<desc>`, 11 px axis text, 4 round ticks, `--chart-grid` gridlines, `--line-strong` baseline). Height 200 on desktop and 180 below 720 px. Y labels are money: `$0`, `$2.50`, `$5`… (NEW option `pad.usd` in `axes()`: prefix `$`, and show 2 dp unless the tick is a whole number). **Don't use `niceMax` for money**: it returns at least 4, so a $0.31 day would sit on a $4 axis. Add `niceMoney = v => niceMax(Math.max(1, Math.ceil(v * 100))) / 100` (so $0.31 gives a $0.40 axis, and $6.45 gives $10).

**E1 "Spend this cycle vs budget"** (`#fin-ch1`)
- Legend (`.legend`): `<i class="cum"></i>Spent` · `<i class="proj"></i>Projected` · `<i class="bud"></i>Budget`.
- X: every day of the cycle (`F.cycle.days[]`), labels from `dLabel()` (every 2nd day, or every 4th below 720 px).
- Y max = `niceMoney(max(budget, limitUsd, projected) × 1.05)`.
- Marks:
  - **Spent:** solid line, `--chart-match`, 2 px, cumulative of `F.perDay[].costUsd` up to today, plus a 3.5 px dot at today. When the source is Apify, scale the line so its last point equals `F.apify.usage.usedUsd` (the run records miss platform pennies): `scale = used / Σcost` when Σcost > 0.
  - **Projected:** dashed line (`stroke-dasharray:4 4`), `--chart-match` at 0.7 opacity, from today's point to `(cycleEnd, projectedUsd)`.
  - **Budget:** horizontal line, `--ink-2`, 1 px, `stroke-dasharray:2 3`, with a right-aligned label above it "Budget {usd2(budget)}" (`.ax`).
  - **Apify credit:** only if `limitUsd !== budget`, a second horizontal line in `--muted` labelled "Apify credit {usd2(limit)}".
  - **Pause marker:** if `pauseAt` is inside the cycle, a vertical 1 px `--amber` line labelled "Pauses" at the top (`.ax`, fill `--amber`).
  - **Over:** if the spent line has crossed the budget, the part of the spent line above the budget is drawn in `--tolet-text`, and the today dot gets a 2 px `--tolet-text` ring. This is the only red on the chart, and it appears only once spend has really passed the budget (§6).
- Each day has an invisible 1-day-wide hit `<rect class="hit">` with `<title>{dLabel}: {usd2(cum)} spent so far ({usd(costUsd)} that day, {runs} runs)</title>`.
- `<desc>`: "Spent {usd2(mtd)} of a {usd2(budget)} budget by {date(today)}. Projected {usd2(projected)} by {date(cycleEnd)}.{ Scraping pauses {date(pauseAt)}.}"

**E2 "Daily spend"** (`#fin-ch2`)
- Legend: `<i></i>Posts fetched` · `<i class="off"></i>Platform and group details`.
- Stacked bars per cycle day: `rowsUsd` (`--chart-match`) under `otherUsd` (`--chart-off`; usually a hair). It reuses the `barsChart` geometry. Write a small `moneyBars(days)` rather than overloading `barsChart`, because its keys are hard-coded.
- A dashed `--muted` horizontal line at the budget's daily allowance, `budget / daysTotal`, labelled "Daily share {usd(budget/daysTotal)}". Bars above it are **not** recoloured. The line tells the story.
- Hover `<title>`: "{dLabel}: {usd(costUsd)} ({rows} rows, {runs} runs, {newListings} new listings)".
- `<desc>`: "Daily spend this cycle. Average {usd(rate)} a day over the last {rateWindowDays} days; highest {usd(max)} on {dLabel}."

Empty state for both charts (no runs this cycle): the `chart()` container shows `<p class="help">No paid runs this cycle yet.{ The next run is at {time}.}</p>` instead of an SVG.

### F. Spend by group (`.panel`, h2 "Where the money goes")

- Under the h2, one muted line of source totals (`.help`): "Facebook groups via Apify: {usd2(F.bySource.apify.costUsd)} · Reddit: free · Phone scans: free · AI extraction: free". Each "free" is plain text, not a pill.
- Table `.tbl`, sorted by `cycleUsd` descending; failed-only groups go last. Columns (header text exact):

| Header | Class | `data-l` | Cell |
|---|---|---|---|
| Group | `first` | – | name (`esc`), then `<br><span class="small">{share}% of spend</span>`, then an inline SVG share bar (100×6, `viewBox="0 0 100 6"`, `<rect width="{share}">` in `--chart-match` on a `--sunk` track; `aria-hidden`). Paused groups show `<span class="pill">Paused</span>`. |
| Spend this cycle | `n` | Spend | `usd(cycleUsd)` |
| Posts | `n` | Posts | `postsFetched` |
| New listings | `n` | New | `newListings` + ` <span class="small">({yieldPct}%)</span>` |
| Listings per $ | `n` | Per $ | `listingsPerUsd ?? '–'` + ` <span class="pill warn" title="20+ posts this cycle, under 15% became new listings">Low value</span>` when `lowValue` |
| Monthly at this rate | `n` | Monthly | `usd2(dailyUsd × 30.4)` |
| Failures | `n` | Failures | `failures` (0 shown as "0"); a failed-only group shows `<span class="pill warn">Failed</span>` |
| – | `stat` | – | `<a class="btn sm quiet" href="#admin-groups" aria-label="Manage {group}">Manage</a>` |

- Footer row (`<tfoot>`, bold): "All groups" · Σ spend · Σ posts · Σ new · overall per $ · Σ monthly · Σ failures. Below 720 px the tfoot row becomes a card like the others, with `data-l` labels.
- Empty: `<tr><td colspan="8">No group spend this cycle.</td></tr>`
- Text alternative: this table is the data table for E1/E2's group view, and DESIGN.md §7 already says tables double as chart equivalents.

### G. What-if calculator (`.panel`, h2 "What if we add groups?")

Intro (`.help`): "Cost comes from how many posts the groups write, not how often we run. Change the numbers to see a month's cost before adding groups."

**Inputs** (`.form-grid`; each one is a `<label class="lbl" for>` plus a control):

| Label | Control | Default | Range |
|---|---|---|---|
| "Groups" | `stepper('wi-groups', …, 0, 200)` | `F.whatIf.activeGroups` | 0–200, step 1 |
| "Posts per group per hour" | `<input class="input" id="wi-pph" inputmode="decimal">` | `F.whatIf.postsPerGroupPerHour` (measured) | 0–50, 2 dp |
| "Price per post (US$)" | `<input class="input" id="wi-price" inputmode="decimal">` | `F.whatIf.rowPriceUsd` | 0.0001–0.05 |
| "Runs per day" | read-only text, not an input: "{runsPerDay} ({scheduleText})" | `F.schedule.runsPerDay` | – |

Under "Posts per group per hour", a hint `.help` (id `wi-pph-h`, linked with `aria-describedby`): "Measured: {pph} over the last 7 days across {n} groups." If the data is thin (`F.whatIf.measured === false`): "Estimate: about 1.5 for an area group. Busy city-wide groups post 5 or more." A quiet button "Use measured" resets the value.

Under the price: "{actorShort} charges {usd(rowPrice)} per post. The official Apify scraper costs about $0.005." (`actorShort` = "automly" or "official scraper").

**Formula** (client-side, pure function `whatIfCost(i)`, 30.4 days a month):

```
postsUsd    = groups × pph × 24 × 30.4 × price
detailsUsd  = groups × 4.35 × price               // weekly group-details rows (APIFY.md)
platformUsd = runsPerDay × 30.4 × F.whatIf.platformPerRunUsd   // ≈ $0.00015 a run
monthlyUsd  = postsUsd + detailsUsd + platformUsd
perGroupUsd = pph × 24 × 30.4 × price + 4.35 × price
maxGroups   = floor((budget − platformUsd) / perGroupUsd)      // inside the founder's budget
maxFree     = floor((limitUsd × stopPct/100 − platformUsd) / perGroupUsd)  // before the guard pauses runs
postsPerRun = ceil(pph × F.schedule.longestGapHours)           // per group, in the longest gap
```

**Result** (`<output id="wi-out" for="wi-groups wi-pph wi-price" aria-live="polite">`). A sunk card (`--sunk`, radius 14, padding 16):

- Large figure (KPI `.v` style): `{usd2(monthlyUsd)}<small> a month</small>`
- Line 1, in the status words and colours of §6:
  - inside: `<span class="up">Inside your {usd2(budget)} budget</span>, {usd2(budget − monthly)} to spare.`
  - over budget but under the free credit: `<span class="warn-t">{usd2(monthly − budget)} over your budget</span>.`
  - over the free credit: `<span class="warn-t">Over the {usd2(limit)} Apify credit</span>. Runs would pause around day {ceil(limit × stopPct/100 / (monthly/30.4))}.`
  - Amber, not red: a what-if is a scenario, not an overspend.
- Line 2: "Your budget covers up to **{maxGroups} groups** at this rate. The free credit covers **{maxFree}**."
- Line 3 (cap check): if `postsPerRun ≤ cap`: "Longest gap between runs is {gap} h, so about {postsPerRun} posts per group per run (cap {cap})." Otherwise: `<span class="warn-t">About {postsPerRun} posts per group would arrive in the {gap} h gap, over the {cap} cap.</span> Add a run hour in that gap."
- Breakdown (`<dl class="mini">`): "Posts {usd2(postsUsd)}" · "Group details {usd2(detailsUsd)}" · "Platform {usd2(platformUsd)}".

**Mini chart** "Monthly cost by number of groups" (`#wi-ch`, height 140): a line from 0 to `max(2 × groups, maxFree + 2, 10)` groups of `monthlyUsd(g)`, in `--chart-match`. It has a horizontal budget line (as in E1), a horizontal Apify credit line when it differs, and a vertical marker with a dot at the current `groups` value labelled "{groups} groups · {usd2}". Its `<desc>` repeats line 2. It redraws on every input change (debounce 100 ms).

Behaviour: recalculate on `input` events. Invalid input (empty, NaN, out of range) shows the field's inline error `.err` text ("Enter a number from 0 to 50") with `aria-invalid="true"`, and the result keeps the last valid numbers, with the figure at 0.45 opacity. Nothing is saved: a note under the result (`.help`) says "This doesn't change any settings. To add groups, go to Groups." with a link to `#admin-groups`.

### H. Free services (`.panel`, h2 "Free services")

Intro (`.help`): "Everything except Apify runs on free plans today. Where we can measure use, it's shown against the free allowance."

Table, one row per `F.free[]` item, in server order:

| Header | Class | `data-l` | Cell |
|---|---|---|---|
| Service | `first` | – | `name`, then `<br><span class="small">{plan}</span>` |
| Free allowance | – | Allowance | `allowanceText` (server string, e.g. "100,000 requests a day, 10 ms CPU each") |
| Used | `n` | Used | measured: `{fmt(used)} of {fmt(limit)} {unit}` plus a 6 px `.meter.sm` (fill per §6; `role="meter"` with `aria-valuetext="{pct}% of today's allowance"`). Not measured: `<span class="small">Free: not measured yet</span>` |
| Resets | – | Resets | "Daily, 05:30 IST" (Cloudflare resets at 00:00 UTC) / "Monthly" / "–" |
| Status | `stat` | – | measured: `pill ok` "OK" (< 80%), `pill warn` "Near limit" (80–99%), `pill bad` "Limit reached" (≥ 100%). Not measured: `pill` "Free" |

Rows the server sends (§8.1 `free[]`):

| `id` | name | plan | allowanceText | Measured today? |
|---|---|---|---|---|
| `workers` | Cloudflare Workers | Workers Free | 100,000 requests a day, 10 ms CPU each | No (later: Cloudflare analytics API, §8.4) |
| `d1` | Cloudflare D1 | D1 Free | 5 million rows read and 100,000 written a day, 5 GB stored | Storage: yes (NEW `d1.sizeBytes`). Reads and writes: not yet |
| `workers_ai` | Workers AI | Workers Free | 10,000 neurons a day (our cap {neuronCap}) | **Yes**, from the AI state that `/api/admin/ai` already uses (`neurons.used`). Limit = 10,000; show our cap in the allowance text |
| `groq` (only if `GROQ_API_KEY` is set) | Groq (AI fallback) | Free tier | Free tier, rate-limited | Tokens today (`groqTokens`); limit unknown, so `measured:false` with `note:"{n} tokens today"` |
| `github` | GitHub Actions | Free | Free for public repos (2,000 min a month if private) | No |
| `reddit` | Reddit API | Free (non-commercial) | 100 requests a minute with OAuth | No (`connected` decides the plan text: "Not connected" when false) |

- For D1 storage the "Used" cell reads "{MB} MB of 5 GB stored". The Resets cell for that line is "–".
- Below the table (`.help`): "Free plans can change. Re-check the limits on each provider's pricing page once a quarter." Plain text, no external links (the CSP is fine with links, but the admin doesn't need them here).

### I. Run costs (`.panel`, h2 "Run costs")

Last 20 Apify runs this cycle, newest first. The data is `F.runs[]`: a slim projection of `runView()` plus `cost`.

| Header | Class | `data-l` | Cell |
|---|---|---|---|
| Started | `first` | – | `when(startedAt)` |
| Status | `stat` | – | `statusPill(status)` (existing) |
| Posts | `n` | Posts | `cost.rows ?? postsFetched` |
| Posts cost | `n` | Posts $ | `usd(cost.resultsUsd)` |
| Platform | `n` | Platform | `usd(cost.platformUsd)` |
| Total | `n` | Total | `usd(costUsd)` in 700 weight |
| New listings | `n` | New | `newListings` |
| Per new listing | `n` | Per new | `newListings ? cents(costUsd/newListings) : '–'` |
| Capped | `n` | Capped | `cappedGroups.length ? '<span class="pill warn">{n} capped</span>' : ''` |

- A row click opens the existing run-details sheet (reuse that code: extract it from `renderScraper` into `runSheet(r)`).
- Footer link: `<a class="small" href="#admin-scraper">All runs on Scraper</a>`
- Empty: "No paid runs this cycle yet."

### J. How we count (`.help`, under the last panel; collapsed `<details>` with summary "How these numbers are worked out")

Copy:
- "**Spent this cycle** is Apify's own figure for this billing cycle ({date(cycleStart)} to {date(cycleEnd)}). If we can't read it, we add up our run records instead."
- "**Projected** is spent so far plus the average daily spend over the last 7 days (fewer early in the cycle), times the days left."
- "**Scraping pauses** is when credit used reaches the stop level ({stopPct}%) at that daily rate. At the warn level ({warnPct}%) each run fetches half as many posts per group."
- "**Group spend** is posts fetched from that group times the price per post. Platform charges aren't split by group."
- "Run frequency barely changes cost. Each run costs about $0.0002 in platform fees, and we only fetch posts newer than the last run."

---

## 4. Budget sheet (`data-act="budget"`)

Uses the existing `openSheet(html, { label: 'Monthly budget' })`.

```
Monthly budget                                            [Close]
Monthly budget (US$)
[ 5.00              ]                      (input.input, inputmode="decimal", id="bud-usd")
The Apify free plan gives $5.00 of credit each cycle and can't overspend.
A budget above $5.00 only helps on a paid Apify plan.
Current: $1.86 spent this cycle; projected $6.14.
[ Save budget ]                                  (btn keep block, not red)
```

- Validation, client and server: a number from 0.50 to 500, rounded to 2 dp. Error text under the field (`.err`, `--tolet-text`; this is a form error, which DESIGN.md allows to be red): "Enter an amount from $0.50 to $500."
- Save: `PUT /api/admin/finance { monthlyBudgetUsd }`. Then close the sheet, show the toast "Budget saved: {usd2(v)} a month", and re-render.
- Server errors: show the `toast` error (existing `fail(err)`), keep the sheet open, and keep the typed value.
- The budget does **not** change the Apify guard (warn/stop % stay relative to the Apify credit). See open question Q1.

---

## 5. Empty, error and edge states

| State | Detection | What renders |
|---|---|---|
| Loading | before the response | header + `.skel` (after 300 ms) |
| Endpoint failed | `api()` throws | header (no status pill), then a `.panel` containing `<p class="help">Couldn't load finance data: {err.message}.</p><button class="btn" data-act="retry">Try again</button>`. Nothing else renders. |
| No Apify token | `F.apify.configured === false` | status pill "Nothing spent: Apify not connected"; the verdict copy from §3B; C1 `$0.00 of {budget}` with `.d` "APIFY_TOKEN not set"; C2–C4 show `–` with `.d` "Needs Apify"; D shows one Tip: "Connect Apify to scrape Facebook groups. Set APIFY_TOKEN on the server (see docs/APIFY.md)." with no action; the charts show their empty state; F shows the empty row; G works on defaults (pph 1.5, price 0.0012, `measured:false`); H renders normally; I shows the empty row. "Refresh usage" is hidden. |
| Usage not read yet | `configured && usage == null && !usageError` | figures come from runs (`F.forecast.mtdSource === 'runs'`); C1 `.d` "… · from our runs"; the verdict adds the second line; R8 tip. |
| Usage read failed | `F.apify.usageError` (string) | as above, with the second verdict line "Apify usage couldn't be read ({usageError}). Figures come from our run records." `usageError` is server text and goes through `esc()`. |
| Refresh failed | `?refresh=1` returns 200 with `usageError` set | toast "Couldn't read Apify usage. Showing the last reading." The page keeps the cached usage. |
| No runs this cycle | `F.perDay.every(d => !d.runs)` | status `unknown`; verdict "Not enough data yet…"; C2/C4 `–`; charts empty state; F/I empty rows; G uses the measured fallback. |
| Under 1 day of data | `F.forecast.rateWindowDays < 1` | status `unknown`; C2 `–` with `.d` "Forecast after the first full day". |
| 1–3 days of data | `rateWindowDays < 3` | forecast shown; C2 `.d` prefixed "Early estimate: ". |
| Scraping paused by the guard | `used ≥ limit × stopPct/100` | C3 "Paused" / "Resumes {date}"; status `over` only if `mtd ≥ budget` or `used ≥ limit`, otherwise `watch`. |
| Credit used up | `used ≥ limit` | status `over`; meter `hi`; verdict "Over budget. Apify credit is used up…" |
| Schedule switched off | `!F.schedule.enabled` | C3 "Not this cycle" / "Scraping is switched off"; the verdict uses that `nextRunClause`. |
| Zero budget spend rate | `rate === 0` with runs present | projected = mtd; C3 "Not this cycle". |
| Cycle dates unknown | no usage ever read | the cycle is the IST calendar month (`F.cycle.source === 'calendar'`); "How we count" says "calendar month (Apify cycle not read yet)". |

---

## 6. Colour rules

All colours come from DESIGN.md tokens; there are no new hex values. One rule governs the page:

> **Red (`--tolet`, `--tolet-text`, `pill bad`) means a limit has been passed:** spend this cycle ≥ budget, Apify credit used up (`used ≥ limit`), or a measured free allowance at ≥ 100%. Nothing else on this page is red: not forecasts, not deltas, not "dearer", not low-value groups, not the what-if result, and not buttons.

| Meaning | Token | Where |
|---|---|---|
| Fine / better / spare | `--keep`, `pill ok`, `.up` | meter fill under 80%, "spare", "cheaper", "Inside budget" |
| Heading for a limit / scenario over | `--amber`, `pill warn`, NEW `.warn-t{color:var(--amber);font-weight:700}` | meter `mid` (≥ 80% of budget, or projected > budget), "over" in forecasts, low value, capped, pause marker |
| Limit passed | `--tolet` (fills), `--tolet-text` (text and lines), `pill bad` | meter `hi` (≥ 100%), status "Over budget", the over part of the E1 line |
| Info / tip | `--info`, `pill run` | Tip pills, focus ring |
| Neutral / unknown | `--pass`, plain `.pill` | "Not enough data yet", "Free", cycle-elapsed bar |
| Data series | `--chart-match` (spend), `--chart-off` (overheads), `--chart-grid`, `--line-strong` | charts. **`--chart-new` is not used on this page**: it is red, and spend is not "new listings". |

- Verdict left bar: `data-s="ok"` → `--keep`, `watch` → `--amber`, `over` → `--tolet`, `unknown` / not configured → `--pass`.
- Meter thresholds on this page (`mid` at 80% of budget or a projected overrun; `hi` only at ≥ 100%) differ from the Scraper tile (`hi` at the stop %). Recommendation for later: align the Scraper tile to the same rule. This is out of scope here.
- Dark mode: no special cases. Every colour is a token that already has a dark value. The verdict bar and the meters read on `--surface` #181D20 (keep #4CC68A, amber #E9A94B, tolet-text #FF6B5F are all ≥ 3:1 for non-text marks).

NEW CSS (append to `web/app.css`; no inline styles):

```css
.verdict{background:var(--surface);border-radius:var(--r-card);box-shadow:var(--e1);padding:var(--s4) var(--s5);margin-top:var(--s4);border-left:4px solid var(--pass);font-size:var(--fs-18);line-height:1.45}
.verdict[data-s="ok"]{border-left-color:var(--keep)}
.verdict[data-s="watch"]{border-left-color:var(--amber)}
.verdict[data-s="over"]{border-left-color:var(--tolet)}
.verdict p{margin:0}.verdict .sub{margin-top:var(--s2);font-size:var(--fs-14);color:var(--muted)}
.warn-t{color:var(--amber);font-weight:700}
.kpi .v small{white-space:nowrap}
.meter.cycle i{background:var(--pass)}
.meter .tick.pause{background:var(--amber)}
.meter.sm{height:6px;margin:var(--s1) 0 0;min-width:80px}
.sugg-list{list-style:none;margin:0;padding:0}
.sugg{display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:var(--s2) var(--s3);padding:var(--s3) 0;border-bottom:1px solid var(--line)}
.sugg:last-child{border-bottom:0}
.sugg .save{color:var(--keep);font-weight:700;font-size:var(--fs-14);white-space:nowrap}
@media (max-width:720px){.sugg{grid-template-columns:1fr}.sugg .btn{width:100%}}
.calc{display:grid;gap:var(--s4)}
@media (min-width:720px){.calc{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.calc output{display:block;background:var(--sunk);border-radius:14px;padding:var(--s4)}
.calc output.stale .v{opacity:.45}
.mini{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4);margin:var(--s2) 0 0;font-size:var(--fs-12);color:var(--muted)}
.mini dt{display:inline}.mini dd{display:inline;margin:0 0 0 4px;color:var(--ink-2);font-weight:700}
.err{color:var(--tolet-text);font-size:var(--fs-12);font-weight:700;margin-top:var(--s1)}
.sharebar{display:block;width:100px;height:6px;margin-top:var(--s1)}
.sharebar .tr{fill:var(--sunk)}.sharebar .fl{fill:var(--chart-match)}
.chart .s-cum{fill:none;stroke:var(--chart-match);stroke-width:2}
.chart .s-cum.over{stroke:var(--tolet-text)}
.chart .s-proj{fill:none;stroke:var(--chart-match);stroke-width:2;stroke-dasharray:4 4;opacity:.7}
.chart .s-bud{stroke:var(--ink-2);stroke-width:1;stroke-dasharray:2 3}
.chart .s-cap{stroke:var(--muted);stroke-width:1;stroke-dasharray:6 3}
.chart .s-pause{stroke:var(--amber);stroke-width:1}
.chart .t-pause{fill:var(--amber)}
.chart .hit{fill:transparent}
.chart .s-ring{fill:none;stroke:var(--tolet-text);stroke-width:2}
.legend i.cum{background:var(--chart-match)}
.legend i.proj{background:none;border-top:2px dashed var(--chart-match);border-radius:0;height:0;width:14px}
.legend i.bud{background:none;border-top:1px dashed var(--ink-2);border-radius:0;height:0;width:14px}
tfoot td{font-weight:700;border-top:1px solid var(--line-strong)}
@media (max-width:520px){.ahead .btn{min-height:36px;padding:0 var(--s3)}.ahead .pill{order:2}.ahead .status-line{flex-basis:100%}}
```

(The `pointer:coarse` 44 px rule already lifts `.ahead .btn` back to 44 px on phones.)

---

## 7. Accessibility

- **Contrast.** All text pairs are DESIGN.md pairs that are already checked at ≥ 4.5:1: `--amber` on `--surface` (light 6.2:1, dark 9.0:1) for `.warn-t`; `--keep` on `--surface`; `--muted` on `--surface` and on `--sunk` (the calculator result card: light 5.2:1, dark 5.3:1). Chart marks: `--chart-match`, `--ink-2`, `--amber` and `--tolet-text` are all ≥ 3:1 on `--surface` in both themes. `--chart-off` is decorative (overheads are a sliver) and is always paired with a tooltip and a legend word.
- **Never colour alone.** Every status has a word ("Inside budget", "Over budget", "Near limit", "Low value", "capped"). Deltas have a sign and a word ("18% cheaper", "+12% dearer"). Projections say "over" or "spare".
- **Charts.** `role="img"` with `<title>` and a `<desc>` summary sentence (§3E), as the existing helpers do. Each data point has a `<title>`. Tables F and I are the data equivalents; add `aria-describedby` from each chart's `<svg>` to a visually hidden `<p class="sr">` reading "The same numbers are in the Where the money goes and Run costs tables below." Sparklines are `aria-hidden` (the tile text carries the meaning).
- **Meters** are `role="meter"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext` and `aria-label`. The visible `.d` text repeats the percentage.
- **Calculator.** Every input has a visible `<label for>`. Hints and errors are linked with `aria-describedby`, and invalid fields get `aria-invalid="true"`. The result is an `<output aria-live="polite">`, so screen readers hear the new monthly cost after typing pauses (announce the result only, throttled with the 100 ms debounce). Steppers keep their existing keyboard behaviour (typing allowed, buttons are real `<button>`s). Give the stepper a real accessible name: `aria-label="Groups"`, **not** the input id (the existing `stepper()` uses `aria-label="${id}"`; pass a label argument, which is a NEW optional parameter).
- **Keyboard.** Tab order: Refresh usage → Set budget → suggestion actions → table row actions → calculator inputs → Use measured → links. Run-cost rows open the sheet on Enter and Space: give each `tr[data-run]` `tabindex="0"`, plus a keydown handler (the existing rows are click-only, so fix this here). Sheets trap focus and Esc closes them (existing). The focus ring is the existing `--focus`.
- **Headings.** h1 "Finance & budget" → the visually hidden h2 "Summary" for the verdict → a visible h2 for every panel. KPI labels are `<span class="k">` (existing pattern); the tiles sit in a `<section aria-label="This cycle at a glance">`.
- **Touch.** 44 × 44 targets under `pointer:coarse` (existing rules cover `.btn.sm`, `.seg button` and steppers).
- **Motion.** No animation on this page apart from the existing button press scale. Charts redraw without transitions.
- **Language.** Plain English, sentence case, no jargon in visible copy ("posts" rather than "dataset rows"; "posts fetched" in the legend). Money always carries "$" and two decimals. Say "a month" or "a day" rather than "/mo" or "/day" in sentences (tiles may use "/day" to save space).

---

## 8. Data and API

### 8.1 NEW `GET /api/admin/finance[?refresh=1]`

Admin only (it sits behind the same `/api/admin/` gate). It reads settings, `runsSince(cycleStart − 14 d)` and the AI state; that is 3 D1 queries, well inside the 48-query budget. Apify usage: with `refresh=1`, or when the cached `settings.apifyUsage.checkedAt` is older than 10 min, call `getUsage()` live and cache it (same as `scraperView`). On failure, keep the cache and set `apify.usageError`. Always 200 unless it's an auth error.

```jsonc
{
  "now": 1762588800000,
  "budget": { "monthlyUsd": 5, "updatedAt": 1762500000000 },          // NEW settings.budget, default {monthlyUsd:5}
  "apify": {
    "configured": true,                                                // !!env.APIFY_TOKEN
    "plan": "free",                                                    // NEW: "free" when limitUsd <= 5, else "paid" (heuristic)
    "actor": "automly~facebook-public-group-posts-scraper",
    "rowPriceUsd": 0.0012,                                             // rowPrice(actor)
    "platformPerRunUsd": 0.00015,                                      // median cost.platformUsd of the last 20 runs, default 0.00015
    "usage": { "usedUsd": 1.86, "limitUsd": 5, "ratio": 0.372,
               "cycleStart": "2026-11-01T00:00:00.000Z",               // NEW: getUsage() must also return data.monthlyUsageCycle.startAt
               "cycleEnd": "2026-12-01T00:00:00.000Z", "checkedAt": 1762588080000 },  // null if never read
    "usageError": null                                                 // string when the last live read failed
  },
  "cycle": {
    "source": "apify",                                                 // "apify" | "calendar" (IST month) when cycle dates are unknown
    "start": 1761955200000, "end": 1764547200000,
    "daysTotal": 30, "daysElapsed": 7.5, "daysLeft": 22.5,
    "days": ["2026-11-01", "…", "2026-11-30"]                         // IST day keys (dayKey) across the cycle
  },
  "forecast": {
    "mtdUsd": 1.86, "mtdSource": "apify",                              // "apify" (usage.usedUsd) | "runs" (sum of runs.cost_usd since cycle.start)
    "runsUsd": 1.79,                                                   // sum of runs.cost_usd since cycle.start (for the reconciliation note)
    "dailyRateUsd": 0.19, "rateWindowDays": 7,                         // window = min(7, daysElapsed); rate = runs cost in window / window
    "projectedUsd": 6.14,                                              // mtd + rate × daysLeft
    "budgetAt": 1764000000000,                                         // when mtd reaches the budget at this rate; null if never in the cycle
    "warnAt": 1763510000000, "pauseAt": 1763860000000,                 // when used reaches warn% / stop% of limitUsd at this rate; null if after cycle end
    "status": "watch"                                                  // see 8.2
  },
  "efficiency": { "costPerNewListingUsd": 0.0084, "prevCostPerNewListingUsd": 0.0102,  // last 7 d vs the 7 d before (apify runs only)
                  "newListings": 214 },
  "perDay": [ { "day": "2026-11-01", "costUsd": 0.31, "rowsUsd": 0.309, "otherUsd": 0.001,
                "rows": 258, "runs": 8, "newListings": 31 } ],          // one per cycle day up to today; IST day of runs.started_at
  "bySource": { "apify": { "costUsd": 1.79, "runs": 58 }, "reddit": { "costUsd": 0, "runs": 14 }, "phone": { "costUsd": 0, "runs": 2 } },
  "groups": [ {                                                        // groupValue() rows over the cycle window, plus:
      "group": "Bangalore Flat & Flatmates", "url": "https://www.facebook.com/groups/…",
      "active": true,                                                  // NEW join: from settings.groups by name/url
      "cycleUsd": 0.48, "postsFetched": 400, "newListings": 22, "yieldPct": 5.5,
      "listingsPerUsd": 46, "lowValue": true, "failures": 0,
      "dailyUsd": 0.054,                                               // NEW: group spend in the last rateWindowDays / rateWindowDays
      "sharePct": 26.8                                                 // NEW: cycleUsd / Σ cycleUsd
  } ],
  "capHits": [ { "group": "HSR Layout Rentals", "runs": 2, "cap": 30 } ],  // NEW: see 8.3
  "runs": [ { "id": 812, "status": "done", "startedAt": 1762580000000, "postsFetched": 21, "newListings": 4,
              "costUsd": 0.0254, "cost": { "totalUsd": 0.0254, "platformUsd": 0.0002, "resultsUsd": 0.0252, "rows": 21 },
              "cappedGroups": [] } ],                                    // last 20 apify runs in the cycle; runView() + NEW cappedGroups
  "schedule": {                                                        // from scheduleOf(settings) + resultsPerGroup + nextRunAt
    "enabled": true, "mode": "times", "runHoursIst": [6,9,11,13,15,17,19,21], "intervalHours": 4,
    "runsPerDay": 8,                                                   // NEW derived: runHoursIst.length, or 24 / intervalHours
    "longestGapHours": 9, "longestGap": "9 PM to 6 AM, 9 h",           // NEW derived (wrap around midnight)
    "resultsPerGroup": 30, "maxRunUsd": 0.5, "budgetWarnPct": 80, "budgetStopPct": 95,
    "nextRunAt": 1762596000000
  },
  "whatIf": {
    "activeGroups": 4,                                                 // active, supported (non-Page) watched groups
    "postsPerGroupPerHour": 1.65,                                      // NEW: apify posts fetched in last 7 d / (activeGroups × hours covered); 2 dp
    "measured": true,                                                  // false when < 24 h of runs or 0 active groups (then value = 1.5)
    "rowPriceUsd": 0.0012, "platformPerRunUsd": 0.00015
  },
  "free": [                                                            // NEW, see 3H
    { "id": "workers", "name": "Cloudflare Workers", "plan": "Workers Free",
      "allowanceText": "100,000 requests a day, 10 ms CPU each",
      "measured": false, "used": null, "limit": 100000, "unit": "requests", "period": "day", "resets": "daily-utc", "note": null },
    { "id": "d1", "name": "Cloudflare D1", "plan": "D1 Free",
      "allowanceText": "5 million rows read and 100,000 written a day, 5 GB stored",
      "measured": true, "used": 48234496, "limit": 5000000000, "unit": "bytes", "period": "storage", "resets": null, "note": "Reads and writes not measured yet" },
    { "id": "workers_ai", "name": "Workers AI", "plan": "Workers Free",
      "allowanceText": "10,000 neurons a day (our cap 8,000)",
      "measured": true, "used": 3120, "limit": 10000, "unit": "neurons", "period": "day", "resets": "daily-utc", "note": null },
    { "id": "github", "name": "GitHub Actions", "plan": "Free", "allowanceText": "Free for public repos (2,000 min a month if private)",
      "measured": false, "used": null, "limit": null, "unit": "minutes", "period": "month", "resets": "monthly", "note": null },
    { "id": "reddit", "name": "Reddit API", "plan": "Free (non-commercial)", "allowanceText": "100 requests a minute with OAuth",
      "measured": false, "used": null, "limit": 100, "unit": "requests/min", "period": "minute", "resets": null, "note": null, "connected": true }
  ]
}
```

When `apify.configured === false`: `usage:null`, `usageError:null`, `forecast` with zeros and `status:"unknown"`, and empty `groups`, `runs` and `capHits`. Every other key is still present, so the client never has to guard against missing objects.

### 8.2 Status (server-computed so tests can pin it)

```
limitHit   = usage && usage.usedUsd >= usage.limitUsd
over       = mtd >= budget || limitHit
watch      = !over && (projected > budget || (usage && usage.ratio >= warnPct/100))
unknown    = !over && !watch && (rateWindowDays < 1 || no apify runs this cycle)
status     = over ? "over" : watch ? "watch" : unknown ? "unknown" : "ok"
```

Note that `over` and `watch` are checked before `unknown`: a red or amber state must never be hidden by thin data.

### 8.3 NEW fields in run reports (`src/apify.js` ingest)

- `report.perGroupCap`: the `resultsPerGroup` actually sent for that run (after the guard's halving). Needed to detect cap hits.
- `cappedGroups` (derived in `runView`): groups whose `fetchedByGroup[g] >= report.perGroupCap`. `capHits` in 8.1 = per-group counts over the last 7 days.
- Older runs have no `perGroupCap`, so they report `cappedGroups: []`.

### 8.4 Other backend changes

| Change | Where | Notes |
|---|---|---|
| `getUsage()` returns `cycleStart` | `src/apify.js` | `data.monthlyUsageCycle.startAt` |
| `settings.budget = { monthlyUsd, updatedAt }` | settings | default `{ monthlyUsd: 5 }` |
| NEW `PUT /api/admin/finance` `{ monthlyBudgetUsd }` → `{ budget }` | `src/admin.js` | 400 `bad_budget` "Enter an amount from $0.50 to $500." |
| D1 size | `src/admin.js` | Read `meta.size_after` from the last write result, or run `PRAGMA page_count` × `PRAGMA page_size` (2 queries). If neither is available on the platform, send `d1.measured:false`. |
| Workers AI used today | reuse the AI state (`aiView`'s `neurons.used`) | the limit sent is the platform's 10,000, not our cap |
| Later (not v1): Workers requests and D1 reads/writes | Cloudflare GraphQL Analytics API | needs NEW secrets `CF_ACCOUNT_ID` + `CF_API_TOKEN` (Account Analytics: Read). Until then these rows say "Free: not measured yet". |

### 8.5 Element → data map

| Element | Fields |
|---|---|
| Status pill, verdict | `forecast.status`, `forecast.mtdUsd`, `budget.monthlyUsd`, `forecast.dailyRateUsd`, `forecast.projectedUsd`, `forecast.pauseAt`, `cycle.end`, `cycle.daysLeft`, `apify.configured`, `apify.usage`, `apify.usageError`, `schedule.enabled`, `schedule.nextRunAt`, `schedule.budgetStopPct` |
| Freshness | `apify.usage.checkedAt` |
| C1 | `forecast.mtdUsd`, `forecast.mtdSource`, `budget.monthlyUsd`, `apify.usage.limitUsd`, `schedule.budgetWarnPct/StopPct`, `cycle.daysElapsed/daysTotal` |
| C2 | `forecast.projectedUsd`, `forecast.dailyRateUsd`, `forecast.rateWindowDays`, `perDay[].costUsd` |
| C3 | `forecast.pauseAt`, `forecast.warnAt`, `cycle.*`, `apify.usage` |
| C4 | `efficiency.*`, `perDay[].costUsd/newListings` |
| D | everything above + `groups[]`, `capHits[]`, `free[]`, `apify.plan` |
| E1 | `cycle.days`, `perDay[]`, `forecast.*`, `budget.monthlyUsd`, `apify.usage` |
| E2 | `cycle.days`, `perDay[].rowsUsd/otherUsd/rows/runs/newListings`, `budget.monthlyUsd`, `cycle.daysTotal` |
| F | `groups[]`, `bySource` |
| G | `whatIf.*`, `schedule.runsPerDay/longestGapHours/resultsPerGroup/budgetStopPct`, `budget.monthlyUsd`, `apify.usage.limitUsd`, `apify.actor` |
| H | `free[]` |
| I | `runs[]` |

---

## 9. Build notes

- Plain HTML strings, CSS in `web/app.css`, SVG via the existing `chart()`/`axes()` pattern. No libraries and no inline `style=""`. Set widths through the CSSOM (`el.style.width`) or SVG attributes, as elsewhere.
- New client helpers: `usd2`, `cents`, `costDelta`, `suggestions(F)`, `whatIfCost(i)`, `cumChart(F)`, `moneyBars(F)`, `whatIfChart(i, F)`, `runSheet(r)` (extracted). Keep `suggestions` and `whatIfCost` pure and export them for `docs/prototype-logic-test.js`-style tests.
- Tests to add: status table (8.2), each suggestion rule's trigger and copy, the what-if numbers in the worked example below, the cap-gap calculation across midnight, and the endpoint shape when `APIFY_TOKEN` is unset.

Worked example (matches the mockup): budget $5, limit $5, used $1.86 on day 7.5 of 30, rate $0.19/day, so projected = 1.86 + 0.19 × 22.5 = **$6.14** (watch). Pause at 95% ($4.75) = (4.75 − 1.86) / 0.19 = 15.2 days, giving **23 Nov**. Warn at 80% ($4.00) = 11.3 days, giving **19 Nov**. What-if with 4 groups × 1.65 posts/h × $0.0012: posts $5.78 + details $0.02 + platform (8 × 30.4 × 0.00015) $0.04 = **$5.84 a month**. Per group $1.45, so the budget covers **3 groups** and the free credit to 95% covers **3**. Longest gap 9 h × 1.65 = 15 posts, under the 30 cap. Pausing "Bangalore Flat & Flatmates" ($0.054/day × 22.5 = $1.22) brings the cycle to about **$4.92**.

## 10. Open questions for the founder

- **Q1.** Should the founder's budget also drive the guard (warn/stop as % of `min(budget, Apify credit)`)? Recommendation: yes, once the page has shipped and the numbers have been checked against Apify's bill for one cycle. It's a one-line change in `startRun`.
- **Q2.** Should "Low value" groups be auto-paused after two cycles? Recommendation: no. Keep it a suggestion; the founder decides.
- **Q3.** Should Cloudflare analytics (a new API token) be measured now or later? Recommendation: later. Nothing is near its limit today.

## 11. Build notes: where the shipped page differs (engineering, 8 Nov 2026)

- **No `report.perGroupCap`.** Runs already store `report.caps` at start and `report.truncated` after ingest. `capHits` and each run's `cappedGroups` come from `truncated.groups` / `truncated.perGroup`.
- **Rate window** = min(7 days, days into the cycle, days since our first Apify run). The spec's min(7, daysElapsed) underestimates the rate when scraping started mid-cycle. With under a day of data, spend is divided by one full day rather than extrapolated, and the status stays `unknown` unless it is already `over` or `watch`.
- **Scraping switched off:** projection = spent so far, and `warnAt`/`pauseAt` are null (nothing more will be spent).
- **Cycle days** are indexed from the cycle start (day i = start + i days, labelled with its IST date), so an Apify cycle that starts at 00:00 UTC has 30 days, not 31.
- **Extra response fields:** `forecast.reason` (`budget`/`credit`/`projection`/`warn`), `forecast.paused`, `forecast.creditUsedUsd`, `forecast.limitUsd`; `cycle` is otherwise as in §8.1.
- **D1 size** uses one query (`pragma_page_count() × pragma_page_size()`); where the platform refuses it, `d1.measured` is false. Workers AI use comes from `settings.ai` (no extra query). Workers requests and D1 reads/writes stay "Free: not measured yet" (§10 Q3).
- **Q1 (budget drives the guard): not done**, per the recommendation. The warn/stop guard stays relative to the Apify credit; `FINANCE` in `src/finance.js` holds the tunables.
- Pure client logic (`suggestions`, `whatIfCost`, `verdict`, formatting) lives in `web/finance.js` so `test/finance.test.js` can import it; `ui.js` imports it as a module (`/finance.js` added to the public assets).
- **The forecast respects the Apify stop guard (QA, 8 Nov).** The guard stops runs once credit used passes the stop level (`ratio > stopPct`, the same strict comparison as `startRun`). So: once paused, the forward rate is 0 and the projection equals spend so far (status `watch`, reason `paused`); before that, the projection is capped at spend so far plus the credit left below the stop level (`projectionCapped`, `uncappedProjectedUsd` kept for reference), and `budgetAt` is null when the pause comes first. A coming pause is its own `watch` reason (`pause`), with verdict "Scraping will pause…" and rule R9 (which groups to pause so runs last the cycle); an active pause gets R10. **The spec's own worked example has this flaw:** $6.14 at the end of the cycle can't happen on a $5 credit with a 95% stop; the page shows "Scraping will pause on 23 Nov… Spending stops near $4.75". R2 only fires when the budget really is crossed before any pause.
- **Money axes** use 4 equal steps of whole cents (1, 2, 2.5, 5 × 10^k), so every tick label is exact ($0.31 → $0.40 axis, $6.45 → $8, not $10).
- **Budget PUT** accepts a JSON number or a plain decimal string (`/^\d+(\.\d{1,2})?$/`); "0x10" and "1e2" are refused. A malformed stored budget falls back to $5.
- With scraping switched off or paused, the page shows no $/day rate ("no more spend").
