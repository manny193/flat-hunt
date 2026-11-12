#!/bin/sh
# Open the agent's seed Chrome profile so you can sign in to the sites the
# agent may use on your behalf. This is a separate Chrome profile: your own
# profile, tabs and logins are not touched or shared.
#
# Usage: scripts/agent-browser/login.sh [url ...]
# Sign in, then quit that Chrome window (Cmd+Q). New Claude sessions start
# from a copy of this profile; sessions already running keep their old copy.
set -eu

HOME_DIR="${AGENT_BROWSER_HOME:-$HOME/.claude-agent-browser}"
SEED="$HOME_DIR/seed-profile"
mkdir -p "$SEED"

if [ "$#" -eq 0 ]; then set -- "about:blank"; fi

case "$(uname -s)" in
  Darwin)
    # -n: new Chrome instance, separate from the Chrome you already have open.
    open -na "Google Chrome" --args --user-data-dir="$SEED" \
      --no-first-run --no-default-browser-check "$@"
    ;;
  *)
    CHROME="${AGENT_BROWSER_CHROME:-}"
    if [ -z "$CHROME" ]; then
      for c in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
      done
    fi
    if [ -z "$CHROME" ]; then
      echo "Chrome not found; set AGENT_BROWSER_CHROME=/path/to/chrome" >&2
      exit 1
    fi
    "$CHROME" --user-data-dir="$SEED" --no-first-run --no-default-browser-check "$@" \
      >/dev/null 2>&1 &
    ;;
esac

echo "Opened the agent's seed profile ($SEED)."
echo "Sign in to the sites the agent needs, then quit that Chrome window."
echo "Do not turn on Chrome sync in it."
