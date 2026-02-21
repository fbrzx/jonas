export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundJob {
  id: string;
  name: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  targetChannel?: { type: string; id: string };
  sessionKey: string;
  /** ID of the scheduled task that spawned this job, if any */
  scheduledTaskId?: string;
  /** Timeout in milliseconds (default: 600000 = 10min) */
  timeoutMs?: number;
}
