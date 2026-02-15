# Implementation Plan: Phase 7 - Audit Persistence & Task Management

## Overview

Phase 7 focuses on data persistence and task management improvements:
1. Persist audit logs to SQLite database
2. Document system requirements
3. Add task editing UI in dashboard

## 1. Audit Persistence

### Current State
- Audit stored in-memory array (`agent.audit`)
- Lost on agent restart
- No query capabilities

### Proposed Solution: SQLite

**Why SQLite over alternatives:**
- ✅ Already using SQLite for conversations
- ✅ Queryable (filter by timestamp, action, user)
- ✅ Low overhead, no separate container
- ✅ Atomic writes, ACID compliance
- ✅ Good for 100K-1M+ audit entries
- ❌ `/data/logs` - Not queryable, harder to manage
- ❌ Postgres - Overkill, adds complexity for single-user system

### Schema Design

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  channel_type TEXT,
  channel_id TEXT,
  session_key TEXT,
  model TEXT,
  tokens_used INTEGER,
  duration_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_session ON audit_log(session_key);
```

### Implementation Steps

1. **Extend database schema** (`services/agent/src/storage/database.ts`)
   - Add audit_log table
   - Methods: `logAudit()`, `getAuditLogs()`, `cleanOldAudit()`

2. **Update AgentCore** (`services/agent/src/agent.ts`)
   - Replace in-memory array with database calls
   - Keep recent entries in memory for performance (last 100)
   - Flush to DB asynchronously

3. **Add API endpoints** (`services/agent/src/api/server.ts`)
   - `GET /api/audit?limit=100&offset=0&action=&from=&to=`
   - Support filtering and pagination

4. **Update dashboard** (`apps/dashboard/src/routes/audit.ts`)
   - Add filters (date range, action type)
   - Add pagination
   - Export to CSV option

### Migration Strategy

- No migration needed (audit not currently persisted)
- Existing `/api/audit` endpoint continues working
- Add optional query parameters for filtering

## 2. System Requirements Documentation

### Document Structure

Create `.claude/docs/system-requirements.md` with:

1. **Minimum Requirements**
   - OS: Ubuntu 22.04+ or Debian 12+
   - CPU: 2 cores
   - RAM: 4 GB
   - Storage: 20 GB
   - Network: Stable internet for Claude API

2. **Recommended Requirements**
   - OS: Ubuntu 24.04 LTS
   - CPU: 4 cores
   - RAM: 8 GB
   - Storage: 50 GB (for logs, conversations, vault)
   - Network: Low latency to Anthropic API

3. **Required Software**
   - Docker Engine 24.0+
   - Docker Compose 2.20+
   - OpenSSH Server (for remote access)
   - Git (for deployment)

4. **Network Ports**
   - 18789 - Gateway (WebSocket)
   - 3001 - Agent API (internal)
   - 3000 - Dashboard (localhost only)
   - 6333 - Qdrant (internal)
   - 22 - SSH (for admin)

5. **Security Requirements**
   - Firewall configured (ufw)
   - SSH key-only authentication
   - TLS/SSL for production
   - Secrets in .env (never committed)

6. **Storage Layout**
   ```
   /data/               # Persistent data volume
   ├── conversations.db # SQLite database
   ├── vault/           # Markdown notes
   ├── skills/          # Skill storage
   ├── channels/        # Channel storage
   └── .ssh/            # Git SSH keys
   ```

### Implementation

- Create markdown document
- Include setup instructions
- Add troubleshooting section
- Reference from main README

## 3. Task Editing UI

### Current State
- Tasks created via API or MCP tools
- No UI to view/edit/delete
- API endpoints exist but unused in dashboard

### Proposed UI

**Route**: `/tasks`

**Features**:
1. **List view** - All scheduled tasks
   - Name, schedule (cron), next run, status
   - Actions: Enable/Disable, Edit, Delete

2. **Edit modal** - Update task
   - Name (readonly)
   - Cron schedule with helper (daily, weekly, etc.)
   - Prompt (textarea)
   - Target channel (dropdown)
   - Enable/disable toggle

3. **Create form** - New task
   - All fields editable
   - Cron expression validator
   - Schedule preview (next 5 run times)

### Implementation Steps

1. **Create tasks route** (`apps/dashboard/src/routes/tasks.ts`)
   - GET `/tasks` - List page
   - GET `/tasks/:name` - Detail/edit page
   - POST `/tasks/:name/update` - Save changes
   - POST `/tasks/:name/pause` - Pause task
   - POST `/tasks/:name/resume` - Resume task
   - DELETE `/tasks/:name` - Delete task

2. **HTMX patterns**
   - Inline editing with form swap
   - Confirm delete with modal
   - Real-time cron preview

3. **Add to navigation** (`apps/dashboard/src/views/layout.ts`)
   - Add "Tasks" link to nav

### API Endpoints (Already Exist)

```typescript
GET    /api/tasks              // List all tasks
GET    /api/tasks/:name        // Get task details
POST   /api/tasks              // Create task
PUT    /api/tasks/:name        // Update task
DELETE /api/tasks/:name        // Delete task
POST   /api/tasks/:name/pause  // Pause task
POST   /api/tasks/:name/resume // Resume task
```

### UI Mockup

```
┌────────────────────────────────────────────────┐
│ Scheduled Tasks                    [+ New Task]│
├────────────────────────────────────────────────┤
│                                                │
│ Daily News Summary                             │
│ Schedule: 0 8 * * * (Every day at 8:00 AM)    │
│ Next run: Feb 16, 2025 8:00 AM                │
│ Status: ● Active                               │
│ Target: channel:telegram                       │
│ [Edit] [Pause] [Delete]                        │
│                                                │
├────────────────────────────────────────────────┤
│ Weekly Report                                  │
│ Schedule: 0 9 * * 1 (Every Monday at 9:00 AM) │
│ Next run: Feb 17, 2025 9:00 AM                │
│ Status: ○ Paused                               │
│ Target: dashboard                              │
│ [Edit] [Resume] [Delete]                       │
└────────────────────────────────────────────────┘
```

## Implementation Order

### Phase 7.1: Audit Persistence (2-3 hours)
1. ✅ Extend database schema with audit_log table
2. ✅ Update AgentCore to use database
3. ✅ Add filtering to API endpoint
4. ✅ Update dashboard with filters/pagination

### Phase 7.2: Documentation (1 hour)
1. ✅ Create system-requirements.md
2. ✅ Add setup instructions
3. ✅ Document troubleshooting
4. ✅ Update main README reference

### Phase 7.3: Task Management UI (2-3 hours)
1. ✅ Create tasks dashboard route
2. ✅ Implement list view with actions
3. ✅ Add edit/create forms
4. ✅ Add cron helper/validator
5. ✅ Add to navigation

## Testing Plan

### Audit Persistence
- Create entries, restart agent, verify persisted
- Query with filters, verify results
- Test pagination with 100+ entries

### Task Management
- Create new task via UI
- Edit existing task (cron, prompt)
- Pause/resume task
- Delete task
- Verify tasks execute on schedule

### System Requirements
- Deploy to fresh Ubuntu 22.04 VM
- Follow setup instructions
- Document any issues

## Rollout

1. **Development** - Build and test locally
2. **Build** - `pnpm build`
3. **Deploy** - Push to VM, restart containers
4. **Verify** - Check audit logs persist, tasks editable
5. **Document** - Update changelog

## Risks & Mitigations

### Risk: Database Migration Issues
- Mitigation: Schema changes are additive only
- Rollback: Previous audit data not persisted anyway

### Risk: Task Editing Breaks Scheduler
- Mitigation: Validate cron expressions before saving
- Rollback: Keep API-based task creation working

### Risk: SQLite Performance
- Mitigation: Index on timestamp, limit query results
- Future: Archive old audit entries (>90 days)

## Success Criteria

- ✅ Audit logs survive agent restart
- ✅ Can query audit by date range and action type
- ✅ Can edit task schedules from dashboard
- ✅ Can pause/resume/delete tasks from UI
- ✅ System requirements doc is complete and tested
- ✅ All features work on fresh Ubuntu 24.04 VM
