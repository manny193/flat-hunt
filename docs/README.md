# Flat Hunt documentation

Two audiences, two folders. Everything else in `docs/` is a topic document that both can use.

## Which doc is for whom

| Doc | Audience | What it answers |
|---|---|---|
| `/CLAUDE.md` (repo root) | AI agents (loaded automatically) | Commands, code map, hard limits, privacy and testing rules, how to update tracking. Keep it short. |
| `docs/ai/ARCHITECTURE.md` | AI agents, engineers | Exact modules, routes, data flow, tables, invariants, extension points |
| `docs/ai/COSTS.md` | Engineer (Finance page), founder, chief of staff | Free limits, prices, how to measure usage, cost formulas, scenarios |
| `docs/ai/ALERTS-WEBPUSH.md` | Engineer, architect, QA | Area alerts over Web Push: HLD, data model, API, cron budget, task breakdown (channel research: `docs/ai/ALERTS.md`) |
| `docs/human/ARCHITECTURE.md` | Founder, stakeholders, new team members | What each part does and why it is free, in plain words |
| `docs/human/APP-FLOWS.md` | Founder, stakeholders, designer, QA | What visitors, users and admins do, step by step; how a post becomes a listing |
| `docs/TRACKING.md` | Everyone | How work is tracked (GitHub Issues + Project), labels, columns, agent rules |
| `docs/HANDOFF.md` | Everyone picking the project up | History, decisions (D1–D22), live status, open issues |
| `docs/DEPLOY.md` | Founder, engineer | Setup, secrets, deploy, rollback, platform choice |
| `docs/APIFY.md` | Engineer | Scraper actor, inputs, cost experiment |
| `docs/AI-EXTRACTION.md` | Engineer | AI model choice, prompt, schema, merge rules |
| `docs/DESIGN.md` (+ `docs/mockups/`) | Designer, engineer | Visual design spec and tokens |
| `docs/AGENT-BROWSER.md` | AI agents, founder | Private per-session Chrome for Claude (setup, isolation design, rules) |
| `docs/QA.md` | QA, chief of staff | Test rounds, bugs, open risks, verdicts |
| `docs/OWNERS.md` | Everyone | Who owns which files |

## Rule for keeping docs current

1. **Same change, same commit.** A change that alters behaviour, data flow, a table, a limit, a cost or a user-visible flow updates the matching doc in the same commit. A PR that changes `src/` or `web/` without touching docs must say why in its description ("no doc impact").
2. **Who updates what:**

   | Doc | Updated by | When |
   |---|---|---|
   | `CLAUDE.md` | Architect (anyone may propose) | New command, constraint, rule or doc location |
   | `docs/ai/ARCHITECTURE.md` | The engineer making the change; the architect reviews | Any change to modules, routes, tables, invariants, cron steps |
   | `docs/ai/COSTS.md` | Architect | Provider price change, new service, measured usage that differs from the estimate. Re-check all prices quarterly |
   | `docs/human/*` | Architect or designer, from the engineer's change note | Any change a user or admin would notice; reviewed by the chief of staff for plain language |
   | `docs/TRACKING.md` | Chief of staff | Changes to columns, labels or rules |
   | `docs/HANDOFF.md` | Chief of staff | End of each work session: status, decisions, open issues |
   | `docs/QA.md` | QA | Each test round |
   | Topic docs (`DEPLOY`, `APIFY`, `AI-EXTRACTION`, `DESIGN`) | Owner in `docs/OWNERS.md` | When their area changes |

3. **QA checks docs too.** Before sign-off, QA confirms the docs listed above match the change.
4. **Dates.** Each doc carries a "last updated" date or a commit reference near the top. Prices always carry the date they were checked and a source link.
5. **Plain English.** Short sentences, no hype. Human docs avoid code names unless they help; AI docs prefer exact names (files, functions, tables) over prose.
6. **One source of truth.** Don't copy facts between docs. Link to them. Exceptions: `CLAUDE.md` repeats the hard limits on purpose, and the human docs restate things in plain words.

Note: an untracked copy of `HANDOFF.md` sits at the repo root. On 8 Nov it was identical to `docs/HANDOFF.md`, which is the tracked one. The chief of staff should delete the root copy so the two cannot drift apart.
