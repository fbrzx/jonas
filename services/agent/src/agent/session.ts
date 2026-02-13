import { createId, isoNow } from '@jonas/shared/utils';
import type { Message, Conversation, Channel } from '@jonas/shared/types';

export interface Session {
  id: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  getOrCreate(key: string): Session {
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        id: createId('conv'),
        messages: [],
        createdAt: isoNow(),
        updatedAt: isoNow(),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  reset(key: string): void {
    this.sessions.delete(key);
  }

  get count(): number {
    return this.sessions.size;
  }

  list(): Conversation[] {
    return Array.from(this.sessions.entries()).map(([key, session]) => {
      const channelParts = key.split(':');
      const channel: Channel = {
        type: channelParts[0] as Channel['type'],
        id: channelParts.slice(1).join(':'),
      };
      return {
        id: session.id,
        channel,
        messages: session.messages,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    });
  }
}
