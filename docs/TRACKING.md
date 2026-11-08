# Work tracking: recommendation and setup

Status: **live** since 8 Nov 2026: https://github.com/users/manny193/projects/1 (project number 1). Written by the architect.

## Recommendation: GitHub Issues + one GitHub Project

Use GitHub Issues in `manny193/flat-hunt` for every work item, and one user-level GitHub Project called "Flat Hunt" as the board.

Why:
1. **₹0 now and as the team grows.** Issues and Projects are included in GitHub Free for private repos. Personal accounts get unlimited collaborators on private repos. There is no per-seat price, unlike Jira, Linear and Plane after their free tiers.
2. **Agents can already use it.** `gh` is installed and logged in on the founder's Mac. Agents can create, label, comment on and close issues with plain `gh issue …` commands, and move board cards with `gh project …`. No new account, API key or MCP server is needed.
3. **Work links itself.** Commits and PRs that say `Fixes #12` close the issue and move the card. Code, discussion and history stay in one place, next to the docs.
4. **Board, table and roadmap views.** Projects offer all three, with custom fields (up to 50) and built-in automations.
5. **Low lock-in.** Issues export through the API and `gh`. If the team ever moves, Linear, Jira and Plane all import GitHub issues.

Limits to accept:
- Projects views and built-in workflows can only be set up in the web UI. The CLI cannot create views.
- GitHub Free allows **one auto-add workflow** per project. That is enough for one repo.
- `gh` needs the `project` scope, which the current token lacks: it has `repo`, `workflow`, `read:org`, `gist`. The founder must run one interactive command to add it (step 0 below).

## Options compared (checked 8 Nov 2026)

| Tool | Cost now | Cost as team grows | Agents via CLI/API | Private repo link | Views | Automation | Lock-in |
|---|---|---|---|---|---|---|---|
| **GitHub Issues + Projects** | Free | Free (unlimited collaborators on private repos) | `gh` CLI already logged in; GraphQL/REST | Native (same repo) | Table, board, roadmap | Built-in workflows (auto-add: 1 on Free), Actions, `Fixes #N` | Low |
| Linear Free | Free | Free plan: unlimited members but **250 issues** and 2 teams, then $10/user/month (Basic) | API, webhooks, MCP on Free | GitHub integration | Board, list, roadmap | Good | Medium |
| Jira Free | Free up to 10 users | $7.91/user/month Standard [secondary source] | REST API; needs an Atlassian token per agent | Integration app | Board, timeline | **100 automation runs/month** on Free | High |
| Plane Cloud Free / self-host | Free up to 12 users | $6–8/user/month (Pro); self-host is free but we would have to run a server | API | GitHub sync | Board, list, cycles | Moderate | Low–medium |
| Trello Free | Free | 10 collaborators and 10 boards per workspace, then paid | REST API with key + token | Power-Up | Board only on Free | 250 command runs/month | Medium |
| Notion Free | Free | Guests capped at 10; members need paid seats | API with integration token | Weak | Board, table, timeline | Limited | High |
| Markdown in repo | Free | Free | Plain file edits | Native | None (just text) | None | None |

Markdown alone is the simplest, but it has no board and no "who is waiting on whom" view. It also causes merge conflicts when several agents edit the same file. It stays useful for decisions (`docs/HANDOFF.md`), not for task state.

## Board design

**Status field** (the board columns), in order:

| Column | Meaning | Who moves cards in |
|---|---|---|
| Ideas | Future ideas. Not committed, not started | anyone |
| To do | Agreed, ready to start | chief of staff |
| In progress | Someone is working on it now | the agent or founder doing it |
| Waiting on founder | Blocked until the founder answers or acts | whoever is blocked |
| In review | Work done; QA or the chief of staff is checking | the agent who finished |
| Done | Shipped or answered | QA / chief of staff (or automatic on close) |

**Focus field** (single select): `Now`, `Next`, `Later`. This shows the focus areas. "Now" should hold no more than 3–5 items, and the chief of staff sets it.

**Labels:**
- Type: `type:bug`, `type:feature`, `type:chore`, `type:research`, `type:decision`, `type:idea`
- Area: `area:scraper`, `area:ingest`, `area:ai`, `area:ui`, `area:auth`, `area:infra`, `area:docs`, `area:costs`, `area:privacy`
- Owner: `owner:founder` (a human must act), `owner:agent`
- Role (which agent): `role:engineer`, `role:senior-engineer` (code review, production pushes), `role:qa`, `role:designer`, `role:architect`, `role:chief-of-staff`

