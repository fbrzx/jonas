export interface AgentStatus {
  uptime: number;
  model: string;
  memoryStats: {
    episodic: number;
    semantic: number;
    procedural: number;
  };
  activeConversations: number;
  skillCount: number;
  channels: {
    dashboard: boolean;
    gateway: boolean;
  };
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  logType?: 'info' | 'debug' | 'warn' | 'error';
  tool?: string;
  input?: Record<string, unknown>;
  result?: 'success' | 'error';
  channel: string;
  conversationId?: string;
}
