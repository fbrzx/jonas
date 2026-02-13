import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createId } from '@jonas/shared/utils';

const SESSION_DIR = join(homedir(), '.jonas');
const SESSION_FILE = join(SESSION_DIR, 'session.json');

interface SessionData {
  sessionKey: string;
  createdAt: string;
}

export class SessionStore {
  getOrCreate(): string {
    try {
      const data = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) as SessionData;
      return data.sessionKey;
    } catch {
      return this.create();
    }
  }

  create(): string {
    const sessionKey = createId('sess');
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(
      SESSION_FILE,
      JSON.stringify({ sessionKey, createdAt: new Date().toISOString() }),
      'utf-8'
    );
    return sessionKey;
  }

  reset(): string {
    return this.create();
  }
}
