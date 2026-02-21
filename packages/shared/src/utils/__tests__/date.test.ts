import { describe, it, expect } from 'vitest';
import { isoNow } from '../date.js';

describe('isoNow', () => {
  it('returns a valid ISO 8601 string', () => {
    const ts = isoNow();
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('is close to the current time', () => {
    const before = Date.now();
    const ts = isoNow();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('successive calls are non-decreasing', () => {
    const a = new Date(isoNow()).getTime();
    const b = new Date(isoNow()).getTime();
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
