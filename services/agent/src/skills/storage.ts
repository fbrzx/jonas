import { readFile, writeFile, rename } from 'node:fs/promises';
import type { SkillStatus } from '@jonas/shared/types';

export type SkillStateMap = Record<string, SkillStatus>;

export async function loadSkillState(path: string): Promise<SkillStateMap> {
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data) as SkillStateMap;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

export async function saveSkillState(path: string, state: SkillStateMap): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, path);
}
