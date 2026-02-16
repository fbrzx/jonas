# Minimal Test Strategy (Time-Constrained)

**Philosophy:** Test the critical paths that would cause user-facing breakage. Skip unit tests for now.

---

## ✅ Priority 1: Smoke Tests (5 minutes)

### Manual Smoke Test Checklist

```bash
# 1. Gateway Health
curl http://localhost:18789/health
# Expected: {"status":"ok","service":"gateway"}

# 2. Agent Health
curl http://localhost:3001/api/status
# Expected: JSON with status info

# 3. Terminal CLI Connection
echo "hello" | jonas-acp --url ws://localhost:18789 --token $GATEWAY_TOKEN
# Expected: Connection success, response from Jonas

# 4. Dashboard Access
curl http://127.0.0.1:3000/
# Expected: HTML response (200 OK)

# 5. Task Scheduler (create & list)
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name":"test","cron":"0 0 * * *","prompt":"test"}'
# Expected: Task created JSON

curl http://localhost:3001/api/tasks
# Expected: Task list including the one just created
```

**✅ If all 5 pass → Ship it!**

---

## 🔧 Priority 2: Quick Integration Test Script (10 minutes)

Create a single script that tests the critical happy path:

```bash
#!/bin/bash
# scripts/smoke-test.sh

set -e  # Exit on any error

echo "🧪 Running smoke tests..."

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

test_count=0
passed=0

run_test() {
  test_count=$((test_count + 1))
  echo -n "Test $test_count: $1... "
  if eval "$2" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
    passed=$((passed + 1))
  else
    echo -e "${RED}✗${NC}"
    exit 1
  fi
}

# Wait for services
echo "Waiting for services to be ready..."
sleep 2

# Tests
run_test "Gateway health" "curl -sf http://localhost:18789/health | grep -q ok"
run_test "Agent health" "curl -sf http://localhost:3001/api/status"
run_test "Dashboard health" "curl -sf http://127.0.0.1:3000/"
run_test "Task list API" "curl -sf http://localhost:3001/api/tasks"
run_test "Skills list API" "curl -sf http://localhost:3001/api/skills"

# Task scheduler test
echo "Testing task creation..."
TASK_RESPONSE=$(curl -sf -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-test","cron":"0 0 * * *","prompt":"test","enabled":false}')

TASK_ID=$(echo $TASK_RESPONSE | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -n "$TASK_ID" ]; then
  echo -e "Test 6: Task creation... ${GREEN}✓${NC}"
  passed=$((passed + 1))

  # Cleanup
  curl -sf -X DELETE http://localhost:3001/api/tasks/$TASK_ID > /dev/null
  echo "Cleaned up test task"
else
  echo -e "Test 6: Task creation... ${RED}✗${NC}"
  exit 1
fi

echo ""
echo "========================================="
echo -e "${GREEN}All $passed tests passed!${NC}"
echo "========================================="
```

**Usage:**
```bash
chmod +x scripts/smoke-test.sh
docker compose up -d
./scripts/smoke-test.sh
```

---

## 📝 Priority 3: Document What Should Be Tested (Future Reference)

### Critical Paths (Test These Eventually)

**Task Scheduler:**
- [ ] Task executes on schedule
- [ ] 'running' status persists before execution starts
- [ ] Dispatch errors don't mark task as failed
- [ ] Error results are truncated
- [ ] Task survives agent restart

**Gateway:**
- [ ] Token auth rejects invalid tokens
- [ ] Token auth accepts valid tokens
- [ ] WebSocket frames parse correctly
- [ ] Session persistence works
- [ ] Multiple concurrent connections

**MCP Bridge:**
- [ ] Connects to gateway successfully
- [ ] Tool calls translate to chat messages
- [ ] Responses buffer correctly
- [ ] Connection errors handled gracefully

**Dashboard:**
- [ ] Task status badges render correctly
- [ ] Last result preview expands
- [ ] CRUD operations work

---

