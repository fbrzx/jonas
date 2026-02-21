export type ChannelType = 'gateway' | 'api' | 'scheduler' | 'dashboard' | 'telegram' | 'job';

export interface Channel {
  type: ChannelType;
  id: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  channel: Channel;
  conversationId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  channel: Channel;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  summary?: string;
}
