#!/bin/bash
set -Eeuo pipefail

opencode_pid=""
code_server_pid=""
bot_pid=""

shutdown() {
  trap - INT TERM
  [[ -n "$bot_pid" ]] && kill -TERM "$bot_pid" 2>/dev/null || true
  [[ -n "$code_server_pid" ]] && kill -TERM "$code_server_pid" 2>/dev/null || true
  [[ -n "$opencode_pid" ]] && kill -TERM "$opencode_pid" 2>/dev/null || true
  [[ -n "$bot_pid" ]] && wait "$bot_pid" 2>/dev/null || true
  [[ -n "$code_server_pid" ]] && wait "$code_server_pid" 2>/dev/null || true
  [[ -n "$opencode_pid" ]] && wait "$opencode_pid" 2>/dev/null || true
}

trap 'shutdown; exit 143' TERM
trap 'shutdown; exit 130' INT

export OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_PORT:-4096}}"
export OPENCODE_USERNAME="${OPENCODE_USERNAME:-${OPENCODE_SERVER_USERNAME:-opencode}}"
export OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"

docker_socket="/var/run/docker.sock"
if [[ -z "${DOCKER_HOST:-}" && -S "$docker_socket" ]]; then
  if [[ ! -r "$docker_socket" || ! -w "$docker_socket" ]]; then
    if ! sudo chmod 0666 "$docker_socket"; then
      printf 'Warning: unable to grant access to %s\n' "$docker_socket" >&2
    fi
  fi
  if [[ -r "$docker_socket" && -w "$docker_socket" ]]; then
    export DOCKER_HOST="unix://$docker_socket"
  fi
fi

config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
mkdir -p "$config_dir"
if [[ ! -e "$config_dir/opencode.json" ]]; then
  install -m 600 /app/docker/opencode.default.json "$config_dir/opencode.json"
fi

# Provider requests otherwise stop after five minutes, before the bot's task
# deadline. Derive the overlay from the selected and persisted providers while
# preserving an explicitly supplied OPENCODE_CONFIG_CONTENT value.
if [[ -z "${OPENCODE_CONFIG_CONTENT:-}" ]]; then
  export OPENCODE_CONFIG_CONTENT="$(node /app/docker/opencode-provider-timeouts.mjs "$config_dir/opencode.json")"
fi

opencode web --hostname=0.0.0.0 --port="${OPENCODE_PORT:-4096}" &
opencode_pid=$!

NODE_ENV=production code-server \
  --auth none \
  --bind-addr "0.0.0.0:${CODE_SERVER_PORT:-8080}" \
  --disable-telemetry \
  "$PROJECTS_ROOT" &
code_server_pid=$!

for _ in $(seq 1 90); do
  if /app/docker/docker-healthcheck.sh >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$opencode_pid" 2>/dev/null; then
    wait "$opencode_pid"
    exit $?
  fi
  if ! kill -0 "$code_server_pid" 2>/dev/null; then
    wait "$code_server_pid"
    exit $?
  fi
  sleep 1
done

if ! /app/docker/docker-healthcheck.sh >/dev/null 2>&1; then
  echo "OpenCode and code-server did not become healthy within 90 seconds" >&2
  shutdown
  exit 1
fi

node /app/dist/src/index.js &
bot_pid=$!

set +e
wait -n "$opencode_pid" "$code_server_pid" "$bot_pid"
status=$?
set -e

shutdown
exit "$status"
