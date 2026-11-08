# Flat Hunt v2 design spec

Reference mockup: `docs/mockups/v2.html` (open it in a browser; copy tokens and component CSS from it into `web/app.css`). Vanilla HTML/CSS/JS, no libraries. CSP is `style-src 'self'`: no `style=""` attributes. Size SVG chart marks with SVG attributes (`height="…"`), which CSP allows.

## 1. Direction: "enamel board"

Keep the red To-Let tin board and make it feel like real enamel signage. The rent board gets a 2px red frame, a thin painted inner line (`inset 0 0 0 3px plate, inset 0 0 0 4px tolet-soft`), two rivets in the top corners, and the `TO-LET` plate sitting *on* the frame edge. A dashed bottom strip holds the phone number, the way real boards carry it painted along the bottom. For the public, that strip is masked, so the sign-in pitch is built into the signature itself.

Everything around the board stays quiet: cool limewash neutrals, one red, sentence-case labels (drop the uppercase tracked section headers), and fewer borders (cards use an `e1` ring shadow). In dark mode the background is a blue-slate, not black.

Fonts: keep Archivo (variable `wdth`; display at 66–86%), Atkinson Hyperlegible Next (body, 400/600/700) and Atkinson Hyperlegible Mono (phone numbers only). Add weight 600 to the Google Fonts URL.

## 2. Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F1F2EE | #111517 | page |
| `--surface` | #FFFFFF | #181D20 | cards, bars |
| `--sunk` | #E7E9E4 | #22282B | wells, chips |
| `--plate` | #FFFFFF | #1B2124 | board face |
| `--line` / `--line-strong` | #DADDD6 / #C3C7BF | #2C3336 / #3D4549 | dividers / control borders |
| `--ink` / `--ink-2` / `--muted` | #15191A / #3A4240 / #5B6461 | #ECEFED / #C9D0CD / #9AA4A1 | text |
| `--tolet` (fill, white text) | #C8221F | #C42A24 | plate, primary button |
| `--tolet-text` (red text) | #C8221F | #FF6B5F | rent figure, links on red actions |
| `--tolet-soft` | #FBE4E1 | #3A1A18 | |
| `--keep` / `--keep-soft` / `--on-keep` | #11774A / #DCEFE4 / #FFF | #4CC68A / #163023 / #0B1F14 | shortlist, ok |
| `--pass` / `--pass-soft` | #5A636C / #E7EAEC | #8C969F / #23292D | |
| `--amber` / `--amber-soft` | #8F5400 / #F6E9D2 | #E9A94B / #33270F | warnings, keyword `mark` |
| `--info` / `--info-soft` | #245C8F / #E0EAF4 | #8DB6DD / #1A2836 | links, "Posted 3×", focus ring |
| `--chart-match` / `--chart-off` / `--chart-new` / `--chart-grid` | #245C8F / #C9CEC6 / #C8221F / #E3E6E0 | #8DB6DD / #3A4246 / #FF6B5F / #262D30 | charts |

All text pairs were checked at ≥4.5:1 (the lowest is keep on keep-soft, 4.66). Split red into `--tolet` and `--tolet-text`, because white text on the dark-mode fill needs a darker red than red text on a dark surface.

**Type scale (rem):** 11 plate · 12 caption/meta · 14 small/UI · 16 body · 18 lead · 20 card title (`kind`) / panel h2 · 24 · 32 screen h1 · 44 card rent · 56 detail rent. Display: Archivo 800, `font-stretch` 66% (rent), 72–74% (h1, KPI values), 86% (kind). Body line-height is 1.5 (excerpts 1.55). Use `font-variant-numeric: tabular-nums` on every number.

**Space:** 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 56. The phone gutter is 16px.
**Radius, by hierarchy:** plate 3, board 4 (tin stays sharp), chip 8, control 12, KPI 14, card 18, swipe card 22, sheet 24, pill 999.
**Elevation:** `e1` (ring and a 1px shadow) for resting cards; `e2` for hover and raised cards; `e3` for the top swipe card and sheets. In dark mode, shadows go deeper and `e1` adds a 3% white top highlight.
**Motion:** `--d1` 120ms (press), `--d2` 200ms (hover, toggles, chips), `--d3` 320ms (sheet, card fly-out, tab switch), `--d4` 520ms (board swing). Easing: `--ease` cubic-bezier(.22,1,.36,1); `--ease-io` (.65,0,.35,1) for things that move in both directions; `--spring` (.34,1.56,.64,1) only for stamps and the board swing. Under `prefers-reduced-motion: reduce`, keep the existing global kill rule: no swing, no wiggle, and sheets appear without sliding.

