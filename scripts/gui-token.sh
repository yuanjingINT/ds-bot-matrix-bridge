#!/bin/sh
# Refresh the GUI launch token the bridge uses to mint its session cookie.
#
# DSH mints a launch token per process (a random 32-byte value held in memory, printed in
# the start-up URL as `?token=...`). So every DSH restart invalidates the token file, and
# inbound stops with "the GUI did not accept the launch token" until it is refreshed.
#
# Where the new token comes from, in this order:
#   1. the argument, if one is given (the whole URL or just the token);
#   2. the newest `?token=` line in `journalctl --user` (DSH started under systemd-run);
#   3. nothing — say so and ask the user for the URL, rather than guessing.
#
# The token is never printed and never logged. It is validated before it is written:
# exchange it for a session cookie (that is exactly what the bridge does) and then ask the
# API for the model list with that cookie. Only a token that passes both is saved.
#
# Usage:
#   scripts/gui-token.sh                      # find it, validate it, save it
#   scripts/gui-token.sh -                    # read the URL/token from stdin (not in `ps`)
#   scripts/gui-token.sh 'http://127.0.0.1:3080/?token=...'
#   scripts/gui-token.sh '<token>'
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TOKEN_FILE=${MATRIX_BRIDGE_GUI_TOKEN_FILE:-$HOME/.dsh/bot/workspace/.secrets/gui_token}
BASE=${DSH_WEB_URL:-http://127.0.0.1:3080}
BASE=$(printf '%s' "$BASE" | sed 's:/*$::')

die() { printf '%s\n' "$*" >&2; exit 1; }

# A URL or a bare token both end up as the token itself.
as_token() {
  printf '%s' "$1" | sed -n 's/.*[?&]token=\([A-Za-z0-9_-]\{20,\}\).*/\1/p; t; s/^\([A-Za-z0-9_-]\{20,\}\)$/\1/p'
}

from_journal() {
  # The scope name changes on every restart, so match the line, never a unit name.
  journalctl --user --no-pager -o cat -n 20000 2>/dev/null \
    | grep -o '[?&]token=[A-Za-z0-9_-]\{20,\}' \
    | tail -1 \
    | sed 's/^[?&]token=//' || true
}

TOKEN=''
if [ "${1:-}" = '-' ]; then
  # An argument would sit in `ps` for as long as the script runs; stdin does not.
  TOKEN=$(as_token "$(cat)" || true)
  [ -n "$TOKEN" ] || die "stdin carries no token (expected ...?token=... or the token itself)"
elif [ $# -ge 1 ]; then
  TOKEN=$(as_token "$1" || true)
  [ -n "$TOKEN" ] || die "the argument carries no token (expected ...?token=... or the token itself)"
else
  TOKEN=$(from_journal)
  [ -n "$TOKEN" ] || die "no launch token found: DSH was not started under systemd-run, or the journal rolled past it.
Give the new URL: scripts/gui-token.sh 'http://127.0.0.1:3080/?token=...'
(the token is minted per DSH start, so every restart needs this)"
fi

# 1. The token must buy a session cookie.
jar=$(mktemp)
header=$(mktemp)
trap 'rm -f "$jar" "$header"' EXIT
code=$(curl -sS -o /dev/null -D "$header" -c "$jar" -w '%{http_code}' \
  --max-time 15 "$BASE/?token=$(printf '%s' "$TOKEN" | sed 's/[^A-Za-z0-9_-]/%&/g')" || echo 000)
grep -qi '^set-cookie: *dsh-auth-' "$header" \
  || die "the GUI did not accept this token (HTTP $code). It was probably minted for another DSH process: give the URL of the running one."

# 2. That cookie must reach the API the bridge uses.
body=$(curl -sS --max-time 15 -b "$jar" -X POST "$BASE/api/bot" \
  -H 'content-type: application/json' \
  -d '{"endpoint":"models","payload":{}}' || true)
case "$body" in
  *'"ok":true'*) ;;
  *) die "the cookie works but /api/bot refused the probe: $(printf '%s' "$body" | cut -c1-200)" ;;
esac

mkdir -p "$(dirname "$TOKEN_FILE")"
umask 077
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
printf 'ok: token valid, saved to %s (%s bytes)\n' "$TOKEN_FILE" "$(wc -c < "$TOKEN_FILE" | tr -d ' ')"
