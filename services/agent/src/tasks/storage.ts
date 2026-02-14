import { readFile, writeFile, rename } from 'node:fs/promises';
import type { ScheduledTask } from '@jonas/shared/types';

interface LegacyTask {
  targetRoomId?: string;
  targetChannel?: { type: string; id: string };
}

export async function loadTasks(path: string): Promise<ScheduledTask[]> {
  try {
    const data = await readFile(path, 'utf-8');
    const tasks = JSON.parse(data) as (ScheduledTask & LegacyTask)[];

    // Migrate legacy targetRoomId → targetChannel
    for (const task of tasks) {
      if ('targetRoomId' in task && task.targetRoomId && !task.targetChannel) {
        task.targetChannel = { type: 'legacy-matrix', id: task.targetRoomId };
        delete task.targetRoomId;
      }
    }

    return tasks;
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