## 3. Motion and micro-interactions

- **One orchestrated moment:** on the first Browse paint of a session, the first visible boards swing in from -3° around their top edge (`--d4`, spring), staggered 60ms, at most 3 cards. Nothing else animates on load.
- Buttons scale to .97 on `:active`; deck buttons scale to .92.
- The swipe card keeps the v1 physics (60px springs back, 200px decides). The stamp opacity follows drag distance. The card flies out over `--d3`.
- Badges bump (scale 1→1.15→1, `--d2`, spring) when their count goes up.
- A filter chip turns ink-filled when it is set. The result count in the header updates by crossfade, not a count-up.
- Toasts rise 8px and fade in, and sit above the tab bar. An Undo toast stays 6s.
- **Skeletons:** card skeleton = board-shaped block (frame in `--line`, no red) plus 3 bars; opacity pulse 1.4s (only when motion is allowed). Show skeletons only after 300ms.
- **Empty states:** left-aligned, a small grey board drawing (frame and plate in `--line-strong`), a one-line reason and one action. Example: "No 2 BHK under ₹25k in Green Glen yet. Clear rent filter".

## 4. IA and navigation

Routes are hash names. The hash router replaces the v1 `SCREENS` list.

| Route | Public | User | Admin |
|---|---|---|---|
| `#browse` (default) | yes | yes | yes |
| `#listing-<id>` (detail sheet over current screen) | masked | full | full |
| `#review` `#shortlist` `#passed` | opens sign-in sheet | yes | yes |
| `#signin` | sheet | – | – |
| `#areas` (My areas) | – | yes | yes |
| `#account` (theme, sign out, areas link, admin links on phone) | – | yes | yes |
| `#admin-scraper` `#admin-finance` `#admin-groups` `#admin-groups-performance` `#admin-phone` `#admin-ai` `#admin-data` `#admin-users` | – | – | yes |

A non-admin who opens an `#admin-*` route goes to `#browse` with the toast "That page is for admins."

**Phone, bottom tabs (64px plus the safe area):**
- Public: Browse · Review · Shortlist · Sign in. Review and Shortlist show a small lock glyph and open the sign-in sheet with a context line ("Sign in to get your own swipe deck").
- User and admin: Browse · Review (hot badge) · Shortlist · Passed · Me (avatar). On an admin's Me screen, an "Admin" section lists the six admin pages.
- Top bar: brand on the left; area chip and Import (admin only) on the right.

**Desktop (≥900px), 240px rail:** brand, then the nav group (same items), then the "My areas" list with each area's count, then an "Admin" group for admins only (Scraper, Groups, Phone scans, AI extraction, Data, Users). The account row with avatar and menu sits at the bottom. For the public, the rail ends with the red sign-in card (compact version of `.cta-card`).

## 5. Screens

### Public Browse `#browse`
- **Header block** (not a hero): h1 "Flats to let in **[Area]**". The area name is a dashed-underline button that opens the area picker. Below it, one muted line: "142 listings from 9 Facebook groups, newest first. Reposts are merged into one card. Checked 40 min ago." This line is the whole product explanation.
- **Filter row:** horizontally scrolling chips (36px desktop, 44px touch): BHK, Rent (range), Type, No brokerage (toggle), Furnishing, Sort (Newest / Rent low to high). Each chip opens a popover (desktop) or a small sheet (phone). The row is sticky under the top bar.
- **Grid:** `repeat(auto-fill,minmax(300px,1fr))`, gap 16; one column on phones.
- **Card:** optional photo (16:10, photo count pill), then the board overlapping the photo by 24px (rent, kind, money line, masked strip "••••• ••••• / Sign in to call"), then chips, a 3-line excerpt, and a meta row (fresh dot when under 6h, group name, age, "Posted 3×" pill). Tapping the card opens `#listing-<id>`.
- **Masking happens on the server.** The public API must never send phone digits, wa.me links, map URLs or the society name. Post text arrives with phones replaced by a token, which the client renders as the `.masked` hatched pill "number hidden".
- **Sign-in CTA placements:** "Sign in" in the top bar; the red `.cta-card` as the 4th grid item and then every 12 cards; the strip link on each card; the locked contact block; the locked tabs. Never show a modal on load.

