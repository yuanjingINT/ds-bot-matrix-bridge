#!/bin/sh
# Start, stop, or check the bridge. A pid file keeps the control from matching another
# process whose command line happens to contain the same words.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PIDFILE="$ROOT/state/bridge.pid"
LOG="$ROOT/logs/stdout.log"
ENTRY=${MATRIX_BRIDGE_ENTRY:-src/sync.js}

running() {
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  [ -n "${pid:-}" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

start() {
  if pid=$(running); then
    echo "already running (pid $pid)"
    return 0
  fi
  mkdir -p "$ROOT/state" "$ROOT/logs"
  cd "$ROOT"
  MATRIX_BRIDGE_VERBOSE=${MATRIX_BRIDGE_VERBOSE:-0} nohup node "$ENTRY" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  if pid=$(running); then
    echo "started (pid $pid, entry $ENTRY)"
  else
    echo "failed to start; see $LOG"
    return 1
  fi
}

stop() {
  if ! pid=$(running); then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "still running (pid $pid); send SIGKILL yourself if it is really stuck"
    return 1
  fi
  rm -f "$PIDFILE"
  echo "stopped"
}

status() {
  if pid=$(running); then
    echo "running (pid $pid)"
    tail -3 "$LOG" 2>/dev/null || true
  else
    echo "not running"
    return 1
  fi
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
