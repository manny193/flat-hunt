# Apify plan

Checked 2026-11-07 from public Apify Store pages. Could not do a live test run from the build workspace (its network blocks api.apify.com); the first real run happens from production, and the ingest code accepts both field layouts below.

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
