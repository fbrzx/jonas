/**
 * Maps WebSocket connection IDs to agent session keys.
 */

import { createId } from '@jonas/shared/utils';

interface SessionEntry {
  wsId: string;
  sessionKey: string;
}

export class SessionManager {
  private sessions = new Map<string, string>();

  /**
   * Creates a new session for the given WebSocket connection ID.
   * Returns the generated session key.
   */
  create(wsId: string): string {
    const sessionKey = createId('sess');
    this.sessions.set(wsId, sessionKey);
    return sessionKey;
  }

  /**
   * Returns the session key for a WebSocket connection, or null.
   */
  get(wsId: string): string | null {
    return this.sessions.get(wsId) ?? null;
  }

  /**
   * Removes the session for a WebSocket connection.
   */
  remove(wsId: string): void {
    this.sessions.delete(wsId);
  }

  /**
   * Lists all active sessions.
   */
  list(): SessionEntry[] {
    return Array.from(this.sessions.entries()).map(([wsId, sessionKey]) => ({
      wsId,
      sessionKey,
    }));
  }
}
