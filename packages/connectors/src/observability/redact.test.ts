import { describe, expect, it } from 'vitest';
import {
  isPersonalKey,
  isSecretKey,
  LOG_REDACT_PATHS,
  redactValue,
  scrubText,
  serializeError,
} from './redact.js';

/**
 * Every secret and personal value the fixtures below plant. A test passes only
 * when NONE of them survives serialisation -- asserted on the JSON text, not on
 * the structure, because the structure is exactly what a leak route bypasses.
 */
const SECRETS = [
  'Sup3rS3cretBindPw!',
  'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlLWJ5dGVz',
  'ghp_live_R4nd0mT0kenValue0123456789ABCdef',
  'client-secret-9f8e7d6c5b4a',
  'syntra_session=abc123cookievalue',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'JBSWY3DPEHPK3PXP',
  'RC-1111-2222-3333',
  'vault-plaintext-value',
  'PHNhbWxwOlJlc3BvbnNl',
  'hunter2-db-password',
];
const PERSONAL = ['jane.doe@acme.test', 'Jane Doe', '+44 7700 900123', 'jdoe'];

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value);
  return [...SECRETS, ...PERSONAL].filter((needle) => text.includes(needle));
}

describe('serializeError', () => {
  it('projects an HTTP client error to method, URL and status, dropping its Authorization header and body', () => {
    // The shape axios and similar clients throw: the request config -- with
    // the bearer token in its headers and the password in its body -- hangs
    // off the error, and a stock serializer copies all of it.
    const error = Object.assign(new Error('Request failed with status code 401'), {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      config: {
        method: 'post',
        url: 'https://graph.example.test/v1.0/users?$filter=mail eq \'jane.doe@acme.test\'',
        headers: {
          Authorization: 'Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef',
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ password: 'Sup3rS3cretBindPw!', userPrincipalName: 'jane.doe@acme.test' }),
      },
      request: { _header: 'POST /v1.0/users HTTP/1.1\r\nAuthorization: Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef\r\n' },
      response: {
        status: 401,
        headers: { 'set-cookie': 'syntra_session=abc123cookievalue', 'retry-after': '5' },
        data: { error: 'invalid_client', client_secret: 'client-secret-9f8e7d6c5b4a' },
        config: { headers: { Authorization: 'Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef' } },
      },
    });

    const out = serializeError(error) as Record<string, unknown>;
    expect(leaks(out)).toEqual([]);
    expect(out.type).toBe('AxiosError');
    expect(out.code).toBe('ERR_BAD_REQUEST');
    expect(out.message).toBe('Request failed with status code 401');
    expect(out.config).toMatchObject({ method: 'post', url: 'https://graph.example.test/v1.0/users' });
    expect(out.response).toMatchObject({ status: 401 });
  });

  it('keeps an LDAP bind failure diagnosable without its DN or password', () => {
    const cause = Object.assign(new Error('Invalid Credentials'), {
      code: 49,
      name: 'InvalidCredentialsError',
      dn: 'CN=Jane Doe,OU=Staff,DC=acme,DC=test',
    });
    const error = new Error(
      'bind as CN=Jane Doe,OU=Staff,DC=acme,DC=test with password=Sup3rS3cretBindPw! failed',
      { cause },
    );
    Object.assign(error, { bindDN: 'CN=Jane Doe,OU=Staff,DC=acme,DC=test', bindPassword: 'Sup3rS3cretBindPw!', host: 'dc01.acme.test' });

    const out = serializeError(error) as Record<string, unknown>;
    expect(leaks(out)).toEqual([]);
    // The directory itself stays visible: which domain, which host, what code.
    expect(out.message).toContain('DC=acme,DC=test');
    expect(out.host).toBe('dc01.acme.test');
    expect((out.cause as Record<string, unknown>).code).toBe(49);
    expect((out.cause as Record<string, unknown>).message).toBe('Invalid Credentials');
  });

  it('scrubs a connection string, a PEM key and a SAML response out of messages and stacks', () => {
    const error = new Error(
      [
        "Can't reach database server at postgres://syntra:hunter2-db-password@db.internal:5432/syntra",
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
        '<samlp:Response ID="x"><saml:Assertion>PHNhbWxwOlJlc3BvbnNl</saml:Assertion></samlp:Response>',
      ].join(' '),
    );
    const out = serializeError(error) as Record<string, unknown>;
    expect(leaks(out)).toEqual([]);
    expect(out.message).toContain('db.internal:5432');
    expect(String(out.stack)).not.toContain('hunter2');
  });

  it('follows causes and AggregateError members with the same rules', () => {
    const inner = Object.assign(new Error('token refresh failed'), { refreshToken: 'ghp_live_R4nd0mT0kenValue0123456789ABCdef' });
    const aggregate = new AggregateError([inner, new Error('mail to jane.doe@acme.test bounced')], 'two failures', { cause: inner });
    const out = serializeError(aggregate);
    expect(leaks(out)).toEqual([]);
    expect(JSON.stringify(out)).toContain('token refresh failed');
  });

  it('survives circular references and hostile getters', () => {
    const error = new Error('loop') as Error & { self?: unknown };
    error.self = error;
    Object.defineProperty(error, 'boom', { enumerable: true, get: () => { throw new Error('getter'); } });
    expect(() => JSON.stringify(serializeError(error))).not.toThrow();
  });

  it('serialises a non-Error rejection through the same rules', () => {
    const rejected = { message: 'nope', config: { headers: { Authorization: 'Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef' } } };
    expect(leaks(serializeError(rejected))).toEqual([]);
    expect(serializeError('a string with password=Sup3rS3cretBindPw!')).toEqual({
      type: 'string',
      message: 'a string with password=[redacted]',
    });
  });
});

