#!/bin/bash
set -euo pipefail

echo "=== Jonas Health Check ==="

# Check service via node fetch inside container
check_node() {
  local name="$1" service="$2" url="$3"
  if docker compose exec -T "$service" node -e \
    "fetch('$url').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "  [OK] $name"
  else
    echo "  [FAIL] $name ($service → $url)"
  fi
}

# Check service via bash /dev/tcp inside container
check_tcp() {
  local name="$1" service="$2" port="$3"
  if docker compose exec -T "$service" bash -c "echo > /dev/tcp/localhost/$port" 2>/dev/null; then
    echo "  [OK] $name"
  else
    echo "  [FAIL] $name ($service :$port)"
  fi
}

# Check Docker healthcheck status
check_docker_health() {
  local name="$1" service="$2"
  local status
  status=$(docker compose ps --format json "$service" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Health',''))" 2>/dev/null || echo "")
  if [ "$status" = "healthy" ]; then
    echo "  [OK] $name (docker health)"
  elif [ -z "$status" ]; then
    echo "  [--] $name (no healthcheck)"
  else
    echo "  [FAIL] $name (docker: $status)"
  fi
}

echo ""
echo "Service health (internal):"
check_node "Agent API" agent "http://localhost:3001/api/status"
check_node "Gateway" gateway "http://localhost:18789/"
check_node "Dashboard" dashboard "http://localhost:3000/health"
check_tcp "Qdrant" qdrant 6333

echo ""
echo "Docker healthcheck status:"
for svc in agent gateway dashboard qdrant; do
  check_docker_health "$svc" "$svc"
done

echo ""
echo "Agent details:"
docker compose exec -T agent node -e \
  "fetch('http://localhost:3001/api/status').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.error(e.message))" 2>/dev/null || echo "  (unavailable)"

echo ""
echo "Docker containers:"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
