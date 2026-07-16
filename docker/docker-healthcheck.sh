#!/bin/sh
set -eu

opencode_url="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_PORT:-4096}}/global/health"
code_server_url="http://127.0.0.1:${CODE_SERVER_PORT:-8080}/healthz"
username="${OPENCODE_USERNAME:-${OPENCODE_SERVER_USERNAME:-opencode}}"
password="${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"

if [ -n "$password" ]; then
  curl --connect-timeout 1 --max-time 4 --fail --silent --show-error --user "$username:$password" "$opencode_url" >/dev/null
else
  curl --connect-timeout 1 --max-time 4 --fail --silent --show-error "$opencode_url" >/dev/null
fi

exec curl --connect-timeout 1 --max-time 4 --fail --silent --show-error "$code_server_url"
