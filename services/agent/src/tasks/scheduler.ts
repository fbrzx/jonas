import { Cron } from 'croner';
import { createLogger, createId, isoNow } from '@jonas/shared/utils';
import type { ScheduledTask } from '@jonas/shared/types';
import type { AgentCore } from '../agent/core.js';
import { loadTasks, saveTasks } from './storage.js';

const log = createLogger('scheduler');

interface SchedulerOptions {
  agent: AgentCore;
  dispatchOutput: (channel: { type: string; id: string }, text: string) => Promise<void>;
  storagePath: string;
}

export class TaskScheduler {
  private agent: AgentCore;
  private dispatchOutput: (channel: { type: string; id: string }, text: string) => Promise<void>;
  private storagePath: string;
  private tasks: ScheduledTask[] = [];
  private jobs = new Map<string, Cron>();

  constructor(opts: SchedulerOptions) {
    this.agent = opts.agent;
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
    changes: Partial<Pick<ScheduledTask, 'name' | 'cron' | 'prompt' | 'targetChannel' | 'enabled'>>,
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
      const job = this.jobs.get(task.id);
      if (job) {
        const next = job.nextRun();
        task.nextRun = next ? next.toISOString() : undefined;
      }
    }
    return this.tasks;
  }

  async runNow(id: string): Promise<string | null> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    return this.execute(task);
  }

  private schedule(task: ScheduledTask): void {
    const job = new Cron(task.cron, () => {
      this.execute(task).catch((err) => {
        log.error(err, 'Scheduled task execution failed');
      });
    });
    this.jobs.set(task.id, job);

    const next = job.nextRun();
    task.nextRun = next ? next.toISOString() : undefined;
  }

  private async execute(task: ScheduledTask): Promise<string> {
    log.info({ id: task.id, name: task.name }, 'Executing scheduled task');
    task.status = 'running';
    task.lastRun = isoNow();

    try {
      const response = await this.agent.chat(
        task.prompt,
        { type: 'scheduler', id: task.id },
        `scheduler:${task.id}`,
      );

      task.status = 'completed';
      task.lastResult = response.slice(0, 2000);
      await this.persist();

      if (task.targetChannel) {
        await this.dispatchOutput(task.targetChannel, response);
        log.info({ id: task.id, responseLen: response.length }, 'Task completed, output dispatched');
      } else {
        log.info({ id: task.id, responseLen: response.length }, 'Task completed (no output channel)');
      }
      return response;
    } catch (err) {
      task.status = 'failed';
      task.lastResult = String(err);
      await this.persist();
      log.error(err, 'Task execution failed');
      throw err;
    }
  }

  private async persist(): Promise<void> {
    await saveTasks(this.storagePath, this.tasks);
  }
}
