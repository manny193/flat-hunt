# Area alerts: channel research and design

Researched 8 Nov 2026. Status: **proposal, nothing built**. Prices are public figures from vendor and aggregator pages; items marked **[unverified]** come from secondary sources or are our estimates. Re-check every rate on Meta's rate card before it drives a money decision. ₹ figures use ₹89 per US$ (as in `docs/ai/COSTS.md`).

Feature asked: a signed-in user or admin (never the public) picks areas, e.g. "Green Glen Layout". When ingest adds new posts for that area (scrapes run up to 8 times a day), the user gets them on WhatsApp. Area only, to avoid spam.

## 1. Answer

**WhatsApp cannot be free.** The official route (Meta WhatsApp Business Platform, Cloud API) charges per delivered business-initiated message, and an alert about new listings is a business-initiated message. It can be legitimate and cheap per message, but it is a recurring cost that grows with users, and it needs a registered business to scale.

**Free and legitimate channels exist** and meet the same need: a **Telegram bot** (free, no volume cost) and **Web Push** from our PWA (free). Email is free only through a third party (Brevo or Resend free tiers). **Recommendation: build the channel-agnostic alert core plus Telegram first, then Web Push; add WhatsApp only if the founder decides to fund it** (see §7).

## 2. WhatsApp Business Platform (official, Cloud API direct from Meta)

Facts, with sources:

