import { readFile, writeFile, rename } from 'node:fs/promises';
import type { BackgroundJob } from '@jonas/shared/types';

export async function loadJobs(path: string): Promise<BackgroundJob[]> {
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data) as BackgroundJob[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export async function saveJobs(path: string, jobs: BackgroundJob[]): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(jobs, null, 2), 'utf-8');
  await rename(tmp, path);
}