**How "pending on founder" shows:**
- The item gets the label `owner:founder` and Status "Waiting on founder".
- The first line of its latest comment states the exact question or action, for example "Decide: 10 groups on Apify Starter ($19/month)?".
- A saved board view called **Founder**, filtered on `label:owner:founder -status:Done`, gives the founder one list. From the terminal: `gh issue list -R manny193/flat-hunt -l owner:founder`.

**Saved views to create in the UI:** Board (group by Status), Now (filter `focus:Now`), Founder (as above), Ideas (filter `status:Ideas`), Roadmap (by Target date).

**Built-in workflows to switch on in the UI:**
- Auto-add issues from `manny193/flat-hunt` (filter `is:issue`).
- Item added → Status "To do".
- Item closed → "Done".
- Pull request merged → "Done".
- Item reopened → "In progress".

## Setup commands (chief of staff runs these after the founder approves)

Step 0, by the founder (opens a browser to approve the extra scope):
```sh
gh auth refresh -h github.com -s project
```

Steps 1–5:
```sh
REPO=manny193/flat-hunt
OWNER=manny193

# 1. Labels (--force updates a label if it already exists)
for l in "type:bug|d73a4a|Something is broken" "type:feature|a2eeef|New capability" "type:chore|cfd3d7|Maintenance, upgrades, cleanup" \
         "type:research|5319e7|Find out before building" "type:decision|fbca04|Needs a decision" "type:idea|c5def5|Future idea, not committed" \
         "area:scraper|0e8a16|Apify, Reddit, schedule" "area:ingest|0e8a16|Parsing, dedupe, listings" "area:ai|0e8a16|AI extraction" \
         "area:ui|0e8a16|Web app screens" "area:auth|0e8a16|Sign-in, roles" "area:infra|0e8a16|Cloudflare, CI/CD, backups" \
         "area:docs|0e8a16|Documentation" "area:costs|0e8a16|Spend and budgets" "area:privacy|0e8a16|Personal data handling" \
         "owner:founder|b60205|Waiting on the founder" "owner:agent|1d76db|An AI agent owns this" \
         "role:engineer|bfdadc|Engineer agent" "role:qa|bfdadc|QA agent" "role:designer|bfdadc|Designer agent" \
         "role:architect|bfdadc|Architect agent" "role:chief-of-staff|bfdadc|Chief of staff"; do
  IFS='|' read -r name color desc <<< "$l"
  gh label create "$name" --color "$color" --description "$desc" -R "$REPO" --force
done

# 2. Project, linked to the repo
N=$(gh project create --owner "$OWNER" --title "Flat Hunt" --format json --jq .number)
gh project link "$N" --owner "$OWNER" --repo "$REPO"
echo "Project number: $N"

# 3. Extra fields
gh project field-create "$N" --owner "$OWNER" --name "Focus" --data-type SINGLE_SELECT --single-select-options "Now,Next,Later"
gh project field-create "$N" --owner "$OWNER" --name "Target" --data-type DATE

# 4. Board columns: replace the default Status options (Todo / In Progress / Done).
#    Safe only while the project is empty: this call replaces the whole option list.
FID=$(gh project field-list "$N" --owner "$OWNER" --format json --jq '.fields[] | select(.name=="Status") | .id')
gh api graphql -f fid="$FID" -f query='
mutation($fid: ID!) {
  updateProjectV2Field(input: {fieldId: $fid, singleSelectOptions: [
    {name: "Ideas",              color: PURPLE, description: "Future ideas, not committed"},
    {name: "To do",              color: GRAY,   description: "Agreed and ready to start"},
    {name: "In progress",        color: BLUE,   description: "Being worked on now"},
    {name: "Waiting on founder", color: RED,    description: "Blocked until the founder acts"},
    {name: "In review",          color: YELLOW, description: "Done, being checked by QA"},
    {name: "Done",               color: GREEN,  description: "Shipped or answered"}
  ]}) { projectV2Field { ... on ProjectV2SingleSelectField { options { id name } } } }
}'

# 5. Open it to create the saved views and switch on the workflows listed above (UI only)
gh project view "$N" --owner "$OWNER" --web
```

