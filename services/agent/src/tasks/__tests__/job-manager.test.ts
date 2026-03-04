import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BackgroundJobManager } from '../job-manager.js';
import type { AgentCore } from '../../agent/core.js';
import type { BackgroundJob } from '@jonas/shared/types';

function mockAgent(reply = 'done'): AgentCore {
  return {
    chat: vi.fn().mockResolvedValue(reply),
    getAgentId: vi.fn().mockReturnValue('test-agent-id'),
    getAgentName: vi.fn().mockReturnValue('test-agent'),
    getProviderName: vi.fn().mockReturnValue('claude:test'),
    abort: vi.fn(),
  } as unknown as AgentCore;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('BackgroundJobManager', () => {
  let dir: string;
  let storagePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jonas-job-test-'));
    storagePath = join(dir, 'jobs.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('start() recovers interrupted jobs as failed', async () => {
    const { saveJobs } = await import('../job-storage.js');
    await saveJobs(storagePath, [
      { id: 'job_1', name: 'running-at-restart', prompt: 'p', status: 'running', createdAt: '2024-01-01T00:00:00.000Z', sessionKey: 'job:s1' },
      { id: 'job_2', name: 'queued-at-restart', prompt: 'p', status: 'queued', createdAt: '2024-01-01T00:00:00.000Z', sessionKey: 'job:s2' },
      { id: 'job_3', name: 'already-done', prompt: 'p', status: 'completed', createdAt: '2024-01-01T00:00:00.000Z', sessionKey: 'job:s3' },
    ]);

    const mgr = new BackgroundJobManager({ agent: mockAgent(), dispatchOutput: vi.fn(), storagePath });
    await mgr.start();

    const jobs = mgr.list();
    expect(jobs.find((j) => j.id === 'job_1')?.status).toBe('failed');
    expect(jobs.find((j) => j.id === 'job_2')?.status).toBe('failed');
    expect(jobs.find((j) => j.id === 'job_3')?.status).toBe('completed');
  });

  it('spawn() runs job and reaches completed status', async () => {
    const agent = mockAgent('the answer');
    const mgr = new BackgroundJobManager({ agent, dispatchOutput: vi.fn(), storagePath });
    await mgr.start();

    const job = await mgr.spawn({ name: 'test', prompt: 'hello' });
    await waitFor(() => mgr.get(job.id)?.status === 'completed');

    expect(mgr.get(job.id)?.result).toBe('the answer');
    expect(agent.chat).toHaveBeenCalledOnce();
  });

  it('spawn() dispatches result to targetChannel on completion', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const mgr = new BackgroundJobManager({ agent: mockAgent('output'), dispatchOutput: dispatch, storagePath });
    await mgr.start();

    const job = await mgr.spawn({ name: 'test', prompt: 'go', targetChannel: { type: 'matrix', id: '!r:s' } });

    await waitFor(() => mgr.get(job.id)?.status === 'completed');
    expect(dispatch).toHaveBeenCalledWith({ type: 'matrix', id: '!r:s' }, 'output');
  });

  it('spawn() marks job failed and dispatches error on agent error', async () => {
    const failingAgent = { chat: vi.fn().mockRejectedValue(new Error('boom')), getAgentId: vi.fn().mockReturnValue('x'), getAgentName: vi.fn().mockReturnValue('x'), getProviderName: vi.fn().mockReturnValue('x'), abort: vi.fn() } as unknown as AgentCore;
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const mgr = new BackgroundJobManager({ agent: failingAgent, dispatchOutput: dispatch, storagePath });
    await mgr.start();

    const job = await mgr.spawn({ name: 'fail-test', prompt: 'crash', targetChannel: { type: 'matrix', id: '!r:s' } });

    await waitFor(() => mgr.get(job.id)?.status === 'failed');
    expect(mgr.get(job.id)?.error).toContain('boom');
    expect(dispatch).toHaveBeenCalledWith({ type: 'matrix', id: '!r:s' }, expect.stringContaining('failed'));
  });

  it('cancel() cancels a job that is still in the wait queue', async () => {
    // A shared latch that keeps all 5 blocker jobs running until we release them.
    // Using mockReturnValue (not mockResolvedValue) so all calls share the exact same Promise.
    let releaseAll!: () => void;
    const latch = new Promise<string>((resolve) => { releaseAll = () => resolve('done'); });
    const blockingAgent = { chat: vi.fn().mockReturnValue(latch), getAgentId: vi.fn().mockReturnValue('x'), getAgentName: vi.fn().mockReturnValue('x'), getProviderName: vi.fn().mockReturnValue('x'), abort: vi.fn() } as unknown as AgentCore;

    const mgr = new BackgroundJobManager({ agent: blockingAgent, dispatchOutput: vi.fn(), storagePath });
    await mgr.start();

    // Spawn sequentially to avoid concurrent writes to the same .tmp file in saveJobs
    const blockers: BackgroundJob[] = [];
    for (let i = 0; i < 5; i++) {
      blockers.push(await mgr.spawn({ name: `blocker-${i}`, prompt: 'block' }));
    }
    await waitFor(() => blockers.every((b) => mgr.get(b.id)?.status === 'running'));

    // 6th job must land in the internal queue (all 5 slots taken)
    const queued = await mgr.spawn({ name: 'waiter', prompt: 'wait' });
    expect(mgr.get(queued.id)?.status).toBe('queued');

    expect(await mgr.cancel(queued.id)).toBe(true);
    expect(mgr.get(queued.id)?.status).toBe('cancelled');

    // Release blockers so background jobs finish cleanly before afterEach deletes the dir
    releaseAll();
    await waitFor(() => blockers.every((b) => mgr.get(b.id)?.status === 'completed'), 2000);
  });

  it('cancel() returns false for terminal jobs', async () => {
    const mgr = new BackgroundJobManager({ agent: mockAgent(), dispatchOutput: vi.fn(), storagePath });
    await mgr.start();

    const job = await mgr.spawn({ name: 'quick', prompt: 'go' });
    await waitFor(() => mgr.get(job.id)?.status === 'completed');

    expect(await mgr.cancel(job.id)).toBe(false);
  });

  it('cancel() returns false for unknown job id', async () => {
    const mgr = new BackgroundJobManager({ agent: mockAgent(), dispatchOutput: vi.fn(), storagePath });
    await mgr.start();
    expect(await mgr.cancel('nonexistent')).toBe(false);
  });

  it('logs job lifecycle events to the database when provided', async () => {
    const auditEntries: Array<{ action: string; jobId?: string }> = [];
    const mockDb = {
      logAudit: vi.fn((entry) => auditEntries.push({ action: entry.action, jobId: entry.jobId })),
    };

    const mgr = new BackgroundJobManager({
      agent: mockAgent('ok'),
      dispatchOutput: vi.fn(),
      storagePath,
      database: mockDb as any,
    });
    await mgr.start();

    const job = await mgr.spawn({ name: 'audit-test', prompt: 'go' });
    await waitFor(() => mgr.get(job.id)?.status === 'completed');

    const actions = auditEntries.map((e) => e.action);
    expect(actions).toContain('job.queued');
    expect(actions).toContain('job.started');
    expect(actions).toContain('job.completed');
    expect(auditEntries.every((e) => e.jobId === job.id)).toBe(true);
  });

  it('get() returns undefined for unknown id', async () => {
    const mgr = new BackgroundJobManager({ agent: mockAgent(), dispatchOutput: vi.fn(), storagePath });
    await mgr.start();
    expect(mgr.get('no-such-id')).toBeUndefined();
  });
});
