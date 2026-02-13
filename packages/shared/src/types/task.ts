export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  targetRoomId: string;
  status: TaskStatus;
  lastRun?: string;
  nextRun?: string;
  lastResult?: string;
  enabled: boolean;
  createdAt: string;
}
