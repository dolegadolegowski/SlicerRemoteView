#!/usr/bin/env bash
# Smoke test of a relay image (DEP-03, NFR-38): `/healthz` answers 200 `{"status":"ok"}` within 10 s,
# `/api/version` is the protocol §10 JSON, and the process runs as uid 1000 (`USER node`, ADR 0007 §5).
#
#   .github/scripts/smoke-relay-image.sh <image>
#
# Exit 1 with the container's log on any failure. The deeper image checks (dumb-init as PID 1, SIGTERM, heap
# sizing, production dependencies only) are relay-server/test/docker-smoke.test.ts, which ci.yml runs next.
set -euo pipefail

image="${1:?usage: smoke-relay-image.sh <image>}"
port="${SMOKE_PORT:-18787}"
name="relay-smoke-$$"
body="$(mktemp)"

cleanup() {
  docker rm -f "$name" > /dev/null 2>&1 || true
  rm -f "$body"
}
fail() {
  echo "::error::$1" >&2
  echo "--- container log ---" >&2
  docker logs "$name" >&2 || true
  exit 1
}
trap cleanup EXIT

# PORT as Railway injects it; no edge proxy in front, so the socket address is the client (relay README, Docker).
docker run -d --name "$name" -p "127.0.0.1:${port}:8787" -e PORT=8787 -e TRUST_PROXY=false "$image" > /dev/null

status=""
for _ in $(seq 1 20); do
  status="$(curl -s -o "$body" -w '%{http_code}' "http://127.0.0.1:${port}/healthz" || true)"
  [ "$status" = "200" ] && break
  sleep 0.5
done
[ "$status" = "200" ] || fail "/healthz did not answer 200 within 10 s (last status: ${status:-none})"
jq -e '.status == "ok" and (.uptimeS | type == "number") and (.version | type == "string")' "$body" > /dev/null \
  || fail "/healthz body is not {status: ok, uptimeS, version}: $(cat "$body")"
echo "healthz: $(cat "$body")"

version="$(curl -sf "http://127.0.0.1:${port}/api/version")" || fail "/api/version did not answer 2xx"
echo "$version" | jq -e '(.name | type == "string") and (.version | type == "string")
  and (.protocolVersions | type == "array" and length > 0) and (.limits.maxSnapshotBytes | type == "number")' > /dev/null \
  || fail "/api/version is not the protocol §10 JSON: $version"
echo "api/version: $version"

uid="$(docker exec "$name" awk '/^Uid:/ { print $2 }' /proc/1/status)"
[ "$uid" = "1000" ] || fail "PID 1 runs as uid $uid, expected 1000 (USER node)"
echo "uid: $uid"