describe('redactValue', () => {
  it('replaces secrets and personal data by key, at any depth, whatever the casing', () => {
    const value = {
      tenantId: '4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11',
      target: {
        type: 'entraId',
        config: { tenantId: 'x', clientId: 'app', client_secret: 'client-secret-9f8e7d6c5b4a', clientSecret: 'client-secret-9f8e7d6c5b4a' },
      },
      totpSecret: 'JBSWY3DPEHPK3PXP',
      recoveryCodes: ['RC-1111-2222-3333'],
      vault: { plaintext: 'vault-plaintext-value' },
      SAMLResponse: 'PHNhbWxwOlJlc3BvbnNl',
      headers: { cookie: 'syntra_session=abc123cookievalue', 'x-request-id': 'r-1' },
      person: { displayName: 'Jane Doe', email: 'jane.doe@acme.test' },
      account: { sAMAccountName: 'jdoe', mobilePhone: '+44 7700 900123', givenName: 'Jane' },
    };
    const out = redactValue(value) as Record<string, unknown>;
    expect(leaks(out)).toEqual([]);
    // Opaque ids and diagnostic headers survive: without them nothing can be
    // scoped or correlated.
    expect(out.tenantId).toBe('4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11');
    expect((out.headers as Record<string, unknown>)['x-request-id']).toBe('r-1');
    expect((out.target as Record<string, unknown>).type).toBe('entraId');
  });

  it('bounds a logged batch instead of copying it', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ employeeId: `E${i}`, status: 'active' }));
    const out = redactValue({ rows, long: 'x'.repeat(50_000) }) as { rows: unknown[]; long: string };
    expect(out.rows.length).toBeLessThanOrEqual(51);
    expect(out.long.length).toBeLessThan(1_100);
    expect(JSON.stringify(out)).not.toContain('E42');
  });

  it('never emits bytes', () => {
    expect(redactValue({ key: Buffer.from('secret-bytes') })).toEqual({ key: '[bytes:12]' });
  });
});

describe('scrubText', () => {
  it('leaves ordinary diagnostics alone', () => {
    const kept = [
      'P2028',
      'ECONNREFUSED 10.0.0.5:636',
      'provisioning run 4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11 failed at action 12',
      'Basic auth failed',
      'at runJob (D:/PROJECTS/Syntra/packages/core/src/jobs/scheduler.ts:104:7)',
      'the rootPath is missing',
    ];
    for (const text of kept) expect(scrubText(text)).toBe(text);
  });

  it('removes query strings, URL credentials, bearer tokens, JWTs and emails', () => {
    const text = scrubText(
      'GET https://idp.example.test/cb?code=abc&state=def by jane.doe@acme.test with Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef ' +
        'id eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlLWJ5dGVz via https://u:hunter2-db-password@h.test/',
    );
    expect(leaks(text)).toEqual([]);
    expect(text).toContain('https://idp.example.test/cb?[redacted]');
  });
});

describe('key classification', () => {
  it('matches secrets across naming conventions without swallowing error codes', () => {
    for (const key of ['password', 'bindPassword', 'client_secret', 'Authorization', 'set-cookie', 'x-api-key', 'accessToken', 'privateKey', 'totpSecret', 'recoveryCodes', 'SAMLResponse']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['code', 'status', 'tenantId', 'rootPath', 'jobName', 'targetType']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('matches personal fields but not infrastructure', () => {
    for (const key of ['email', 'personalEmail', 'displayName', 'givenName', 'userPrincipalName', 'dn', 'mobilePhone', 'employeeId']) {
      expect(isPersonalKey(key), key).toBe(true);
    }
    for (const key of ['host', 'tenantId', 'name', 'className', 'groupName', 'remoteAddress']) {
      expect(isPersonalKey(key), key).toBe(false);
    }
  });

  it('gives pino literal paths it can compile', () => {
    // fast-redact rejects anything beyond dotted/bracketed literals with a
    // single leading wildcard; a bad path would fail logger construction.
    for (const path of LOG_REDACT_PATHS) {
      expect(path).toMatch(/^(\*\.|\*)?[\w$[\]".-]+(\.[\w$[\]".-]+)*$/);
    }
  });
});
