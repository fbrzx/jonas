import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import type { BackgroundJob, JobStatus } from '@jonas/shared/types';
import type { AgentCore } from '../agent/core.js';
import type { ConversationDatabase } from '../storage/database.js';
import { loadJobs, saveJobs } from './job-storage.js';

const log = createLogger('job-manager');

const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_JOB_TIMEOUT_MS ?? 10 * 60 * 1000); // 10 minutes
const MAX_CONCURRENT_JOBS = Number(process.env.AGENT_MAX_CONCURRENT_JOBS ?? 5);
/** How many completed/failed jobs to keep in history */
const MAX_JOB_HISTORY = Number(process.env.AGENT_JOB_HISTORY_SIZE ?? 100);

interface JobManagerOptions {
  agent: AgentCore;
  dispatchOutput: (channel: { type: string; id: string }, text: string) => Promise<void>;
  storagePath: string;
  database?: ConversationDatabase;
}

export class BackgroundJobManager {
  private agent: AgentCore;
  private dispatchOutput: (channel: { type: string; id: string }, text: string) => Promise<void>;
  private storagePath: string;
  private database?: ConversationDatabase;
  private jobs: BackgroundJob[] = [];
  private activeCount = 0;
  private queue: BackgroundJob[] = [];
  // Serializes concurrent persist() calls to prevent .tmp rename races
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: JobManagerOptions) {
    this.agent = opts.agent;
    this.dispatchOutput = opts.dispatchOutput;
    this.storagePath = opts.storagePath;
    this.database = opts.database;
  }

  async start(): Promise<void> {
    const persisted = await loadJobs(this.storagePath);
    // Any jobs that were 'running' or 'queued' at restart are now considered failed
    for (const job of persisted) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = 'Agent restarted while job was running';
        job.completedAt = isoNow();
        this.auditLog('job.interrupted', job, { reason: 'agent_restart' });
      }
    }
    this.jobs = persisted;
    await this.persist();
    log.info({ count: this.jobs.length }, 'Job manager started');
  }

  /**
   * Spawn a background sub-agent job. Returns immediately with the queued job.
   * The job will execute asynchronously.
   */
  async spawn(input: {
    name: string;
    prompt: string;
    targetChannel?: { type: string; id: string };
    scheduledTaskId?: string;
    timeoutMs?: number;
  }): Promise<BackgroundJob> {
    const job: BackgroundJob = {
      id: createId('job'),
      name: input.name,
      prompt: input.prompt,
      status: 'queued',
      createdAt: isoNow(),
      targetChannel: input.targetChannel,
      sessionKey: `job:${createId('session')}`,
      scheduledTaskId: input.scheduledTaskId,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    this.jobs.push(job);
    await this.persist();

    this.auditLog('job.queued', job);
    log.info({ id: job.id, name: job.name, activeCount: this.activeCount }, 'Job queued');

    if (this.activeCount < MAX_CONCURRENT_JOBS) {
      this.runJob(job).catch((err) => {
        log.error({ err, id: job.id }, 'Unexpected error in job runner');
      });
    } else {
      this.queue.push(job);
      log.info({ id: job.id, queueLength: this.queue.length }, 'Job queued — at concurrency limit');
    }

    return job;
  }

  /**
   * Cancel a running or queued job. Returns false if not found or already terminal.
   */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return false;
    }

    // Remove from queue if waiting
    const queueIdx = this.queue.findIndex((j) => j.id === id);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
    }

    job.status = 'cancelled';
    job.completedAt = isoNow();
    await this.persist();

    this.auditLog('job.cancelled', job);
    log.info({ id }, 'Job cancelled');
    return true;
  }

  list(): BackgroundJob[] {
    return this.jobs;
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private async runJob(job: BackgroundJob): Promise<void> {
    // Skip if cancelled before we started
    if (job.status === 'cancelled') {
      this.onJobDone();
      return;
    }

    this.activeCount++;
    job.status = 'running';
    job.startedAt = isoNow();
    await this.persist();

    this.auditLog('job.started', job);
    log.info({ id: job.id, name: job.name, activeCount: this.activeCount }, 'Sub-agent job starting');

    const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const startMs = Date.now();

    try {
      const result = await Promise.race([
        this.agent.chat(
          job.prompt,
          { type: 'job', id: job.id },
          job.sessionKey,
        ),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Job timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);

      job.status = 'completed';
      job.result = result.slice(0, 4000);
      job.completedAt = isoNow();
      await this.persist();

      this.auditLog('job.completed', job, { durationMs: Date.now() - startMs });
      log.info({ id: job.id, resultLen: result.length }, 'Sub-agent job completed');

      if (job.targetChannel) {
        try {
          await this.dispatchOutput(job.targetChannel, result);
        } catch (dispatchErr) {
          log.error({ err: dispatchErr, id: job.id }, 'Failed to dispatch job output');
        }
      }
    } catch (err) {
      // Don't update if already cancelled (cast needed: TS narrows status to
      // 'running'|'completed' from this function's assignments, but cancel()
      // can set it to 'cancelled' concurrently via an external call)
      if ((job.status as JobStatus) !== 'cancelled') {
        job.status = 'failed';
        job.error = String(err).slice(0, 2000);
        job.completedAt = isoNow();
        await this.persist();

        this.auditLog('job.failed', job, { durationMs: Date.now() - startMs, error: job.error });
        log.error({ err, id: job.id }, 'Sub-agent job failed');

        if (job.targetChannel) {
          const errorMsg = `Job "${job.name}" failed: ${job.error}`;
          this.dispatchOutput(job.targetChannel, errorMsg).catch((e) => {
            log.error({ err: e, id: job.id }, 'Failed to dispatch job error');
          });
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.activeCount--;
      this.onJobDone();
    }
  }

  private onJobDone(): void {
    // Prune old completed/failed/cancelled jobs beyond history limit
    const terminal = this.jobs.filter(
      (j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled',
    );
    if (terminal.length > MAX_JOB_HISTORY) {
      const toRemove = terminal.length - MAX_JOB_HISTORY;
      // Remove oldest terminal jobs first
      let removed = 0;
      this.jobs = this.jobs.filter((j) => {
        if (
          removed < toRemove &&
          (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
        ) {
          removed++;
          return false;
        }
        return true;
      });
    }

    // Process next queued job
    if (this.queue.length > 0 && this.activeCount < MAX_CONCURRENT_JOBS) {
      const next = this.queue.shift()!;
      this.runJob(next).catch((err) => {
        log.error({ err, id: next.id }, 'Unexpected error in queued job runner');
      });
    }

    this.persist().catch((err) => {
      log.warn(err, 'Failed to persist jobs after completion');
    });
  }

  private auditLog(
    action: string,
    job: BackgroundJob,
    extra: { durationMs?: number; error?: string; reason?: string } = {},
  ): void {
    if (!this.database) return;
    try {
      this.database.logAudit({
        timestamp: isoNow(),
        action,
        details: JSON.stringify({
          description: this.describeAction(action, job.name),
          name: job.name,
          scheduledTaskId: job.scheduledTaskId,
          promptLen: job.prompt.length,
          targetChannel: job.targetChannel,
          ...(extra.error ? { error: extra.error } : {}),
          ...(extra.reason ? { reason: extra.reason } : {}),
        }),
        channelType: job.targetChannel?.type ?? 'job',
        channelId: job.targetChannel?.id ?? job.id,
        sessionKey: job.sessionKey,
        jobId: job.id,
        durationMs: extra.durationMs,
      });
    } catch (err) {
      log.warn({ err, action, jobId: job.id }, 'Failed to write job audit entry');
    }
  }

  private describeAction(action: string, jobName: string): string {
    switch (action) {
      case 'job.queued':
        return `Queued job "${jobName}"`;
      case 'job.started':
        return `Started job "${jobName}"`;
      case 'job.completed':
        return `Completed job "${jobName}"`;
      case 'job.failed':
        return `Job "${jobName}" failed`;
      case 'job.cancelled':
        return `Cancelled job "${jobName}"`;
      case 'job.interrupted':
        return `Job "${jobName}" interrupted`;
      default:
        return `Job event: ${action}`;
    }
  }

  private persist(): Promise<void> {
    // Chain onto the previous persist so concurrent callers never overlap on the .tmp file
    this.persistChain = this.persistChain.then(() => saveJobs(this.storagePath, this.jobs));
    return this.persistChain;
  }
}
