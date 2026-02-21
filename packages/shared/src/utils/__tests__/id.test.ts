import { describe, it, expect } from 'vitest';
import { createId } from '../id.js';

describe('createId', () => {
  it('returns a non-empty string', () => {
    expect(typeof createId()).toBe('string');
    expect(createId().length).toBeGreaterThan(0);
  });

  it('generates 21-character base IDs', () => {
    // nanoid(21) produces 21 chars; with prefix it's prefix_<21>
    expect(createId().length).toBe(21);
  });

  it('prepends prefix separated by underscore', () => {
    const id = createId('audit');
    expect(id.startsWith('audit_')).toBe(true);
    expect(id.split('_')[1].length).toBe(21);
  });

  it('produces unique values', () => {
    const ids = Array.from({ length: 100 }, () => createId());
    expect(new Set(ids).size).toBe(100);
  });

  it('works with different prefixes without collision', () => {
    const a = createId('job');
    const b = createId('session');
    expect(a).not.toBe(b);
    expect(a.startsWith('job_')).toBe(true);
    expect(b.startsWith('session_')).toBe(true);
  });
});