### Listing detail (sheet: bottom sheet on phone, 560px right panel on desktop)
Contents: rent board at 56px, facts grid (sentence-case `dt`), contact block, photos, every merged post (one per group) and rent history. **Public:** the contact block is locked (mockup section 2). It shows Phone `+91 ••••• •••••`, WhatsApp and Location ("Green Glen Layout, society hidden"), each with a padlock, over a hatched footer with one sentence explaining why and a "Continue with Google" button. **Signed in:** the number in mono with Copy, Call (`tel:`) and WhatsApp (keep-filled), plus a map link.

### Sign in `#signin`
A sheet on every size, plus a full-page `/login` fallback with the same markup. It shows the board-styled title "Sign in to Flat Hunt", the three benefit lines from `.cta-card`, and a Google button following Google's light-theme rules (white, 1px border, the G logo, "Continue with Google"). Below: "We only use your name and email. Posters' numbers stay private to signed-in members." After sign-in, return to the route the person came from.

### Review / Shortlist / Passed (signed in)
Keep the v1 behaviour, keys and stages, restyled with the new tokens. The board now carries the phone strip. **Fix the deck height** so the buttons sit above the tab bar: `height: clamp(380px, calc(100dvh - var(--stick) - var(--tabbar) - 200px), 560px)`. This closes QA open risk 5. The Shortlist button is keep-filled with a soft keep glow; Pass is outlined. Shortlist rows get the same mini-board (rent at 24px in `--tolet-text`).

### My areas `#areas`
A search field: "Type an area, e.g. HSR Layout". Matches show as rows (name, listing count, Add). When nothing matches, the row reads "Create '<text>'". Below the list: "New areas are scanned from the next scrape (about every 4 h)." Selected areas are removable chips, each with a status: "Scanning", or "Waiting for first scrape" in amber. Browse defaults to the user's first area.

