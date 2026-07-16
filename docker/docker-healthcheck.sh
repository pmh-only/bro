#!/bin/sh
set -eu

url="${OPENCODE_URL:-http://127.0.0.1:${OPENCODE_PORT:-4096}}/global/health"
username="${OPENCODE_USERNAME:-${OPENCODE_SERVER_USERNAME:-opencode}}"
password="${OPENCODE_PASSWORD:-${OPENCODE_SERVER_PASSWORD:-}}"

if [ -n "$password" ]; then
  exec curl --connect-timeout 1 --max-time 4 --fail --silent --show-error --user "$username:$password" "$url"
fi

exec curl --connect-timeout 1 --max-time 4 --fail --silent --show-error "$url"
