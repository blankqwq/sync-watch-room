#!/bin/sh
set -eu

if [ -z "${TURN_SHARED_SECRET:-}" ]; then
  echo "TURN_SHARED_SECRET is required" >&2
  exit 1
fi

relay_ip="${TURN_RELAY_IP:-$(hostname -i | awk '{print $1}')}"

set -- turnserver \
  -n \
  --log-file=stdout \
  --log-min-level=info \
  --pidfile=/tmp/turnserver.pid \
  --fingerprint \
  --use-auth-secret \
  "--static-auth-secret=${TURN_SHARED_SECRET}" \
  "--realm=${TURN_REALM:-sync-watch-room.local}" \
  --no-tls \
  --no-multicast-peers \
  --no-dynamic-ip-list \
  --no-dynamic-realms \
  --unauthorized-ratelimit \
  "--listening-ip=${relay_ip}" \
  "--relay-ip=${relay_ip}" \
  "--min-port=${TURN_MIN_PORT:-49160}" \
  "--max-port=${TURN_MAX_PORT:-49200}" \
  "--max-bps=${TURN_MAX_BPS:-1048576}"

if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  set -- "$@" "--external-ip=${TURN_EXTERNAL_IP}/${relay_ip}"
elif [ "${TURN_DETECT_EXTERNAL_IP:-false}" = "true" ]; then
  detected_ip="$(detect-external-ip 2>/dev/null || true)"
  if [ -n "$detected_ip" ]; then
    set -- "$@" "--external-ip=${detected_ip}/${relay_ip}"
  else
    echo "Unable to detect TURN external IP; using container relay address" >&2
  fi
fi

exec "$@"