Optional seed: turn the open items from `docs/HANDOFF.md` §8–9 into issues (with the auto-add workflow on, they land on the board).
```sh
R=manny193/flat-hunt
gh issue create -R $R -t "Turn on 'Require approval' before sharing the link" -l "owner:founder,type:decision,area:privacy" -b "HANDOFF §8.1 / §9.3. Admin → Users."
gh issue create -R $R -t "Confirm the Apify token was regenerated" -l "owner:founder,type:chore,area:infra" -b "HANDOFF §8.2. Do not paste the token anywhere."
gh issue create -R $R -t "Add 'Workers AI: Read' to the Cloudflare API token" -l "owner:founder,type:chore,area:infra" -b "HANDOFF §8.3."
gh issue create -R $R -t "Set up Google sign-in (OAuth client + secrets + ADMIN_EMAILS)" -l "owner:founder,type:chore,area:auth" -b "HANDOFF §8.4 and docs/DEPLOY.md."
gh issue create -R $R -t "Reddit API access: apply, or drop Reddit if approvals are closed" -l "owner:founder,type:decision,area:scraper" -b "HANDOFF §8.5. docs/ai/COSTS.md: new requests may have closed on 31 Oct 2026 (unverified)."
gh issue create -R $R -t "Choose more Facebook groups within budget" -l "owner:founder,type:decision,area:costs" -b "HANDOFF §8.6. docs/ai/COSTS.md §3: ~\$1.42 per group per month."
gh issue create -R $R -t "Fix AI extraction 'invalid JSON' in production" -l "owner:agent,role:engineer,type:bug,area:ai" -b "HANDOFF §9.2."
gh issue create -R $R -t "Move public rate limit off D1 (edge rate limiter)" -l "owner:agent,role:engineer,type:chore,area:infra" -b "HANDOFF §9.4."
gh issue create -R $R -t "Measure real Worker CPU per request and per ingest page" -l "owner:agent,role:engineer,type:research,area:infra" -b "HANDOFF §9.5."
gh issue create -R $R -t "Retention purge caps at 500 listings/day; falls behind above ~23 groups" -l "owner:agent,role:engineer,type:bug,area:ingest" -b "docs/ai/COSTS.md §5."
gh issue create -R $R -t "Build admin Finance page" -l "owner:agent,role:engineer,type:feature,area:costs" -b "Inputs in docs/ai/COSTS.md §7."
```

## How agents update it

Find the IDs once per session:
```sh
OWNER=manny193; N=<project number>
PID=$(gh project view "$N" --owner "$OWNER" --format json --jq .id)
FID=$(gh project field-list "$N" --owner "$OWNER" --format json --jq '.fields[] | select(.name=="Status") | .id')
opt() { gh project field-list "$N" --owner "$OWNER" --format json --jq ".fields[] | select(.name==\"Status\") | .options[] | select(.name==\"$1\") | .id"; }
item() { gh project item-list "$N" --owner "$OWNER" --format json --limit 500 --jq ".items[] | select(.content.number==$1) | .id"; }
move() { gh project item-edit --id "$(item "$1")" --project-id "$PID" --field-id "$FID" --single-select-option-id "$(opt "$2")"; }
```

Rules:
1. **Starting:** `gh issue edit 12 -R manny193/flat-hunt --add-label owner:agent,role:engineer` and `move 12 "In progress"`.
2. **Blocked on the founder:** `gh issue edit 12 --add-label owner:founder`, then `move 12 "Waiting on founder"`, then `gh issue comment 12 -b "Founder: <one clear question or action>"`. When the founder answers, remove the label and move the card back.
3. **Finished:** reference the issue in the commit or PR (`Fixes #12`), comment with what changed and how it was tested, then `move 12 "In review"`. QA moves it to Done or back to In progress with a comment.
4. **New idea found during work:** `gh issue create -t "…" -l type:idea -b "…"`, then `move <n> Ideas`. Do not start it.
5. **Never** put secrets, tokens or personal data (phone numbers, names from posts) in issues or comments.
6. Only the chief of staff sets Focus = Now and moves items from Ideas to To do.

## Sources

- GitHub Projects overview (views, 50 fields, workflows): https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects
- Auto-add limits (1 on Free): https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically
- GitHub plans (unlimited collaborators on private repos): https://docs.github.com/en/get-started/learning-about-github/githubs-plans
- `updateProjectV2Field` input checked by GraphQL introspection on 8 Nov 2026 (fields: `fieldId`, `singleSelectOptions[{name, color, description}]`).
- Linear pricing: https://linear.app/pricing
- Plane pricing: https://plane.so/pricing
- Jira Free limits (secondary): https://www.eesel.ai/blog/jira-pricing-guide , https://www.breeze.pm/articles/atlassian-pricing-changes-2026
- Trello / Notion free limits (secondary): https://dupple.com/learn/is-trello-free , https://dupple.com/learn/is-notion-free