### Admin `#admin-scraper` (mockup section 4)
- **Header:** h1, then a status dot with "Every 4 h, next run 18:30" (or "Paused" in pass grey), then Schedule (opens a sheet) and Run now (primary).
- **KPI row** (4 columns, 2 below 900px): Apify credit used of $5 (meter with ticks at the 80% and 95% thresholds; the fill turns amber past 80% and red past 95%; plus a "lasts to" estimate); Posts fetched 7d; New listings 7d (with merged count); Match rate 7d. Each tile has a 28px sparkline and a delta against the previous 7 days (up in keep, down in tolet-text, each with a sign and a word so it isn't colour-only).
- **Schedule sheet:** On/off toggle, "Run every [stepper] hours" (1–24), "Posts per group [stepper]" (step 10), "Warn at [stepper] %" / "Stop at [stepper] %", and Save.
- **Charts** (2×2 grid on desktop, stacked on phone; range control 7/14/30 d). All pure SVG, rendered at the container's real pixel width (ResizeObserver, `viewBox="0 0 W H"`, 1 unit = 1px) so 11px axis text never scales. Y-axis labels on the left at 4 round ticks; gridlines in `--chart-grid`; baseline in `--line-strong`; x labels every 2nd day (every 4th below 720px). Each mark has a `<title>`, and each chart has `role="img"` with a `<desc>` summary.
  1. *Posts per day:* stacked bars, matched (`--chart-match`) under off-area (`--chart-off`).
  2. *Match rate:* line plus dots, y-axis 0–100%, in `--chart-match`; a dashed line at the 30-day average.
  3. *New listings per day:* bars in `--chart-new`; merged reposts drawn as an outlined segment on top.
  4. *Per-group yield:* horizontal bars sorted by new listings. Group name on the left, value label at the bar end. Groups that failed to scrape get an amber "Failed" pill instead of a bar.
- **Runs table:** Started, Status pill (Ingesting n/m info, Done keep, Partial amber, Failed red), Duration, Fetched, Matched, New, Merged, Dupes, Off-area, Failed groups, Cost. Numbers are right-aligned and tabular. Tapping a row opens a sheet listing the groups that couldn't be scraped. Below 720px each row becomes a 3-column card of labelled stats (`td::before{content:attr(data-l)}`).

### `#admin-groups`
Table: Group, Enabled toggle, Last scraped, Posts 7d, Match %, New 7d, Failures. Add-group field with URL validation. On phones, each group is a card.

### `#admin-groups-performance`
Header status dot ("Rotation on, last placed 2 h ago" / off) and Refresh. KPI row: Groups read now "5 of min 6" (tolet-text "Below the minimum" when short), Waiting in the pool, Projected spend this cycle (meter, amber past 80%, red past 95% of budget), Daily allowance. Plan panel: switch, "Always read at least" and "Re-try paused groups after" steppers, a Thresholds disclosure, Save plan. Groups table: Group, Status pill (Trial info, Active keep, Sample plain, Paused red when low yield / echo / unscrapable, else plain) with the reason in small text, Tier, Posts and Usable (7 d / cycle), Yield, Usable per 6 h, Cross-posts with "echo of …", Spend, Listings per $, Failures, Trial countdown or last change, Pause / Promote / Resume. Below 720px rows become cards and the action buttons span the card. Recent rotations: a plain list, newest first.

### `#admin-phone`
Drop zone (dashed `--line-strong`, 120px; "Drop scan JSON or choose a file"); after upload, an inline report reusing the v1 report table. Below it, the scan history table. Then "Posts from groups we don't scrape": Group, Posts seen, Matched an area, and an "Add to watched" button.

### `#admin-ai`
KPI row: Read by AI, Read by rules, Failed, Median confidence. Chart: a 10-bin confidence histogram (bars in `--chart-match`, bins under 0.6 in `--amber`). Failures table: post excerpt, error, Retry.

### `#admin-data` and `#admin-users`
- **Data:** search; checkbox column with a sticky bulk bar ("3 selected: Delete, Export"); Export CSV/JSON. Retention card: "Delete passed listings after [stepper] days" and "Delete all listings older than [stepper] days", with a destructive confirm sheet.
- **Users:** Name, Email, Role select (User/Admin), Areas, Last seen. You cannot demote yourself.

## 6. Components and states

Every interactive component has default, hover (pointer:fine only), `:active`, `:focus-visible`, disabled (.45 opacity, no hover) and, where it applies, loading states.

- **Button** (primary red, secondary outline, quiet, keep, danger-outline, google). Loading: label kept, 16px spinner replaces the icon, width locked.
- **Chip** (static: neutral, keep, brokerage-outline, info, amber). **Filter chip:** off, set (ink fill, value shown: "≤ ₹30k"), open.
- **Card** (resting e1, hover e2 lifted 2px, selected 2px info ring), and the board (normal, no rent: "Rent not stated" in muted 26px, seeking: amber plate "WANTED").
- **Table:** sortable header (aria-sort with an arrow), row hover, selected row (`--info-soft`), empty row, loading (3 skeleton rows).
- **Toast:** neutral, success (keep icon), error (tolet icon, stays until dismissed), with Undo.
- **Sheet:** bottom (drag handle, snap at 50%/92%) or right panel; scrim .45; Esc closes; focus trapped and restored.
- **Tabs and segmented control:** sunk track with a raised selected segment.
- **Toggle:** 44×26 track; on = keep; label to the left; `role="switch"`.
- **Number stepper:** [−] value [+], 44px buttons, typed input allowed, min/max clamp, hold to repeat after 400ms.
- **Meter, KPI tile, sparkline, status pill, avatar menu, area chip, masked pill, locked row.**

## 7. Accessibility

- Contrast: every token pair is ≥4.5:1 for text and ≥3:1 for chart marks against the surface.
- Focus: `box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--info)` on every control. It is blue so it doesn't read as an error on red buttons.
- Touch targets: 44×44 minimum under `pointer:coarse` (keep the QA rule and extend it to chips, toggles and steppers).
- Keyboard: tabs are links; deck keys ← → ↓ Z; `/` focuses search; 1–4 switch screens. Sheets trap focus. Charts have text equivalents (the runs table doubles as the data table).
- Masked values carry `aria-label="Phone number hidden"`. Never convey state by colour alone: pills have words, deltas have signs.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`, plus the manual theme in `#account`.
