import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadJobs, saveJobs } from '../job-storage.js';
import type { BackgroundJob } from '@jonas/shared/types';

const makeJob = (overrides: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: 'job_test',
  name: 'test job',
  prompt: 'do something',
  status: 'completed',
  createdAt: '2024-01-01T00:00:00.000Z',
  sessionKey: 'job:session_1',
  ...overrides,
});

describe('job-storage', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loadJobs returns empty array when file does not exist', async () => {
    const jobs = await loadJobs('/tmp/nonexistent-jobs-file-12345.json');
    expect(jobs).toEqual([]);
  });

  it('saveJobs then loadJobs round-trips job data', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jonas-test-'));
    const path = join(dir, 'jobs.json');
    const jobs = [makeJob({ id: 'job_1' }), makeJob({ id: 'job_2', status: 'failed' })];

    await saveJobs(path, jobs);
    const loaded = await loadJobs(path);

    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('job_1');
    expect(loaded[1].status).toBe('failed');
  });

  it('saveJobs overwrites existing data atomically', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jonas-test-'));
    const path = join(dir, 'jobs.json');

    await saveJobs(path, [makeJob({ id: 'job_old' })]);
    await saveJobs(path, [makeJob({ id: 'job_new' })]);

    const loaded = await loadJobs(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('job_new');
  });

  it('loadJobs preserves all job fields including optional ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'jonas-test-'));
    const path = join(dir, 'jobs.json');
    const job = makeJob({
      status: 'completed',
      startedAt: '2024-01-01T00:00:01.000Z',
      completedAt: '2024-01-01T00:00:05.000Z',
      result: 'all done',
      targetChannel: { type: 'matrix', id: '!room:server' },
      scheduledTaskId: 'task_123',
      timeoutMs: 30000,
    });

    await saveJobs(path, [job]);
    const [loaded] = await loadJobs(path);

    expect(loaded.startedAt).toBe('2024-01-01T00:00:01.000Z');
    expect(loaded.targetChannel?.type).toBe('matrix');
    expect(loaded.scheduledTaskId).toBe('task_123');
    expect(loaded.timeoutMs).toBe(30000);
  });
});
