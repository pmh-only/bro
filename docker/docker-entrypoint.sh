#!/bin/bash
set -Eeuo pipefail

opencode_pid=""
bot_pid=""

shutdown() {
  trap - INT TERM
  [[ -n "$bot_pid" ]] && kill -TERM "$bot_pid" 2>/dev/null || true
  [[ -n "$opencode_pid" ]] && kill -TERM "$opencode_pid" 2>/dev/null || true
  [[ -n "$bot_pid" ]] && wait "$bot_pid" 2>/dev/null || true
  [[ -n "$opencode_pid" ]] && wait "$opencode_pid" 2>/dev/null || true
}

trap 'shutdown; exit 143' TERM
trap 'shutdown; exit 130' INT

export OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_PORT:-4096}}"
export OPENCODE_USERNAME="${OPENCODE_USERNAME:-${OPENCODE_SERVER_USERNAME:-opencode}}"
export OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"

opencode web --hostname=0.0.0.0 --port="${OPENCODE_PORT:-4096}" &
opencode_pid=$!

for _ in $(seq 1 90); do
  if /app/docker/docker-healthcheck.sh >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$opencode_pid" 2>/dev/null; then
    wait "$opencode_pid"
    exit $?
  fi
  sleep 1
done

if ! /app/docker/docker-healthcheck.sh >/dev/null 2>&1; then
  echo "OpenCode did not become healthy within 90 seconds" >&2
  shutdown
  exit 1
fi

node /app/dist/src/index.js &
bot_pid=$!

set +e
wait -n "$opencode_pid" "$bot_pid"
status=$?
set -e

shutdown
exit "$status"
