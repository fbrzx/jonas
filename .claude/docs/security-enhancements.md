# Security Enhancements Plan

Date: 2026-02-15
Scope: Jonas platform hardening with explicit channel pairing model

## Risk context adjustment

The dashboard currently binds to `127.0.0.1` and is typically accessed through SSH tunneling. This meaningfully reduces remote exposure of dashboard routes versus a public web UI.

However, SSH tunnel-only access is an environmental control, not an application-layer trust guarantee. If local access, tunnel forwarding, or internal network controls are misconfigured, platform risk remains. The hardening plan below treats network assumptions as defense-in-depth, not primary auth.

## Target state

Every non-dashboard channel integration (gateway and installable channels) must be explicitly paired before it can send chat traffic to the agent.

Dashboard access is protected separately by `DASHBOARD_TOKEN` authentication at the dashboard app boundary.

Pairing properties:
- One-time bootstrap per channel type/instance
- Time-limited challenge codes
- Persisted paired state in agent data volume
- Clear operational UX for initial pairing and rotation

## Plan

### Phase 1 (implemented in this changeset)

1. Add agent pairing registry persisted at `/data/channel-pairings.json`
2. Add pairing API endpoints:
   - `GET /api/pairing/status?channelType=...`
   - `POST /api/pairing/init`
   - `POST /api/pairing/confirm`
3. Enforce pairing on gateway/chat channel paths
4. Add channel-level pairing UI and controls in dashboard Channels detail pages
5. Add dashboard app authentication using `DASHBOARD_TOKEN` and remove dashboard `/pairing` page

### Phase 2 (next changeset)

1. ✅ Extend enforcement to gateway channel (`channelType=gateway`)
2. ✅ Add pairing management UI for installable channels in Channels detail views
3. ✅ Add pairing rotation and revoke controls
4. ⏳ Add rate limiting and body limits on pairing endpoints

### Phase 3 (next changesets)

1. Require service authentication for agent admin API
2. Lock CORS to explicit allowlist
3. Harden plugin imports (zip path validation + signing/allowlist)
4. Sanitize markdown HTML rendering in dashboard chat
5. Add security regression tests (pairing, traversal, XSS, auth)

## Operational notes

- Dashboard remains tunnel-first and now requires dashboard token authentication.
- Pairing enforcement list is configurable via `PAIRING_ENFORCE_CHANNELS` (comma-separated).
- Pairing now defaults to `gateway` plus managed installable channels (`channel:*`).
- Managed-channel enforcement can be toggled with `PAIRING_REQUIRE_MANAGED_CHANNELS=true|false`.
