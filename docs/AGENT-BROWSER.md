# Agent browser (Claude acting in Chrome on your behalf)

Last updated: 12 Nov 2026.

Gives Claude Code a real Chrome it can drive (open pages, click, fill forms, take screenshots) **without touching your own Chrome**, and with **one private browser per Claude session**.

## Why this design

| Option | Your tabs safe? | Sessions kept apart? | Logins | Verdict |
|---|---|---|---|---|
| Claude in Chrome extension | No. It works in your real Chrome, next to your own tabs, with all your logins | Weak. Every Claude session talks to the same extension and the same browser | All of yours | Not chosen |
| Playwright MCP `--extension` | No. It attaches to your running Chrome | Weak | All of yours | Not chosen |
| Playwright MCP, one shared persistent profile | Yes | No. A Chrome profile can only be open once, so a second session fails or shares state | Saved | Not chosen |
| **Playwright MCP, private profile per session, copied from a seed (this)** | **Yes. Separate Chrome process and window** | **Yes. Each session has its own Chrome and profile; nothing is shared** | **Only the sites you signed into in the seed** | **Chosen** |

How it works (`scripts/agent-browser/mcp.sh`):

1. Claude Code starts one copy of the MCP server per session (stdio), so each session launches its own Chrome.
2. The script copies the seed profile (`~/.claude-agent-browser/seed-profile`) into `~/.claude-agent-browser/sessions/<session-id>/profile`, skipping caches and Chrome's lock files, and starts `@playwright/mcp` (pinned version) on it with `--user-data-dir`.
3. When the session ends, the profile copy is deleted. Screenshots and other output stay in `sessions/<session-id>/output` for 7 days.

Nothing a session does (new cookies, open tabs, history) reaches the seed or any other session. Your personal profile is never read.

## Setup (once, on your Mac)

1. Make sure Google Chrome and Node 22 are installed (`/opt/homebrew/opt/node@22` is picked up automatically).
2. Sign the agent in to the sites it may use for you:

   ```sh
   scripts/agent-browser/login.sh https://www.facebook.com https://www.reddit.com
   ```

   A separate Chrome window opens on the seed profile. Sign in, then quit that window (Cmd+Q). Do not turn on Chrome sync there. Only sign in to what the agent needs: anything in the seed is usable by every future agent session.
3. Start Claude Code in this repo. It asks once to approve the `agent-browser` server from `.mcp.json`. Approve it.

To use it in **every** project, not just this repo, add it at user scope instead:

```sh
claude mcp add --scope user agent-browser -- /absolute/path/to/flat-hunt/scripts/agent-browser/mcp.sh
```

Re-run `login.sh` any time a login expires. Sessions started afterwards pick up the change; running sessions keep their copy.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_BROWSER_HOME` | `~/.claude-agent-browser` | Where the seed and session folders live |
| `AGENT_BROWSER_MCP_VERSION` | `0.0.85` | `@playwright/mcp` version (pinned on purpose) |
| `AGENT_BROWSER_CHANNEL` | `chrome` | Browser: `chrome`, `msedge`, `chromium` |
| `AGENT_BROWSER_KEEP_DAYS` | `7` | Days to keep old session output |

Extra arguments to `mcp.sh` pass straight to Playwright MCP, e.g. `--headless` or `--caps=pdf`.

## Rules for agents

- Use the `agent-browser` tools (`mcp__agent-browser__*`) for browser tasks. Do not use Claude in Chrome tools unless the founder asks for their own browser.
- Stay inside your session's browser; never reuse tab references from another session.
- Facebook rules still apply: no scraping or automation of private groups, no ban evasion (decisions D2/D3 in `docs/HANDOFF.md`).

## Troubleshooting

- *"seed profile is open in Chrome … starting signed out"*: the login window is still open. Quit it and start a new Claude session.
- *Chrome does not start*: check `npx` works (`node -v` should be 22) and Chrome is installed, or set `AGENT_BROWSER_CHANNEL=chromium`.
- Logs from the wrapper go to stderr and show in `claude --debug` / `/mcp`.
