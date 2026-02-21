import { Cron } from 'croner';
import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import type { ScheduledTask } from '@jonas/shared/types';
import type { AgentCore } from '../agent/core.js';
import type { BackgroundJobManager } from './job-manager.js';
import { loadTasks, saveTasks } from './storage.js';

const log = createLogger('scheduler');

interface SchedulerOptions {
  agent: AgentCore;
  jobManager: BackgroundJobManager;
  dispatchOutput: (channel: { type: string; id: string }, text: string) => Promise<void>;
  storagePath: string;
}

export class TaskScheduler {
  private agent: AgentCore;
  private jobManager: BackgroundJobManager;
  private dispatchOutput: (channel: { type: string; id: string }, text: string) => Promise<void>;
  private storagePath: string;
  private tasks: ScheduledTask[] = [];
  private jobs = new Map<string, Cron>();

  constructor(opts: SchedulerOptions) {
    this.agent = opts.agent;
    this.jobManager = opts.jobManager;
    this.dispatchOutput = opts.dispatchOutput;
    this.storagePath = opts.storagePath;
  }

  async start(): Promise<void> {
    this.tasks = await loadTasks(this.storagePath);
    for (const task of this.tasks) {
      if (task.enabled) this.schedule(task);
    }
    log.info({ count: this.tasks.length }, 'Scheduler started');
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
    log.info('Scheduler stopped');
  }

  async add(input: {
    name: string;
    cron: string;
    prompt: string;
    targetChannel?: { type: string; id: string };
    timeoutMs?: number;
  }): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: createId('task'),
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      targetChannel: input.targetChannel,
      status: 'pending',
      enabled: true,
      createdAt: isoNow(),
      timeoutMs: input.timeoutMs,
    };

    this.tasks.push(task);
    this.schedule(task);
    await this.persist();
    log.info({ id: task.id, name: task.name, cron: task.cron }, 'Task added');
    return task;
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;

    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }

    this.tasks.splice(idx, 1);
    await this.persist();
    log.info({ id }, 'Task removed');
    return true;
  }

  async update(
    id: string,
    changes: Partial<Pick<ScheduledTask, 'name' | 'cron' | 'prompt' | 'targetChannel' | 'enabled' | 'timeoutMs'>>,
  ): Promise<ScheduledTask | null> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;

    Object.assign(task, changes);

    // Reschedule if cron or enabled changed
    const existingJob = this.jobs.get(id);
    if (existingJob) {
      existingJob.stop();
      this.jobs.delete(id);
    }

    if (changes.enabled === false) {
      task.nextRun = undefined;
      if (task.status === 'running') {
        task.status = 'pending';
      }
    }

    if (task.enabled) {
      this.schedule(task);
    }

    await this.persist();
    log.info({ id, changes }, 'Task updated');
    return task;
  }

  list(): ScheduledTask[] {
    // Update nextRun from live cron jobs
    for (const task of this.tasks) {
      if (!task.enabled && task.status === 'running') {
        task.status = 'pending';
      }
      const job = this.jobs.get(task.id);
      if (job) {
        const next = job.nextRun();
        task.nextRun = next ? next.toISOString() : undefined;
      } else {
        task.nextRun = undefined;
      }
    }
    return this.tasks;
  }

  /**
   * Spawn the task as a background sub-agent job. Returns the job ID immediately.
   */
  async runNow(id: string): Promise<string | null> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    const job = await this.spawnJob(task);
    return job.id;
  }

  private schedule(task: ScheduledTask): void {
    const job = new Cron(task.cron, () => {
      this.spawnJob(task).catch((err) => {
        log.error(err, 'Failed to spawn background job for scheduled task');
      });
    });
    this.jobs.set(task.id, job);

    const next = job.nextRun();
    task.nextRun = next ? next.toISOString() : undefined;
  }

  /**
   * Dispatch this task to the job manager as a background sub-agent.
   * Returns immediately with the queued job; execution is non-blocking.
   */
  private async spawnJob(task: ScheduledTask): Promise<import('@jonas/shared/types').BackgroundJob> {
    log.info({ id: task.id, name: task.name }, 'Spawning background sub-agent for scheduled task');
    task.status = 'running';
    task.lastRun = isoNow();
    await this.persist();

    const job = await this.jobManager.spawn({
      name: task.name,
      prompt: task.prompt,
      targetChannel: task.targetChannel,
      scheduledTaskId: task.id,
      timeoutMs: task.timeoutMs,
    });

    // Update task status once job settles (non-blocking)
    this.watchJob(task, job.id);

    return job;
  }

  /**
   * Poll the job manager until the job for this task finishes,
   * then update the task's status and lastResult.
   */
  private watchJob(task: ScheduledTask, jobId: string): void {
    const check = async (): Promise<void> => {
      const job = this.jobManager.get(jobId);
      if (!job) return;

      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        task.status = job.status === 'completed' ? 'completed' : 'failed';
        task.lastResult = (job.result ?? job.error ?? '').slice(0, 2000);
        await this.persist();
        log.info({ taskId: task.id, jobId, status: task.status }, 'Scheduled task finished via sub-agent');
        return;
      }

      // Check again in 5 seconds
      setTimeout(() => {
        check().catch((err) => log.warn(err, 'Error watching job status'));
      }, 5000);
    };

    setTimeout(() => {
      check().catch((err) => log.warn(err, 'Error watching job status'));
    }, 5000);
  }

  private async persist(): Promise<void> {
    await saveTasks(this.storagePath, this.tasks);
  }
}
