#!/bin/bash
# Minimal smoke tests for Jonas
# Run after docker compose up to verify core functionality

set -e  # Exit on any error

echo "🧪 Running Jonas smoke tests..."
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

test_count=0
passed=0
failed=0

run_test() {
  test_count=$((test_count + 1))
  echo -n "  [$test_count] $1... "

  if eval "$2" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC}"
    passed=$((passed + 1))
    return 0
  else
    echo -e "${RED}✗${NC}"
    failed=$((failed + 1))
    return 1
  fi
}

# Wait for services
echo "${YELLOW}⏳ Waiting for services to be ready...${NC}"
sleep 3

echo ""
echo "Testing core services..."
run_test "Gateway health" "curl -sf http://localhost:18789/health | grep -q ok"
run_test "Dashboard responds" "curl -sf http://127.0.0.1:3000/"

echo ""
echo "Testing Docker services..."
run_test "All containers running" "test $(docker compose ps -q | wc -l) -ge 4"
run_test "Agent container healthy" "docker compose ps agent | grep -q healthy"
run_test "Gateway container healthy" "docker compose ps gateway | grep -q healthy"
run_test "Dashboard container healthy" "docker compose ps dashboard | grep -q healthy"

echo ""
echo "✅ Core services are up and responsive!"
echo ""
echo "⚠️  Note: Internal API tests (tasks, skills) skipped"
echo "   Run 'docker compose logs' to verify agent is working"

echo ""
echo "========================================="

if [ $failed -eq 0 ]; then
  echo -e "${GREEN}✅ All tests passed! ($passed/$test_count)${NC}"
  echo "========================================="
  exit 0
else
  echo -e "${RED}❌ Some tests failed! ($passed passed, $failed failed)${NC}"
  echo "========================================="
  exit 1
fi
