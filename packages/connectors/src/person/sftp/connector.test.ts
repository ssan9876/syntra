import { describe, expect, it, vi } from 'vitest';

const fetchFile = vi.hoisted(() => vi.fn());
vi.mock('./transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport.js')>()),
  fetchFile,
}));

const { sftpDelimitedConnector, redactCredential } = await import('./connector.js');
const { sftpDelimitedConfigSchema } = await import('./config.js');
const { ByteCeilingExceededError, HostKeyMismatchError, HostKeyUnknownError } =
  await import('./transport.js');

const config = {
  ...sftpDelimitedConfigSchema.parse({
    host: 'hr.example.test',
    username: 'syntra',
    remotePath: '/export/people.csv',
    hostKeyFingerprint: 'SHA256:aaa',
  }),
  password: 'x',
};

const matched = { fingerprint: 'SHA256:aaa', status: 'matched' as const };

describe('sftpDelimitedConnector.test', () => {
  it('reports the columns the file carries', async () => {
    fetchFile.mockResolvedValue({
      text: 'employeeId,firstName\n1,Ada',
      hostKey: matched,
    });
    const result = await sftpDelimitedConnector.test(config);
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(['employeeId', 'firstName']);
    expect(result.hostKey).toEqual(matched);
  });

  /**
   * An unknown key is not a failure of `test` -- it is what `test` is for.
   * The console's accept action acts on exactly this result, so the
   * fingerprint has to survive onto it.
   */
  it('reports an unknown host key with a fingerprint to accept', async () => {
    fetchFile.mockRejectedValue(new HostKeyUnknownError('SHA256:new'));
    const result = await sftpDelimitedConnector.test({
      ...config,
      hostKeyFingerprint: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.hostKey).toEqual({ fingerprint: 'SHA256:new', status: 'unknown' });
  });

  /**
   * A mismatch carries its own status, so the console can withhold the accept
   * action rather than offering it beside a warning.
   */
  it('reports a mismatched host key as a mismatch, not as unknown', async () => {
    fetchFile.mockRejectedValue(new HostKeyMismatchError('SHA256:zzz', 'SHA256:aaa'));
    const result = await sftpDelimitedConnector.test(config);
    expect(result.ok).toBe(false);
    expect(result.hostKey).toEqual({ fingerprint: 'SHA256:zzz', status: 'mismatch' });
  });

  it('does not report ok when the key is merely unknown', async () => {
    fetchFile.mockResolvedValue({
      text: 'employeeId\n1',
      hostKey: { fingerprint: 'SHA256:new', status: 'unknown' as const },
    });
    const result = await sftpDelimitedConnector.test({
      ...config,
      hostKeyFingerprint: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.columns).toEqual(['employeeId']);
  });
});

describe('sftpDelimitedConnector.read', () => {
  it('yields one record per row, keyed by column name', async () => {
    fetchFile.mockResolvedValue({
      text: 'employeeId,firstName\n1,Ada\n2,Grace',
      hostKey: matched,
    });
    const seen: Record<string, string>[] = [];
    for await (const record of sftpDelimitedConnector.read(config)) {
      seen.push(record.fields);
    }
    expect(seen).toEqual([
      { employeeId: '1', firstName: 'Ada' },
      { employeeId: '2', firstName: 'Grace' },
    ]);
  });

  it('requires the key to be pinned before it will read', async () => {
    fetchFile.mockResolvedValue({ text: 'employeeId\n1', hostKey: matched });
    for await (const _ of sftpDelimitedConnector.read(config)) void _;
    expect(fetchFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requirePinned: true }),
    );
  });

  /**
   * A ceiling propagates rather than yielding a short file. Every unread
   * person would otherwise be absent, and absence departs people.
   */
  it('propagates a ceiling error rather than yielding a short file', async () => {
    fetchFile.mockRejectedValue(new ByteCeilingExceededError(10));
    await expect(async () => {
      for await (const _ of sftpDelimitedConnector.read(config)) void _;
    }).rejects.toThrow(ByteCeilingExceededError);
  });

  it('yields nothing for an empty file rather than throwing', async () => {
    fetchFile.mockResolvedValue({ text: '', hostKey: matched });
    const seen = [];
    for await (const record of sftpDelimitedConnector.read(config)) seen.push(record);
    expect(seen).toEqual([]);
  });
});

describe('redactCredential', () => {
  const KEY = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');

  /**
   * ssh2's diagnostics reach an operator and are stored on the run row, and
   * this connector holds a credential while it calls it. `SourceWriteback`
   * states the principle for the LDAP side; the same applies to a library
   * whose error text this code does not control.
   */
  it('removes a password quoted back in a message', () => {
    const text = redactCredential('authentication failed for Syntra!Passw0rd', {
      ...config,
      password: 'Syntra!Passw0rd',
    });
    expect(text).not.toContain('Syntra!Passw0rd');
    expect(text).toContain('[redacted]');
  });

  it('removes a private key quoted in full', () => {
    const withKey = { ...config, privateKey: KEY } as never;
    const text = redactCredential(`cannot parse ${KEY}`, withKey);
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjE');
  });

  /** A message quoting one line of the key is caught too. */
  it('removes a single line of key material', () => {
    const withKey = { ...config, privateKey: KEY } as never;
    const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB';
    const text = redactCredential(`malformed near ${body}`, withKey);
    expect(text).not.toContain(body);
  });

  /**
   * The banners are not secret, and are short enough that redacting them would
   * scrub ordinary words out of unrelated messages.
   */
  it('leaves a message alone when it quotes nothing secret', () => {
    const text = redactCredential('connect ETIMEDOUT 10.0.0.5:22', {
      ...config,
      password: 'Syntra!Passw0rd',
    });
    expect(text).toBe('connect ETIMEDOUT 10.0.0.5:22');
  });

  it('scrubs what a failed read throws, not only what test returns', async () => {
    fetchFile.mockRejectedValue(new Error('auth failed for hunter2'));
    await expect(async () => {
      for await (const _ of sftpDelimitedConnector.read({
        ...config,
        password: 'hunter2',
      })) {
        void _;
      }
    }).rejects.toThrow('auth failed for [redacted]');
  });
});
