import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('gives an in-progress skip different advice from one awaiting review', async () => {
    // `jobs.ts` writes both, and they call for different things: one has a plan
    // somebody must decide about, and the other has nothing to review at all
    // and clears on its own — after six hours at the latest, when a later run
    // adopts the row as the wreckage of a dead process.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        target({
          consecutiveSkippedRuns: 2,
          lastSkipReason:
            'a run from 2026-08-01T03:00:00.000Z is still in progress (running), so this scheduled run did not start',
        }),
      ),
    );

    renderExisting();

    expect(
      await screen.findByText(/There is nothing to review here/),
    ).toBeVisible();
    expect(screen.queryByText(/Review the outstanding run/)).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'Go to the runs for this target' }),
    ).toBeNull();
  });

  it('sends a skip awaiting review to the run that is blocking it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        target({
          consecutiveSkippedRuns: 2,
          lastSkipReason:
            'a run from 2026-08-01T03:00:00.000Z is awaiting review (blocked), so this scheduled run did not start',
        }),
      ),
    );

    renderExisting();

    expect(
      await screen.findByText(/Review the outstanding run/),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Go to the runs for this target' }),
    ).toBeVisible();
  });

  it('says nothing needs doing when two runs simply raced', async () => {
    // `recordSkip` on `ProvisionRunInFlightError`: the partial unique index
    // refused the second run between the skip check and the create.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        target({
          consecutiveSkippedRuns: 1,
          lastSkipReason:
            'another run for target t1 is already in progress; this one did not start',
        }),
      ),
    );

    renderExisting();

    expect(await screen.findByText(/Two runs raced for this target/)).toBeVisible();
    expect(screen.queryByText(/Review the outstanding run/)).toBeNull();
  });

  it('keeps the thresholds somebody typed when the create’s follow-up PATCH is refused', async () => {
    // The ladder and the thresholds are not on the create schema, so they are
    // saved by a second request. When that one is refused the target exists and
    // those numbers do not — and navigating to the new target refetched it and
    // rebuilt the form from the STORED defaults, discarding exactly the numbers
    // the administrator was about to be asked to correct.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (init?.method === 'POST') return Promise.resolve(json({ id: 't1' }));
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              title: 'Validation failed',
              status: 400,
              errors: [
                {
                  path: 'thresholds.createAccountThresholdPercent',
                  message: 'must be between 0 and 100',
                },
              ],
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ) as never,
        );
      }
      // The refetch the navigate causes: stored defaults, not what was typed.
      return Promise.resolve(json(target()));
    });

    render(
      <MemoryRouter initialEntries={['/admin/targets/new']}>
        <Routes>
          <Route path="/admin/targets/new" element={<TargetDetailPage />} />
          <Route path="/admin/targets/:id" element={<TargetDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const threshold = await screen.findByLabelText('Accounts created');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '77');
    await userEvent.click(screen.getByRole('button', { name: /create target/i }));

    expect(
      await screen.findByText(/The target was created, but its deprovisioning/),
    ).toBeVisible();
    // 77, not the 20 the stored target carries.
    expect(screen.getByLabelText('Accounts created')).toHaveValue('77');
    // And the mechanism, not just the symptom: the page did not read the
    // target back, because reading it back is what overwrote the form.
    const reads = (
      fetchMock.mock.calls as [unknown, RequestInit | undefined][]
    ).filter(
      ([input, init]) =>
        String(input).endsWith('/api/admin/targets/t1') && init?.method === undefined,
    );
    expect(reads).toHaveLength(0);
  });

  it('saves rather than creating a second target after a refused follow-up PATCH', async () => {
    // The target exists. A second Create here would make another one.
    let patched = 0;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) => {
        if (init?.method === 'POST') return Promise.resolve(json({ id: 't1' }));
        if (init?.method === 'PATCH') {
          patched += 1;
          return patched === 1
            ? Promise.resolve(
                new Response(
                  JSON.stringify({
                    title: 'Validation failed',
                    status: 400,
                    errors: [
                      {
                        path: 'thresholds.createAccountThresholdPercent',
                        message: 'must be between 0 and 100',
                      },
                    ],
                  }),
                  { status: 400, headers: { 'content-type': 'application/json' } },
                ) as never,
              )
            : Promise.resolve(json(null));
        }
        return Promise.resolve(json(target()));
      });

    render(
      <MemoryRouter initialEntries={['/admin/targets/new']}>
        <Routes>
          <Route path="/admin/targets/new" element={<TargetDetailPage />} />
          <Route path="/admin/targets/:id" element={<TargetDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const threshold = await screen.findByLabelText('Accounts created');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '77');
    await userEvent.click(screen.getByRole('button', { name: /create target/i }));

    await screen.findByText(/The target was created, but its deprovisioning/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /create target/i }),
    ).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const posts = (
      fetchMock.mock.calls as [unknown, RequestInit | undefined][]
    ).filter(([, init]) => init?.method === 'POST');
    // One POST for the create; the connection test is the only other POST this
    // page makes and it was not pressed.
    expect(posts).toHaveLength(1);
    expect(patched).toBe(2);
  });

  it('never puts the stored bind password back in the form', async () => {
    // The API does not return it and this page must not invent a placeholder
    // that would be sent back as a new password on the next save.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));

    renderExisting();

    expect(await screen.findByDisplayValue('CN=svc,DC=acme,DC=test')).toBeVisible();
    expect(screen.getByLabelText(/bind password/i)).toHaveValue('');
  });

  it('shows the SCIM field group instead of the Active Directory fields when scim2 is selected', async () => {
    vi.spyOn(globalThis, 'fetch');
    renderNew();

    expect(await screen.findByLabelText(/^type$/i)).toBeVisible();
    expect(screen.getByLabelText(/bind dn/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), 'scim2');

    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/bind dn/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^url$/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/bearer token/i)).toBeInTheDocument();
  });

  it('submits a scim2 create with the scim2-shaped config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/api/admin/targets')) {
        return Promise.resolve(json({ id: 't1' }));
      }
      if (init?.method === 'PATCH') return Promise.resolve(json(null));
      return Promise.resolve(json(target({ type: 'scim2' })));
    });

    renderNew();

    await userEvent.type(await screen.findByLabelText(/^name$/i), 'Example SaaS');
    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), 'scim2');
    await userEvent.clear(screen.getByLabelText(/base url/i));
    await userEvent.type(
      screen.getByLabelText(/base url/i),
      'https://api.example.test/scim/v2',
    );
    await userEvent.type(screen.getByLabelText(/bearer token/i), 'a-token');
    await userEvent.click(screen.getByRole('button', { name: /create target/i }));

    await waitFor(() =>
      expect(
        (fetchMock.mock.calls as [unknown, RequestInit | undefined][]).some(
          ([input, init]) =>
            String(input).endsWith('/api/admin/targets') && init?.method === 'POST',
        ),
      ).toBe(true),
    );

    const create = (
      fetchMock.mock.calls as [unknown, RequestInit | undefined][]
    ).find(
      ([input, init]) =>
        String(input).endsWith('/api/admin/targets') && init?.method === 'POST',
    );
    expect(create).toBeDefined();
    const body = JSON.parse(String(create![1]!.body));
    expect(body.type).toBe('scim2');
    expect(body.config).toEqual({ baseUrl: 'https://api.example.test/scim/v2' });
    expect(body.bindPassword).toBe('a-token');
  });

  it('cannot change type once a target exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));

    renderExisting();

    expect(await screen.findByLabelText(/^type$/i)).toBeDisabled();
  });
});
