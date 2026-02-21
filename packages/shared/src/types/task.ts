export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  targetChannel?: { type: string; id: string };
  status: TaskStatus;
  lastRun?: string;
  nextRun?: string;
  lastResult?: string;
  enabled: boolean;
  createdAt: string;
  /** Timeout for each execution in milliseconds (default: 600000 = 10min) */
  timeoutMs?: number;
}
