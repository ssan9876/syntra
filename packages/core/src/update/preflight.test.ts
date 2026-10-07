import { describe, expect, it, vi } from 'vitest';
import {
  backupsCheck,
  diskCheck,
  migrationsCheck,
  migrationsInNotes,
  releaseFilesCheck,
  releasesBetween,
  releasesCheck,
} from './preflight.js';
import { fetchReleases, type AvailableRelease } from './update-service.js';

const release = (version: string, notes = 'No migrations.', assets: string[] = []): AvailableRelease => ({
  version,
  released: '2026-10-07T12:00:00Z',
  notes,
  migrations: [],
  assets,
});

describe('migrationsInNotes', () => {
  it('reads each format the release notes have used', () => {
    // 1.22.0 onwards: one line each, with whether it rewrites data.
    expect(migrationsInNotes('Migrations\n- 20261120000000_audit_streams: adds the AuditStream table. Does not rewrite data.\n\nValidation: …')).toEqual([
      { name: '20261120000000_audit_streams', text: 'adds the AuditStream table. Does not rewrite data.', rewrites: false },
    ]);
    // 1.15.0: a heading, then bare names.
    expect(migrationsInNotes('Database migrations (both add nullable columns; no data is rewritten)\n- 20261105000000_tenant_support_destination\n- 20261105010000_application_icons')).toEqual([
      { name: '20261105000000_tenant_support_destination', text: '', rewrites: false },
      { name: '20261105010000_application_icons', text: '', rewrites: false },
    ]);
    // 1.18.0: inside a sentence.
    expect(migrationsInNotes('- Role.systemKey. Migration\n  20261111000000_data_deletion_role keys each Owner')!.map((m) => m.name)).toEqual(['20261111000000_data_deletion_role']);
  });

  it('flags a migration its release says rewrites data', () => {
    expect(migrationsInNotes('- 20261201000000_person_names: rewrites every Person row to split the name.')![0]!.rewrites).toBe(true);
  });

  it('tells "none" from "not listed"', () => {
    expect(migrationsInNotes('Fixed a thing.\n\nNo migrations.')).toEqual([]);
    expect(migrationsInNotes('Fixed a thing.')).toBeNull();
  });
});

describe('releasesBetween', () => {
  it('keeps the releases after the current one up to the target, oldest first', () => {
    const list = ['1.23.0', '1.22.0', '1.21.0', '1.20.0', '1.24.0'].map((v) => release(v));
    expect(releasesBetween(list, '1.21.0', '1.23.0').map((r) => r.version)).toEqual(['1.22.0', '1.23.0']);
  });
});

describe('checks', () => {
  it('fails while the release files are not published', () => {
    expect(releaseFilesCheck(release('1.23.0', '', ['syntra-1.23.0.tar.gz', 'syntra-1.23.0.tar.gz.sha256'])).status).toBe('pass');
    expect(releaseFilesCheck(release('1.23.0', '', ['syntra-1.23.0.tar.gz']))).toMatchObject({
      status: 'fail',
      detail: 'syntra-1.23.0.tar.gz.sha256 not published for 1.23.0. Check again when its release build finishes.',
    });
  });

  it('lists the releases an update skips over', () => {
    expect(releasesCheck([release('1.23.0')], '1.22.0')).toMatchObject({ status: 'pass', detail: '1.23.0, the next release after 1.22.0.' });
    expect(releasesCheck([release('1.22.0'), release('1.23.0')], '1.21.0')).toMatchObject({
      status: 'info',
      detail: '2 releases since 1.21.0. Their notes are below.',
      items: ['1.22.0 · released 2026-10-07', '1.23.0 · released 2026-10-07'],
    });
  });

  it('adds up the database changes of every release installed', () => {
    expect(migrationsCheck([release('1.23.0')])).toMatchObject({ status: 'pass', detail: 'None.' });
    expect(
      migrationsCheck([
        release('1.22.0', '- 20261120000000_audit_streams: adds the AuditStream table. Does not rewrite data.'),
        release('1.23.0', '- 20261121000000_audit_stream_history: adds a table. Does not rewrite data.'),
        release('1.23.1', 'Fixed a thing.'),
      ]),
    ).toMatchObject({
      status: 'info',
      detail: '2 changes. The update backs up the database first.',
      items: [
        '20261120000000_audit_streams: adds the AuditStream table. Does not rewrite data.',
        '20261121000000_audit_stream_history: adds a table. Does not rewrite data.',
        'Not listed in the notes for 1.23.1.',
      ],
    });
    expect(migrationsCheck([release('2.0.0', '- 20261201000000_person_names: rewrites every Person row.')])).toMatchObject({
      status: 'warn',
      detail: '1 of 1 change rewrites data. The update takes longer, and a rollback restores the backup it takes first.',
    });
  });

  it('fails under 1 GB free and warns under 3 GB', () => {
    const gib = 1024 ** 3;
    expect(diskCheck(0.5 * gib, '/opt/syntra')).toMatchObject({ status: 'fail', detail: '0.5 GB free on /opt/syntra. An update needs about 1 GB. Free space, then check again.' });
    expect(diskCheck(2 * gib, '/opt/syntra').status).toBe('warn');
    expect(diskCheck(52 * gib, '/opt/syntra')).toMatchObject({ status: 'pass', detail: '52.0 GB free on /opt/syntra.' });
  });

  it('asks for a fresh backup when the last one is old or missing', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(backupsCheck({ configured: false }, now).status).toBe('info');
    expect(backupsCheck({ configured: true, reachable: false }, now).status).toBe('warn');
    expect(backupsCheck({ configured: true, reachable: true, lastSuccessAt: null }, now)).toMatchObject({ status: 'warn', href: '/admin/backups' });
    expect(backupsCheck({ configured: true, reachable: true, lastSuccessAt: '2026-10-07T11:46:00Z' }, now)).toMatchObject({ status: 'pass', detail: 'Last backup 14 minutes ago.' });
    expect(backupsCheck({ configured: true, reachable: true, lastSuccessAt: '2026-10-04T12:00:00Z' }, now)).toMatchObject({
      status: 'warn',
      detail: 'Last backup 3 days ago. Select Back up now on the Backups page first.',
    });
  });
});

describe('fetchReleases', () => {
  it('reads published releases with their files, and leaves out drafts and pre-releases', async () => {
    const body = [
      { tag_name: 'v1.24.0-rc1', prerelease: true },
      { tag_name: 'v1.23.0', body: 'notes', published_at: '2026-10-07T12:00:00Z', assets: [{ name: 'syntra-1.23.0.tar.gz' }] },
      { tag_name: 'v1.22.0', draft: true },
    ];
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
    const result = await fetchReleases('tok', 'acme/syntra', fetchImpl as never);
    expect(result).toEqual({ ok: true, releases: [{ version: '1.23.0', released: '2026-10-07T12:00:00Z', notes: 'notes', migrations: [], assets: ['syntra-1.23.0.tar.gz'] }] });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/syntra/releases?per_page=50');
  });

  it('says why when the forge refuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await fetchReleases('tok', 'acme/syntra', fetchImpl as never)).toMatchObject({ ok: false, reason: expect.stringContaining('401') });
  });
});
