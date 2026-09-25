import { describe, expect, it } from 'vitest';
import { entraIdDocument, googleWorkspaceDocument, snipeItDocument } from './http/documents/index.js';
import { httpConnectorDocument } from './http/document.js';
import {
  EMAIL_KEY_POLICY,
  SAM_KEY_POLICY,
  correlationKeyPolicyFor,
} from './naming.js';

const withNaming = (naming: unknown) => ({ document: { ...snipeItDocument, naming } });

describe('correlationKeyPolicyFor', () => {
  it('Active Directory: [a-z0-9.-], 20 characters, as it always was', () => {
    expect(correlationKeyPolicyFor('activeDirectory', {})).toEqual({
      charset: 'sam',
      maxLength: 20,
    });
  });

  it('Entra ID: unchanged -- the key stays the @-less local part of the UPN', () => {
    expect(correlationKeyPolicyFor('entraId', { tenantId: 'contoso.com' })).toEqual(SAM_KEY_POLICY);
  });

  it('SCIM: email-shaped userName', () => {
    expect(correlationKeyPolicyFor('scim2', {})).toEqual(EMAIL_KEY_POLICY);
  });

  it('an HTTP document with no naming block keeps the Active Directory rule', () => {
    const { naming: _ignored, ...document } = snipeItDocument;
    expect(correlationKeyPolicyFor('httpJson', { document })).toEqual(SAM_KEY_POLICY);
    // The shipped documents that do not opt in, whose live targets' keys were
    // generated under the old rule.
    expect(correlationKeyPolicyFor('httpJson', { document: entraIdDocument })).toEqual(
      SAM_KEY_POLICY,
    );
    expect(correlationKeyPolicyFor('httpJson', { document: googleWorkspaceDocument })).toEqual(
      SAM_KEY_POLICY,
    );
  });

  it('an HTTP document may opt into email keys, and tighten but never loosen the cap', () => {
    expect(correlationKeyPolicyFor('httpJson', withNaming({ allow: 'email' }))).toEqual(
      EMAIL_KEY_POLICY,
    );
    expect(
      correlationKeyPolicyFor('httpJson', withNaming({ allow: 'email', maxLength: 100 })),
    ).toEqual({ charset: 'email', maxLength: 100 });
    expect(correlationKeyPolicyFor('httpJson', withNaming({ allow: 'sam', maxLength: 200 }))).toEqual(
      SAM_KEY_POLICY,
    );
  });
});

describe('the document naming block', () => {
  it('refuses an unknown rule, an unknown key and an impossible length', () => {
    for (const naming of [
      { allow: 'unicode' },
      { allow: 'email', extra: true },
      { allow: 'email', maxLength: 0 },
      { allow: 'email', maxLength: 255 },
    ]) {
      expect(httpConnectorDocument.safeParse({ ...snipeItDocument, naming }).success).toBe(false);
    }
  });
});
