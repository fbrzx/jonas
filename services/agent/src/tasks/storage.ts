import { readFile, writeFile, rename } from 'node:fs/promises';
import type { ScheduledTask } from '@jonas/shared/types';

export async function loadTasks(path: string): Promise<ScheduledTask[]> {
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data) as ScheduledTask[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export async function saveTasks(path: string, tasks: ScheduledTask[]): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf-8');
  await rename(tmp, path);
}