- **Pricing model:** per delivered message, replacing per-conversation pricing on 1 July 2025. Categories: marketing, utility, authentication (templates, sendable any time) and service (free-form, only inside the 24 h window). Source: [Meta pricing docs](https://developers.facebook.com/docs/whatsapp/pricing).
- **Billing changes in 2026:** India billing moves to INR; accounts must migrate by 31 Dec 2026 or non-INR messages stop on 1 Jan 2027. India marketing rate rose on 1 Jan 2026. Rates change on 1 Jan, 1 Apr, 1 Jul, 1 Oct. Source: Meta pricing docs above; [Baat](https://baat.ai/blog/whatsapp-api-pricing-india).
- **India rates** (AiSensy's summary of Meta's list, headline date 1 Jan 2026; sources disagree and the Meta page does not show the INR table, so **[unverified]**): marketing **₹1.09**, utility **₹0.145**, authentication ₹0.145, service ₹0.145 after the free allowance. Source: [AiSensy](https://m.aisensy.com/blog/whatsapp-per-message-pricing-update-effective-january-1-2026/). Other aggregators quote marketing between ₹0.78 and ₹1.09 and utility around $0.0014 ([Formbeep](https://formbeep.pages.dev/whatsapp-api-pricing/)). Use ₹1.09 and ₹0.145 for planning. Add 18% GST.
- **Volume discounts:** utility and authentication only (about 5, 10, 15% off, illustrative), never marketing. Source: Meta pricing docs.
- **Business-initiated alerts require an approved template.** A user must have opted in to receive them. Free-form text is allowed only inside the 24 h window.
- **Category for "new listings in your area":** most likely **marketing**. Utility is meant for updates about a transaction or request the user already made; a feed of new items looks like content or promotion. A user-requested alert has a fair utility argument, but Meta reviews templates and **reclassifies** at its discretion, so budget for marketing and treat utility as an upside. **[our judgement, not a Meta statement]**
- **Free customer-service window:** opens for 24 h each time the user messages us. Service messages are free; **from 1 Oct 2026 each business number gets 1,000 free service messages a month**, then they are charged, and utility templates sent inside an open window also become charged from 1 Oct 2026. Without a payment method on file, service messages stop after the free allowance. Source: Meta pricing docs.
- **Free entry point windows** (user messages us from a Click-to-WhatsApp ad, window up to 7 days, all categories free): needs ads; not useful for us.
- **Window trick (legitimate variant):** a "pull" alert: the user texts "new" and the bot replies with matching listings as free service messages. No templates, no per-message cost under 1,000 a month. But it is not an alert; the user must message us each time, and it does not scale past 1,000 replies a month per number. A digest template with a quick-reply button ("Send me the list") can open the window, but the digest template itself is still charged. Do not market this as push alerts.
- **Free tier:** none for template messages. The only free things are service messages (above).
- **Verification and account:** needs a Meta Business portfolio, a WhatsApp Business Account, and a phone number that is **not registered on the WhatsApp or WhatsApp Business app** (a new SIM or a number deregistered from the app) and that can receive an OTP. Starting a conversation needs a display name that Meta approves. Meta Business Verification unlocks higher limits and an official display name. Sole proprietors can apply but need a formal registered identity: Udyam registration (free, online), Shop and Establishment registration or a GST certificate, with the legal name matching exactly. An individual with no registration is likely to stay unverified and capped. Sources: vendor guides, not Meta ([Exotel](https://developer.exotel.com/docs/whatsapp-support/business-verification), [Zoko](https://www.zoko.io/post/whatsapp-business-api-documents-needed), [Hyperleap](https://hyperleap.ai/whatsapp-business-api/apply)). **[unverified: confirm in Meta Business Help Center]**
- **Limits for a new number:** starts at **250 unique users per rolling 24 h** (business-initiated, outside the window). Raising it: pass verification and/or send quality traffic; sources conflict on the next step (1,000 or 2,000) and on figures. Source: [360dialog](https://docs.360dialog.com/docs/resources/wabas/messaging-limits), [Dotdigital](https://marketing.help.dotdigital.com/en/articles/10485811-understand-whatsapp-messaging-limits), [Exotel](https://developer.exotel.com/docs/whatsapp-support/messaging-limits). **[unverified]** 250 is enough for our first hundreds of users.
- **Webhooks:** Cloud API posts inbound messages and delivery status to an HTTPS URL we own, with a verify-token handshake and `X-Hub-Signature-256` signature. A Worker route can serve this. Outbound sending is one `POST graph.facebook.com/.../messages` per message.
- **Opt-in:** explicit, recorded, specific to WhatsApp alerts. We must honour STOP quickly and keep quality rating high; users blocking us lowers limits.

### Monthly cost (Meta only, before GST and any BSP fee)

Assumes 3 alert messages per user per day (90 a month) at list rates, then the same with **one digest a day** (30 a month), which is what the design in §6 does.

| Users | 3 msgs/day, marketing (₹1.09) | 3 msgs/day, utility (₹0.145) | 1 digest/day, marketing | 1 digest/day, utility |
|---|---|---|---|---|
| 10 | ₹981 (~$11) | ₹131 (~$1.5) | ₹327 (~$3.7) | ₹44 (~$0.5) |
| 100 | ₹9,810 (~$110) | ₹1,305 (~$15) | ₹3,270 (~$37) | ₹435 (~$5) |
| 1,000 | ₹98,100 (~$1,100) | ₹13,050 (~$147) | ₹32,700 (~$367) | ₹4,350 (~$49) |

Add 18% GST, about 4% card forex if billed in USD (INR billing helps), and any BSP markup. A BSP adds ₹0.08 to ₹0.23 per message plus, for some, a ₹999 to ₹7,999 monthly fee (sources conflict, see §3). Even the cheapest cell is a recurring cost the founder would carry for a free app.

## 3. BSPs (Twilio, Gupshup, Interakt, AiSensy, WATI and others)

None found with a genuinely free tier for sending template messages: Meta's per-message fee always passes through, and a BSP adds either a per-message markup or a subscription. Figures vary by source and are **[unverified]**:

- Twilio: Meta's rate plus about $0.005 per message (US-focused source); no India figure confirmed. Source: [Chatlivo](https://dev.to/chatlivo/whatsapp-business-api-pricing-2026-india-rates-free-tier-21ed) and similar roundups.
- Indian BSPs: markups quoted around ₹0.08 (Gupshup) to ₹0.23 (AiSensy) per message; subscriptions from ₹999 (Interakt, AiSensy low plans) up to ₹2,499 to ₹7,999 (WATI). Some sellers (MSG91, Ominiflow) claim zero markup. Source: [MyOperator comparison](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026), a competitor, not neutral.
- BSP trial credits exist but are not a production plan.
- Meta's Cloud API direct is cheaper than a BSP (no markup) and our Worker can call it with plain `fetch`; a BSP only helps with onboarding and template tooling.

## 4. Unofficial routes (whatsapp-web.js, Baileys, gateways): do not use

They automate a personal or business WhatsApp account outside the Business Platform. This violates WhatsApp's terms, regularly gets numbers banned (and the founder's own number if reused), cannot run on Workers (needs a long-lived process), and sends third-party posts to users without the platform's opt-in and quality controls. Recommend against.

## 5. Free channels compared (India)

| Channel | Cost | Reach in India | Setup effort | Limits and caveats |
|---|---|---|---|---|
| **Telegram bot** (Bot API) | Free | High among urban phone users but below WhatsApp. About 45% regular use is a Statista-based figure on aggregators **[unverified]**. | Low: create bot with BotFather, set webhook to the Worker, deep link `t.me/<bot>?start=<token>` to link the account | About 30 messages/second free for broadcast; about 1/second to one chat. Official: [Telegram Bot FAQ](https://core.telegram.org/bots/faq). **Risk:** India blocked Telegram for about a week from 16 Jun 2026 (NEET-UG re-exam) under section 69A; restored 22 to 23 Jun ([The Week](https://www.theweek.in/news/sci-tech/2026/06/23/telegram-ban-lifted-in.html)). A repeat is possible, so do not make it the only channel. |
| **Web Push** (PWA, VAPID) | Free | Android Chrome: good. iOS: only for a web app **added to the Home Screen** (iOS 16.4+), prompt must follow a tap ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados)). Many users won't install. | Medium: service worker push handler, subscribe UI, VAPID keys, Web Push encryption with WebCrypto, no npm | Subscriptions expire (410 responses, prune). Payload encryption plus ECDSA signing cost CPU (see §6). Our `run_worker_first` and CSP are compatible. |
| **Email digest** | Free via third party | Everyone has email, but low urgency for flat hunting | Low to medium | Cloudflare Email Service sending is **Workers Paid only** (3,000 emails a month included, then $0.35 per 1,000) ([Cloudflare](https://developers.cloudflare.com/email-service/platform/pricing/)); Email Routing is inbound/forward only. [Resend](https://resend.com/pricing.md) free: 3,000/month and 100/day. [Brevo](https://help.brevo.com/hc/en-us/articles/208580669) free: 300/day, sticker on mails. Needs a verified sending domain (we have only `workers.dev`, so we would need to buy a domain, about ₹1,000 a year) for good deliverability. Resend/Brevo limits **[from search summaries, confirm on vendor pages]**. |
| **Discord** | Free | Low for this audience | Medium (server or DM bot) | Not worth it. |
| **ntfy** | Free | Very low (needs the ntfy app) | Low | Nerd-friendly only; public topics leak data. Skip. |

## 6. Design on our stack

Principles: channel-agnostic core, one alert queue, send digests not single posts, always resumable, never exceed `repo.left()`.

### 6.1 Data model (migration `0004_alerts.sql`, add-only)

```sql
-- where a user can be reached; one row per (user, channel)
CREATE TABLE alert_channels (
  user_id      TEXT NOT NULL,
  channel      TEXT NOT NULL,          -- 'telegram' | 'webpush' | 'whatsapp' | 'email'
  target       TEXT NOT NULL,          -- tg chat_id | push subscription JSON | E.164 phone | email
  verified     INTEGER NOT NULL DEFAULT 0,
  link_token   TEXT,                   -- one-time token for deep link / OTP, hashed, expires
  token_expires_at TEXT,
  paused       INTEGER NOT NULL DEFAULT 0,  -- STOP / blocked-by-user
  quiet_start  INTEGER NOT NULL DEFAULT 22, -- IST hour, alerts held until quiet_end
  quiet_end    INTEGER NOT NULL DEFAULT 8,
  daily_cap    INTEGER NOT NULL DEFAULT 20, -- max listings per day
  failures     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, channel)
);
-- which areas alert on which channel (subset of user_areas)
CREATE TABLE alert_subscriptions (
  user_id    TEXT NOT NULL,
  area_id    INTEGER NOT NULL,
  channel    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, area_id, channel)
);
-- queue + dedupe log in one table: one row per (user, listing)
CREATE TABLE alert_queue (
  user_id    TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  area_id    INTEGER NOT NULL,
  channel    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at    TEXT,                     -- NULL = pending
  PRIMARY KEY (user_id, listing_id, channel)
);
CREATE INDEX alert_queue_pending ON alert_queue (sent_at, channel, user_id);
```

The primary key on `(user_id, listing_id, channel)` is the dedupe: a listing that matches two followed areas, or is reposted and merged, is queued once. Purge `sent_at` rows older than 7 days in the existing daily purge. Requires a user to have `user_areas` for the area (enforced in the API). Old code ignores these tables (rollback-safe).

### 6.2 Hook into ingest

In `saveIngest()` (`src/ingest.js`) after new listings and `listing_match` rows are in the batch, add **one** statement:

```sql
INSERT OR IGNORE INTO alert_queue (user_id, listing_id, area_id, channel, created_at)
SELECT s.user_id, m.listing_id, m.area_id, s.channel, :now
FROM listing_match m
JOIN alert_subscriptions s ON s.area_id = m.area_id
JOIN alert_channels c ON c.user_id = s.user_id AND c.channel = s.channel
WHERE m.listing_id IN (:newIds) AND m.area_id != 0
  AND c.verified = 1 AND c.paused = 0;
```

Rules: only **new** listings from this run (not merged reposts, not area backfill, not rows older than about 24 h by `last_posted_at`), offers only by default (seeking posts are not flats for rent), skip `is_sample`. This is 1 extra query inside the existing batch, so it does not change the 48 budget. Rows written per run is the number of (listing, subscriber) pairs; at 1,000 users x ~3 matches a day that is about 3,000 rows a day, far under 100k.

### 6.3 Sending (resumable cron step, like the AI queue)

`alertStep()` in `extras()`, runs after AI enrich, needs at least about 10 queries left:

1. `SELECT` pending rows grouped by user and channel, oldest first, limit N users (1 query). Skip users in quiet hours (computed in code, IST) and users over `daily_cap`.
2. For each user build **one digest** message: count, then up to 5 lines ("2 BHK, ₹28,000, Green Glen Layout, 2 h ago") and a link `…/#browse?area=<id>` or `#listing-<id>`; "+N more" link. Fewer, bigger messages cut WhatsApp cost 3x and Telegram noise.
3. Send (1 subrequest per user for Telegram or WhatsApp; Web Push 1 per subscription), then `UPDATE alert_queue SET sent_at` for those rows in one batched statement. On HTTP 403/400 "blocked" or 410 gone, set `paused=1`; on 429 stop and retry next tick; on other errors increment `failures`, pause the channel at 5.
4. Budget: Workers Free allows **50 subrequests per invocation**, so about 40 users per invocation after the D1 calls. 1,000 users take 25 invocations, so the hourly cron is too slow if everyone is due at once. Options: (a) a second Cron Trigger every 5 minutes just for alerts (Free plan has 5 triggers; invocation count is trivial), (b) `ctx.waitUntil(alertStep)` after each ingest webhook (same pattern as AI enrich). Do (b) plus (a) only when subscribers exceed about 40. At today's scale (tens of users) one hourly pass is enough, and alerts arrive within an hour of the scrape.
5. **CPU 10 ms:** Telegram and WhatsApp sends are plain `fetch` (network wait does not count) so CPU is small. **Web Push is the risk**: per send, ECDH, HKDF and AES-GCM encrypt plus an ECDSA-signed VAPID JWT. Cache the JWT per push-service origin for up to 12 h, send an empty-payload push and let the service worker fetch the digest from the API (avoids encryption entirely: the user's service worker calls `GET /api/alerts/pending`). That removes payload crypto and keeps privacy simple. Measure in the Node CPU tests as we do for ingest pages.

### 6.4 Linking and opt-in

- **Telegram:** signed-in user taps "Connect Telegram", API creates a random token (store hash, expires in 15 min) and returns `https://t.me/<bot>?start=<token>`. Bot webhook (`POST /api/alerts/telegram/<secret-path>`, verify `X-Telegram-Bot-Api-Secret-Token`) receives `/start <token>`, stores `chat_id`, sets `verified=1`, replies with what they will receive and "send /stop to stop". `/stop` sets `paused=1`; `/start` again resumes.
- **WhatsApp (if added):** user enters their number; we send an OTP template (authentication category, ₹0.145) or have them message the business number with a code so the 24 h window opens and the opt-in is recorded by the inbound message (cheaper and a stronger consent record). Reply STOP/"band karo" sets `paused=1` and confirms in-window.
- Store consent time and channel in the row; no third-party phone numbers are needed anywhere in this table other than the user's own.

### 6.5 Privacy

- Alerts go to third-party platforms (Telegram, Meta, Google/Apple push). **Never send phone numbers, emails, author names, society names or post text.** Send BHK, rent, area name, age, and a link back to the signed-in app, where the full listing (with contact) is behind the existing login. This keeps `docs` invariant 1 and avoids WhatsApp content review problems.
- Only `user` and `admin` roles can create subscriptions (`pending` and public get 403/401). Re-check role at send time (a blocked user stops receiving immediately).
- A user's own phone/chat id is personal data: never log it, never return it from admin APIs in full (mask), delete on account removal and on STOP-plus-unlink.
- Update the privacy page copy: alert channels, what is sent, how to stop.

### 6.6 Controls and abuse limits

- Per-user `daily_cap` (default 20 listings, digest says "+N more"), quiet hours 22:00 to 08:00 IST by default (alerts held, then sent as one morning digest), one digest per channel per run at most, minimum 30 minutes between digests to the same user.
- Admin page (`#admin-alerts`): global on/off switch per channel in `settings.alerts`, counts (subscribers by channel, queued, sent today, paused, failures), per-channel kill switch, WhatsApp spend this month with a monthly cap that stops sending when reached (mirrors the Apify budget guard).
- Rate limit link-token creation per user. Cap subscriptions per user (e.g. 10 areas) so one user cannot blow the queue.
- Tests required (project rule): subscription creation by role, dedupe across areas and reposts, no alerts for backfill or sample rows, digest contains no phone/email, quiet hours and cap, 403 pauses channel, queue drain stays within `repo.left()`, resume after partial send, STOP.

### 6.7 Size

| Piece | Size |
|---|---|
| Migration, queue hook in `saveIngest`, `alertStep`, digest builder, user API (`/api/alerts/*`), admin counts, tests | **M** |
| Telegram adapter (link, webhook, send, STOP) | **S** on top of core |
| Web Push adapter (service worker, VAPID, subscribe UI, pending endpoint) | **M** (UI and service worker work, CSP review) |
| WhatsApp adapter (Cloud API send, template approval, webhook signature check, OTP/opt-in, spend cap, STOP) | **M** code, plus the founder tasks in §7; ongoing cost |
| Email digest adapter | **S** (plus domain and sender setup) |

Whole thing with Telegram and core: **M**. Adding Web Push and WhatsApp: **L** in total.

## 7. Recommended plan

1. **Phase 1 (free):** alert core + **Telegram** bot. Digest per run, area only. Cost ₹0. Fits Workers Free.
2. **Phase 2 (free):** **Web Push** for Android Chrome and installed iOS PWAs, because Telegram was blocked in India for a week in June 2026 and not everyone uses it. Use the empty-push + fetch design to stay within 10 ms CPU.
3. **Phase 3 (only if the founder wants it and will pay):** **WhatsApp via Meta Cloud API direct**, one digest a day, plan on the **marketing** rate. Start with an invite-only cap (for example 100 users, about ₹3,300 a month plus GST, about ₹0.4 to ₹1.0 per user per day of alerts) and a hard monthly spend cap in settings. A free-form pull ("send new") mode inside the 24 h window is possible for light users within the 1,000 free service messages a month, but it is not an alert.
4. Email digest is optional filler; it needs a domain and a free-tier provider.

### What the founder must set up or decide

For Telegram: create the bot in BotFather (free, 5 minutes), add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as GitHub Actions secrets. Add `api.telegram.org` to the connect allowlist only if the browser ever calls it (it does not; the Worker does).

For WhatsApp (decide first whether to fund it):
- A Meta Business portfolio and WhatsApp Business Account owned by the founder; a **dedicated phone number** never used on the WhatsApp app (a new SIM) that can receive an OTP.
- A **registered identity** for Business Verification: Udyam registration (free), Shop and Establishment or GST, with matching name and a simple website that shows it. Without it the number is capped and the display name is restricted. **[unverified; confirm with Meta]**
- A payment method on Meta (INR billing before 31 Dec 2026), a monthly budget, and acceptance that the category (utility vs marketing) is Meta's call.
- Approved message templates (digest, OTP) in English and Hindi if wanted; STOP handling copy.
- A policy decision on pricing: the app is free for users, so either the founder absorbs the cost, only a limited number of users get WhatsApp, or it stays Telegram plus push.

## 8. Unverified list (check before building)

- Exact current India INR rates for marketing, utility and service, and the 1 Oct 2026 service-message changes (Meta rate card).
- Utility versus marketing classification of a new-listing digest (submit a template and see what Meta assigns).
- Business verification eligibility for an unregistered individual, and the current messaging-limit ladder after 250.
- Resend and Brevo free limits; Cloudflare Email Service price after launch.
- Telegram availability risk in India after the June 2026 block.
- Whether BSP free credits or zero-markup claims hold for a low-volume sender.

## Sources

- [Meta: WhatsApp Business Platform pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- [AiSensy: per message pricing, India rates](https://m.aisensy.com/blog/whatsapp-per-message-pricing-update-effective-january-1-2026/)
- [Baat: India API costs 2026](https://baat.ai/blog/whatsapp-api-pricing-india), [Baat: messaging limits](https://baat.ai/blog/whatsapp-messaging-limits)
- [Formbeep: pricing summary](https://formbeep.pages.dev/whatsapp-api-pricing/)
- [360dialog: messaging limits](https://docs.360dialog.com/docs/resources/wabas/messaging-limits), [Dotdigital](https://marketing.help.dotdigital.com/en/articles/10485811-understand-whatsapp-messaging-limits), [Exotel limits](https://developer.exotel.com/docs/whatsapp-support/messaging-limits)
- [Exotel business verification](https://developer.exotel.com/docs/whatsapp-support/business-verification), [Zoko documents](https://www.zoko.io/post/whatsapp-business-api-documents-needed), [Hyperleap apply guide](https://hyperleap.ai/whatsapp-business-api/apply)
- [MyOperator BSP comparison](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026), [Chatlivo](https://dev.to/chatlivo/whatsapp-business-api-pricing-2026-india-rates-free-tier-21ed)
- [Telegram Bot FAQ](https://core.telegram.org/bots/faq), [The Week: Telegram restored in India](https://www.theweek.in/news/sci-tech/2026/06/23/telegram-ban-lifted-in.html)
- [WebKit: Web Push for Web Apps on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados)
- [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/), [Resend pricing](https://resend.com/pricing.md), [Brevo free plan limits](https://help.brevo.com/hc/en-us/articles/208580669)
