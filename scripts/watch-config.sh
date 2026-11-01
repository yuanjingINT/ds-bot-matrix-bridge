#!/usr/bin/env bash
# Records who opens/writes config.json: inotify event + the holders from lsof at that instant.
set -u
FILE=/home/yuanjing/.dsh/bot/workspace/matrix-bridge/config.json
OUT=/home/yuanjing/.dsh/bot/workspace/matrix-bridge/logs/config-watch.log
: > "$OUT"
inotifywait -m -e open -e close_write -e moved_to --format '%T %e %w%f' --timefmt '%H:%M:%S' "$(dirname "$FILE")" 2>/dev/null |
while read -r ts event path; do
  case "$path" in *config.json) ;; *) continue ;; esac
  holders=$(lsof -Fpct -- "$FILE" 2>/dev/null | tr '\n' ' ')
  printf '%s %s %s holders=[%s]\n' "$ts" "$event" "$path" "$holders" >> "$OUT"
done
