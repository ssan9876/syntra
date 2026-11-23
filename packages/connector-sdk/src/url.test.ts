import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from './url.js';

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://svc.example/api///')).toBe('https://svc.example/api');
    expect(trimTrailingSlashes('https://svc.example/api')).toBe('https://svc.example/api');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('runs in linear time on a long slash run that does not reach the end', () => {
    const value = `${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(value)).toBe(value);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
