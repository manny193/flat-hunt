# Apify plan

Checked 2026-11-07 from public Apify Store pages. Could not do a live test run from the build workspace (its network blocks api.apify.com); the first real run happens from production, and the ingest code accepts both field layouts below.

## Cost plan (8 Nov 2026, measured live)

A live experiment (4 tiny runs, ~$0.04) settled how we pay and what the actor accepts:

| Finding | Evidence | What we do |
|---|---|---|
| `postsPublishedAfter` takes an exact UTC time, but **not milliseconds** | `2026-11-08T05:00:00Z` accepted, 0 older posts returned; `…00.000Z` rejected with HTTP 400 (input pattern `YYYY-MM-DD[THH:MM[:SS][Z]]`) | Send `apifyTime(t)` = ISO without ms. Cutoff = last good start − 15 min (was: date only, which re-bought every post since midnight UTC) |
| We pay per dataset row: posts **and** group rows ($0.0012 each) | Pricing: event `apify-default-dataset-item`, "One post or group in the dataset" | `includeGroupInfo: false`; group details only weekly or when the watched list changes. Names come from stored details or our settings |
| Platform usage per run is tiny | `usageTotalUsd` ≈ $0.00015 for a 10-post run | Scrape often: run frequency barely changes cost. Default IST run hours 6, 9, 11, 13, 15, 17, 19, 21 |
| Right after a run, `chargedEventCounts` can still show 0 rows | 10 rows written, 0 reported | Run cost = platform usage + max(charged rows, rows we read) × row price |
| A group's search link (`/search/?q=bhk`) is ignored | Same posts as the plain group (7 of 10 mention "bhk" in both) | No keyword pre-filter is possible; choose groups carefully instead |
| Apify can cap a run | Run options `maxItems`, `maxTotalChargeUsd` | Every run passes both: rows ≤ groups × posts-per-group (+ group rows), charge ≤ min(natural ceiling × 1.2, admin "max spend per run", default $0.50) |

Posts per group is now a safety cap (default 30, max 50). Admin → Groups shows each group's spend, new listings per dollar, and a "Low value" flag (20+ posts in 7 days, under 15% became new listings).

## Actor choice

| Actor | Price | Fetch only new posts | Track record | Use |
|---|---|---|---|---|
| `automly/facebook-public-group-posts-scraper` | $1.20 / 1,000 posts + $0.00005 per run | `postsPublishedAfter` date cutoff, `sortOrder: "new"` | 92.5% runs succeed, small user base (20 users) | **Primary** (cheapest; run report lists private/unscrapable groups) |
| `apify/facebook-groups-scraper` (official) | from $2.60 / 1,000 posts | timeframe option, newest-first sort | Maintained by Apify, 47K users, 4.9★ | **Fallback** if the primary breaks (switch with one config value) |
| `memo23/apify-facebook-group-scraper` | from $1.50 / 1,000 | `monitoringMode`, `onlyPostsNewerThan` | 549 users but 1.3★ (2 ratings) | Not used |

No Facebook login or cookies for either chosen actor; public groups only.

## Budget: the rule that keeps this free

Free plan = US$5 credit per month, and the free plan cannot overspend (runs stop when credit runs out, no bill).
At $1.20/1,000 that is ~4,000 posts/month, ~130/day across all groups. Frequency does not change cost; **volume of new posts does**. So:

1. **Never pay twice for a post.** Our backend starts each run itself with `postsPublishedAfter` = time of the last successful run minus 1 hour (small overlap; duplicates are dropped for free by our post_keys table).
2. **Prefer area-focused groups** (Bellandur / HSR / Sarjapur / ORR / Marathahalli) over city-wide ones that post hundreds a day.
3. **Budget guard:** before starting a run the backend reads `GET /v2/users/me/limits` (monthly usage vs limit). Above 80% it halves posts per group; above 95% it skips runs until the cycle resets. The UI shows "Apify credit used: $x of $5".
4. Start with `resultsPerGroup: 25`, run every 4 hours (6 runs/day). Measure the first week, then tune.

## How runs happen (no Apify Schedule needed)

```
our cron (every 4h) ──► budget check ──► (starts the new run first) POST /v2/acts/{actor}/runs   (input built from DB: groups + cutoff)
                                              │  webhook on ACTOR.RUN.SUCCEEDED (registered per run via ?webhooks=)
                                              ▼
            POST https://<site>/api/ingest/apify   header X-Ingest-Secret, body {datasetId, runId}
                                              │
            then the same cron sweeps: GET /v2/acts/{actor}/runs?status=SUCCEEDED&desc=1&limit=3
            and ingests one dataset not yet done (webhook missed, or a partial ingest to resume)
```

- Start a run: `POST https://api.apify.com/v2/acts/automly~facebook-public-group-posts-scraper/runs?webhooks=<base64 JSON>` with `Authorization: Bearer $APIFY_TOKEN`, body = input JSON.
- Per-run webhook (base64 of a JSON array): `[{"eventTypes":["ACTOR.RUN.SUCCEEDED"],"requestUrl":"https://<site>/api/ingest/apify","headersTemplate":"{\"X-Ingest-Secret\":\"<secret>\"}","payloadTemplate":"{\"datasetId\":{{resource.defaultDatasetId}},\"runId\":{{resource.id}}}"}]`
- Dataset items, read in pages: `GET https://api.apify.com/v2/datasets/{datasetId}/items?clean=true&format=json&limit=25&offset=N` (no `fields=`: the actors' column names are unverified, so we read whole rows; a page cut off mid-way is resumed from the saved offset)
- Usage: `GET https://api.apify.com/v2/users/me/limits`

## Inputs

Primary (`automly/…`):
```json
{ "groups": ["https://www.facebook.com/groups/<id-or-slug>", "…"],
  "resultsPerGroup": 25, "sortOrder": "new",
  "postsPublishedAfter": "2026-11-07T00:00:00Z", "includeGroupInfo": true }
```
Fallback (`apify/…`): `{ "startUrls": [{"url": "…"}], "resultsLimit": 25, "viewOption": "CHRONOLOGICAL", "onlyPostsNewerThan": "<ISO date>" }` (field names to confirm on first run).

## Output → our fields

| Ours | automly (rows with `type: "post"`) | official |
|---|---|---|
| text | `text` | `text` |
| url | `url` | `url` |
| time | `createdAt` (ISO) | `time` (ISO) |
| author | `authorName` | `user.name` |
| group | name from the matching `type: "group"` row (`id` = post's `groupId`, field `name`) | `groupTitle` |
| groupUrl | `source` | `facebookUrl` / input URL |
| images | `media[].imageUrl` (type photo) | `attachments[].…` |

Skip rows whose `type` is `"group"` or `"report"` after building the group-name map. Facebook image URLs expire within days.

## Secrets
`APIFY_TOKEN` (Apify console → Settings → API & Integrations), `INGEST_SECRET` (random 32+ chars), optional `APIFY_ACTOR` (default primary id).
