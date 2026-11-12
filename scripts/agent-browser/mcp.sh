#!/bin/sh
# Agent browser: an MCP server that gives each Claude session its own private
# Chrome. It never touches your everyday Chrome profile or tabs.
#
# How isolation works:
#   - Your personal Chrome is never used. The agent runs a separate Chrome
#     process with its own user-data-dir, so it opens in its own window.
#   - Every Claude session starts its own copy of this script (stdio MCP), so
#     every session gets its own Chrome and its own throwaway profile under
#     $AGENT_BROWSER_HOME/sessions/<id>/profile. Two sessions can never share
#     tabs, cookies or state, and cannot lock each other's profile.
#   - Logins come from a "seed" profile you fill once with login.sh. Each
#     session starts from a fresh copy of it; the copy is deleted on exit, so
#     nothing a session does leaks into the seed or into other sessions.
#
# stdout is the MCP protocol channel: only the MCP server may write to it.
# All messages from this script go to stderr.
set -eu

PW_MCP_VERSION="${AGENT_BROWSER_MCP_VERSION:-0.0.85}"
HOME_DIR="${AGENT_BROWSER_HOME:-$HOME/.claude-agent-browser}"
SEED="$HOME_DIR/seed-profile"
KEEP_DAYS="${AGENT_BROWSER_KEEP_DAYS:-7}"

# Node 22 on macOS/Homebrew is not on the default PATH (see CLAUDE.md).
if [ -d /opt/homebrew/opt/node@22/bin ]; then
  PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

log() { printf 'agent-browser: %s\n' "$*" >&2; }

mkdir -p "$HOME_DIR/sessions"
# Drop leftovers from old sessions (screenshots, crashed profiles).
find "$HOME_DIR/sessions" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" \
  -exec rm -rf {} + 2>/dev/null || true

SESSION_ID="${AGENT_BROWSER_SESSION_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
SESSION_DIR="$HOME_DIR/sessions/$SESSION_ID"
PROFILE="$SESSION_DIR/profile"
OUTPUT="$SESSION_DIR/output"
if [ -e "$SESSION_DIR" ]; then
  log "session dir $SESSION_DIR already exists; refusing to share it"
  exit 1
fi
mkdir -p "$PROFILE" "$OUTPUT"

cleanup() { rm -rf "$PROFILE"; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

if [ -d "$SEED" ]; then
  if [ -e "$SEED/SingletonLock" ] || [ -L "$SEED/SingletonLock" ]; then
    log "seed profile is open in Chrome (run login.sh, then quit that window)."
    log "starting this session signed out."
  else
    # Copy the seed without caches and Chrome's single-instance lock files.
    (cd "$SEED" && tar cf - \
      --exclude='Singleton*' --exclude='Cache' --exclude='Code Cache' \
      --exclude='GPUCache' --exclude='ShaderCache' --exclude='GrShaderCache' \
      --exclude='CacheStorage' --exclude='Crashpad' --exclude='*.log' .) \
      | (cd "$PROFILE" && tar xf -)
  fi
else
  log "no seed profile at $SEED; starting signed out (run login.sh to add logins)."
fi

log "session $SESSION_ID, profile $PROFILE"

npx -y "@playwright/mcp@$PW_MCP_VERSION" \
  --browser "${AGENT_BROWSER_CHANNEL:-chrome}" \
  --user-data-dir "$PROFILE" \
  --output-dir "$OUTPUT" \
  "$@"
