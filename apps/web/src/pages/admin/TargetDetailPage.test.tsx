import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TargetDetailPage } from './TargetDetailPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const renderNew = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/new']}>
      <Routes>
        <Route path="/admin/targets/new" element={<TargetDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const renderExisting = () =>
  render(
    <MemoryRouter initialEntries={['/admin/targets/t1']}>
      <Routes>
        <Route path="/admin/targets/:id" element={<TargetDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

const target = (overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Samba AD',
  config: {
    url: 'ldaps://dc.acme.test',
    tlsMode: 'ldaps',
    rejectUnauthorized: false,
    bindDn: 'CN=svc,DC=acme,DC=test',
    baseDn: 'OU=Staff,DC=acme,DC=test',
    entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
    archiveContainer: 'OU=Archive,DC=acme,DC=test',
  },
  enabled: true,
  autoApply: false,
  schedule: null,
  enforcementMode: 'additive',
  preHireDays: 0,
  entitlementRevocationDelayDays: 0,
  disableGraceDays: 0,
  archiveAfterDays: null,
  reenableWithoutConfirmationDays: 7,
  renameEnabled: false,
  createAccountThresholdPercent: 20,
  disableAccountThresholdPercent: 10,
  archiveAccountThresholdPercent: 2,
  revokeEntitlementThresholdPercent: 10,
  deactivateSyntraUserThresholdPercent: 10,
  perEntitlementThresholdPercent: 50,
  personPopulationDropPercent: 20,
  consecutiveSkippedRuns: 0,
  lastSkipReason: null,
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TargetDetailPage', () => {
  it('reports a right it could not confirm as unchecked, not as granted', async () => {
    // The failure this test exists to catch: a directory that does not publish
    // effective rights renders indistinguishably from one that granted them,
    // so an administrator reads "connected" and discovers at the first run
    // that the bind account cannot create anybody.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({
        ok: true,
        message: 'Bound as CN=svc,DC=acme,DC=test',
        rights: [
          { right: 'createUser', status: 'granted', detail: 'Confirmed on OU=Staff' },
          { right: 'modifyUser', status: 'denied', detail: 'Refused on OU=Staff' },
          {
            right: 'moveUser',
            status: 'unverified',
            detail: 'The server publishes no effective rights',
          },
          {
            right: 'modifyMembership',
            status: 'granted',
            detail: 'Confirmed on CN=Finance',
          },
        ],
      }),
    );

    renderNew();
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    expect(
      await screen.findByText('Move accounts between containers'),
    ).toBeVisible();
    expect(screen.getByText(/could not check/i)).toBeVisible();

    // The load-bearing assertion: exactly the two genuinely granted rights say
    // so. If `unverified` ever renders as `granted`, this count becomes three.
    expect(screen.getAllByText('granted')).toHaveLength(2);
    expect(screen.getByText('denied')).toBeVisible();
  });

  it('gives the three right states three different tones', async () => {
    // The count above is necessary and not sufficient: rendering `unverified`
    // with the SAME tone as `granted` under a different word would still leave
    // an administrator reading a wall of green. Three states, three classes.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({
        ok: true,
        message: 'Bound',
        rights: [
          { right: 'createUser', status: 'granted', detail: '' },
          { right: 'modifyUser', status: 'denied', detail: '' },
          { right: 'moveUser', status: 'unverified', detail: '' },
        ],
      }),
    );

    renderNew();
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    const tone = (text: RegExp | string) =>
      screen.getByText(text).className.replace(/\s+/g, ' ');
    const granted = tone('granted');
    const denied = tone('denied');
    const unchecked = tone(/could not check/i);

    expect(new Set([granted, denied, unchecked]).size).toBe(3);
  });

  it('offers the create form without loading a target first', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderNew();

    expect(await screen.findByLabelText(/^name$/i)).toBeVisible();
    expect(screen.getByLabelText(/^url$/i)).toBeVisible();
    expect(screen.getByLabelText(/bind dn/i)).toBeVisible();
    expect(screen.getByLabelText(/bind password/i)).toBeVisible();
    // Every field `targetConfigSchema` requires, or the create is a 400 the
    // form cannot explain: it refuses a config without an entitlement search
    // base or an archive container just as firmly as one without a URL.
    expect(screen.getByLabelText(/entitlement search base/i)).toBeVisible();
    expect(screen.getByLabelText(/archive container/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /create target/i })).toBeVisible();
    // A create page that fetches a target by id is a create page that 404s.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leads with the skipped runs a schedule never started', async () => {
    // Ruling P4. `consecutiveSkippedRuns` has been written since Task 16 and
    // read by nothing: a target that has silently stopped provisioning looked
    // exactly like one running cleanly.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        target({
          consecutiveSkippedRuns: 4,
          lastSkipReason: 'a run is awaiting review',
        }),
      ),
    );

    renderExisting();

    expect(
      await screen.findByText('4 scheduled runs did not start'),
    ).toBeVisible();
    expect(screen.getByText('a run is awaiting review')).toBeVisible();
  });

  it('says nothing about skipped runs when none were skipped', async () => {
    // The other half, and the reason the first is worth anything: a banner
    // that is always there is a banner nobody reads.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));

    renderExisting();

    // Waited on by value, not by presence: every field renders blank on the
    // first pass and is filled when the read lands, so asserting on the label
    // alone races the fetch and passes for the wrong reason.
    expect(await screen.findByDisplayValue('Samba AD')).toBeVisible();
    expect(screen.queryByText(/did not start/i)).toBeNull();
  });

  it('never puts the stored bind password back in the form', async () => {
    // The API does not return it and this page must not invent a placeholder
    // that would be sent back as a new password on the next save.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));

    renderExisting();

    expect(await screen.findByDisplayValue('CN=svc,DC=acme,DC=test')).toBeVisible();
    expect(screen.getByLabelText(/bind password/i)).toHaveValue('');
  });
});