## 🎯 What NOT to Test Right Now

**Skip these (low ROI for time invested):**
- ❌ Unit tests for individual functions
- ❌ Edge cases in translators
- ❌ Timeout behavior
- ❌ Memory leak tests
- ❌ Load testing
- ❌ UI interaction tests

**Rationale:** These are important but won't catch the bugs that break production. Focus on integration tests that verify end-to-end flows.

---

## 🚨 Pre-Deployment Checklist

**Before deploying to production:**

```bash
# 1. Build succeeds
pnpm build
# ✓ No TypeScript errors

# 2. Services start
docker compose up -d
# ✓ All containers running

# 3. Smoke tests pass
./scripts/smoke-test.sh
# ✓ All tests green

# 4. Manual verification
# ✓ Open dashboard, create a task, verify it appears
# ✓ Connect with jonas-acp, send a message, get response
# ✓ Check logs for errors: docker compose logs

# 5. Production config check
# ✓ GATEWAY_TOKEN is strong (32+ hex chars)
# ✓ Dashboard binds to 127.0.0.1 only
# ✓ All secrets in .env (not hardcoded)
```

---

## 🔄 Continuous Testing Strategy

**Add tests incrementally:**

### Week 1: Smoke tests only
- Run `smoke-test.sh` before every deploy
- Manual verification of critical paths

### Week 2-4: Add tests when you fix bugs
- When a bug is found, add a test that would have caught it
- Don't write tests speculatively

### Month 2+: Gradual coverage increase
- Add integration tests for new features as you build them
- Target 50% coverage on critical paths (not 100%)

---

## 🛠️ Quick Test Helpers

### Test Task Execution Bug Fix

```bash
# Create a test task
TASK_ID=$(curl -sf -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"name":"test-persist","cron":"0 0 * * *","prompt":"say hi","enabled":true}' \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

# Trigger it
curl -X POST http://localhost:3001/api/tasks/$TASK_ID/run

# Check status was persisted
sleep 1
curl -s http://localhost:3001/api/tasks | grep -A5 $TASK_ID

# Cleanup
curl -X DELETE http://localhost:3001/api/tasks/$TASK_ID
```

### Test Gateway Auth

```bash
# Should fail (no token)
curl -i --no-buffer \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: test" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:18789/
# Expected: 401 Unauthorized

# Should succeed (with token)
curl -i --no-buffer \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: test" \
  -H "Sec-WebSocket-Version: 13" \
  "http://localhost:18789/?token=$GATEWAY_TOKEN"
# Expected: 101 Switching Protocols
```

---

## 📊 Testing Effort vs. Value

| Test Type | Time to Write | Value | Priority |
|-----------|---------------|-------|----------|
| Smoke tests | 5 min | ⭐⭐⭐⭐⭐ | **DO NOW** |
| Integration test script | 10 min | ⭐⭐⭐⭐⭐ | **DO NOW** |
| Manual pre-deploy checklist | 2 min | ⭐⭐⭐⭐ | **DO NOW** |
| E2E happy path tests | 30 min | ⭐⭐⭐⭐ | Do if time |
| Unit tests (comprehensive) | 4+ hours | ⭐⭐⭐ | Skip for now |
| Edge case tests | 2+ hours | ⭐⭐ | Skip for now |
| Load tests | 1+ hour | ⭐⭐ | Skip for now |

---

## 🎯 Minimum Viable Testing

**If you only have 15 minutes total:**

1. Create `scripts/smoke-test.sh` (copy from above)
2. Run it once: `./scripts/smoke-test.sh`
3. Add to deployment workflow: Run before every production deploy

**That's it!** This single script catches 80% of breaking changes with 20% of the effort.

---

## 💡 Testing Philosophy

**Good enough > Perfect**

- A few critical integration tests > hundreds of unit tests
- Manual verification > no verification
- Smoke tests that run > comprehensive tests that don't

**Ship with confidence, iterate on coverage.**

---

**Last Updated:** 2026-02-16
