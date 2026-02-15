#!/bin/bash
set -euo pipefail

AGENT_URL="${AGENT_URL:-http://localhost:3001}"
CHANNEL_NAME="${CHANNEL_NAME:-}"
REQUEST_MODE="host"

echo "=== Jonas Pairing Smoke Test ==="
echo "Agent URL: ${AGENT_URL}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

require_cmd curl
require_cmd grep

if ! curl -sS -m 2 "${AGENT_URL}/api/status" >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1; then
    REQUEST_MODE="docker"
    echo "[INFO] ${AGENT_URL} is not reachable from host. Using docker exec mode."
  fi
fi

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  if [[ "$REQUEST_MODE" == "host" ]]; then
    local status
    status="$(curl -s -o /tmp/jonas-pairing-http.out -w "%{http_code}" -X "$method" "${AGENT_URL}${path}" -H 'Content-Type: application/json' -d "$body" || true)"
    local payload
    payload="$(cat /tmp/jonas-pairing-http.out 2>/dev/null || true)"
    echo "${status}"
    echo "${payload}"
    return 0
  fi

  docker compose exec -T agent node -e '
const method = process.argv[1];
const path = process.argv[2];
const body = process.argv[3];
(async () => {
  const res = await fetch(`http://localhost:3001${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body || undefined,
  });
  const text = await res.text();
  process.stdout.write(String(res.status) + "\n" + text);
})().catch((err) => {
  process.stdout.write("000\n" + JSON.stringify({ error: err.message }));
  process.exit(0);
});
' "$method" "$path" "$body"
}

chat_status() {
  local channel_type="$1"
  local channel_id="$2"

  local response
  response="$(request "POST" "/api/chat" "{\"message\":\"pairing smoke test\",\"channelType\":\"${channel_type}\",\"channelId\":\"${channel_id}\",\"sessionKey\":\"pairing:${channel_type}:${channel_id}\"}")"
  local status
  status="$(echo "$response" | head -n1)"
  local payload
  payload="$(echo "$response" | tail -n +2)"
  echo "$payload" > /tmp/jonas-pairing-chat.out
  echo "$status"
}

extract_code() {
  local payload="$1"
  echo "$payload" | grep -o '"code":"[0-9]\{6\}"' | head -n1 | cut -d '"' -f4
}

assert_status() {
  local expected="$1"
  local got="$2"
  local label="$3"
  if [[ "$expected" != "$got" ]]; then
    echo "[FAIL] ${label}: expected ${expected}, got ${got}"
    if [[ -f /tmp/jonas-pairing-chat.out ]]; then
      echo "  Response body:"
      cat /tmp/jonas-pairing-chat.out
      echo ""
    fi
    exit 1
  fi
  echo "[OK] ${label}: ${got}"
}

pair_and_test() {
  local channel_type="$1"
  local channel_id="$2"

  echo ""
  echo "--- Testing ${channel_type} ---"

  # Ensure deterministic precondition regardless of previous state.
  request "POST" "/api/pairing/revoke" "{\"channelType\":\"${channel_type}\"}" >/dev/null || true

  local status
  status="$(chat_status "$channel_type" "$channel_id")"
  assert_status "403" "$status" "blocked before pairing"

  local init_payload
  local init_response
  init_response="$(request "POST" "/api/pairing/init" "{\"channelType\":\"${channel_type}\"}")"
  local init_status
  init_status="$(echo "$init_response" | head -n1)"
  init_payload="$(echo "$init_response" | tail -n +2)"

  assert_status "200" "$init_status" "pairing init"
  local code
  code="$(extract_code "$init_payload")"

  if [[ -z "$code" ]]; then
    echo "[FAIL] Could not extract pairing code for ${channel_type}"
    echo "  Init response: ${init_payload}"
    exit 1
  fi
  echo "[OK] pairing code generated (${code})"

  local confirm_status
  local confirm_response
  confirm_response="$(request "POST" "/api/pairing/confirm" "{\"channelType\":\"${channel_type}\",\"code\":\"${code}\"}")"
  confirm_status="$(echo "$confirm_response" | head -n1)"
  echo "$(echo "$confirm_response" | tail -n +2)" > /tmp/jonas-pairing-confirm.out
  assert_status "200" "$confirm_status" "pairing confirm"

  status="$(chat_status "$channel_type" "$channel_id")"
  assert_status "200" "$status" "chat allowed after pairing"

  local revoke_status
  local revoke_response
  revoke_response="$(request "POST" "/api/pairing/revoke" "{\"channelType\":\"${channel_type}\"}")"
  revoke_status="$(echo "$revoke_response" | head -n1)"
  echo "$(echo "$revoke_response" | tail -n +2)" > /tmp/jonas-pairing-revoke.out
  assert_status "200" "$revoke_status" "pairing revoke"

  status="$(chat_status "$channel_type" "$channel_id")"
  assert_status "403" "$status" "blocked after revoke"
}

pair_and_test "gateway" "smoke-gateway"

if [[ -n "$CHANNEL_NAME" ]]; then
  pair_and_test "channel:${CHANNEL_NAME}" "smoke-channel"
else
  echo ""
  echo "[INFO] Skipping managed channel test (set CHANNEL_NAME=<installed-channel-dirName> to include it)."
fi

echo ""
echo "=== Pairing smoke test passed ==="
