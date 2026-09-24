import { describe, expect, it } from 'vitest';
import { sameOriginServerPath } from './leave.js';

describe('sameOriginServerPath', () => {
  it('preserves a relative protocol continuation', () => {
    expect(
      sameOriginServerPath('/saml/continue?handle=abc#result', 'https://syntra.example'),
    ).toBe('/saml/continue?handle=abc#result');
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    'javascript:alert(1)',
    'data:text/html,owned',
    'saml/continue',
  ])('refuses an external or executable target: %s', (target) => {
    expect(() => sameOriginServerPath(target, 'https://syntra.example')).toThrow(
      /same-origin|this origin/,
    );
  });
});
