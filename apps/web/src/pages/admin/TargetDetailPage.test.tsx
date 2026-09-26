import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TargetDetailPage } from './TargetDetailPage.js';

const granted = new Set<string>();

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

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
        <Route path="/admin/targets/:id/runs" element={<p>Runs for this target</p>} />
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
  granted.clear();
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
      screen.queryByRole('link', { name: 'Review runs' }),
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
      screen.getByRole('link', { name: 'Review runs' }),
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
      await screen.findByText(/Target created; ladder and thresholds not saved/),
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

    await screen.findByText(/Target created; ladder and thresholds not saved/);
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

  it('offers the systems it ships a document for, rather than an empty box', async () => {
    // The design decision this whole form rests on. An administrator
    // connecting Entra ID picks Entra ID; they do not author a hundred lines
    // of JSON from a documentation page.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/connector-documents')) {
        return Promise.resolve(
          json({
            documents: [
              { key: 'entra-id', name: 'Microsoft Entra ID', document: { name: 'Microsoft Entra ID', version: 1 } },
            ],
          }),
        );
      }
      return Promise.resolve(json(target()));
    });
    renderNew();

    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'httpJson');
    expect(
      await screen.findByRole('button', { name: /microsoft entra id/i }),
    ).toBeInTheDocument();
  });

  it('keeps the document out of the way until it is asked for', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('/connector-documents')
          ? json({ documents: [] })
          : json(target()),
      ),
    );
    renderNew();

    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'httpJson');
    expect(screen.queryByLabelText(/connector document/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /edit the connector document/i }));
    expect(screen.getByLabelText(/connector document/i)).toBeInTheDocument();
  });

  it('submits an httpJson create carrying the picked document', async () => {
    const document = { name: 'Microsoft Entra ID', version: 1, baseUrl: 'https://graph' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/connector-documents')) {
        return Promise.resolve(
          json({ documents: [{ key: 'entra-id', name: 'Microsoft Entra ID', document }] }),
        );
      }
      if (init?.method === 'POST' && String(input).endsWith('/api/admin/targets')) {
        return Promise.resolve(json({ id: 't1' }));
      }
      if (init?.method === 'PATCH') return Promise.resolve(json(null));
      return Promise.resolve(json(target({ type: 'httpJson' })));
    });

    renderNew();

    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'httpJson');
    await userEvent.click(
      await screen.findByRole('button', { name: /microsoft entra id/i }),
    );
    await userEvent.type(screen.getByLabelText(/client secret/i), 'a-secret');
    await userEvent.click(screen.getByRole('button', { name: /create target/i }));

    await waitFor(() => {
      const create = (
        fetchMock.mock.calls as [unknown, RequestInit | undefined][]
      ).find(
        ([input, init]) =>
          String(input).endsWith('/api/admin/targets') && init?.method === 'POST',
      );
      expect(create).toBeDefined();
      const body = JSON.parse(String(create![1]!.body));
      expect(body.type).toBe('httpJson');
      // The document is COPIED into the target. Editing the shipped one later
      // must not change a target already built from it.
      expect(body.config).toEqual({ document });
      expect(body.bindPassword).toBe('a-secret');
    });
  });

  it('fills the Entra OAuth placeholders from dedicated non-secret fields', async () => {
    const document = {
      name: 'Microsoft Entra ID',
      version: 1,
      auth: {
        type: 'oauth2',
        tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
        clientId: '{clientId}',
      },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).includes('/connector-documents')) {
        return Promise.resolve(
          json({ documents: [{ key: 'entra-id', name: 'Microsoft Entra ID', document }] }),
        );
      }
      if (init?.method === 'POST' && String(input).endsWith('/api/admin/targets')) {
        return Promise.resolve(json({ id: 't1' }));
      }
      if (init?.method === 'PATCH') return Promise.resolve(json(null));
      return Promise.resolve(json(target({ type: 'httpJson' })));
    });

    renderNew();
    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'httpJson');
    await userEvent.click(await screen.findByRole('button', { name: /microsoft entra id/i }));
    await userEvent.type(screen.getByLabelText(/directory \(tenant\) id/i), 'tenant-1');
    await userEvent.type(screen.getByLabelText(/application \(client\) id/i), 'client-1');
    await userEvent.type(screen.getByLabelText(/application client secret/i), 'a-secret');
    await userEvent.click(screen.getByRole('button', { name: /create target/i }));

    await waitFor(() => {
      const create = (fetchMock.mock.calls as [unknown, RequestInit | undefined][]).find(
        ([input, init]) =>
          String(input).endsWith('/api/admin/targets') && init?.method === 'POST',
      );
      const body = JSON.parse(String(create![1]!.body));
      expect(body.config.document.auth).toMatchObject({
        tokenUrl: 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
        clientId: 'client-1',
      });
    });
  });

  it('offers Snipe-IT and fills its document, asking for an API key and the host', async () => {
    const document = {
      name: 'Snipe-IT',
      version: 1,
      baseUrl: 'https://{instance}/api/v1',
      auth: { type: 'bearer' },
      headers: { 'User-Agent': 'Syntra-Provisioning/1' },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('/connector-documents')
          ? json({
              documents: [
                { key: 'entra-id', name: 'Microsoft Entra ID', document: { name: 'Microsoft Entra ID', version: 1 } },
                { key: 'snipe-it', name: 'Snipe-IT', document },
              ],
            })
          : json(target()),
      ),
    );
    renderNew();

    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'httpJson');
    await userEvent.click(await screen.findByRole('button', { name: /^snipe-it$/i }));

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Snipe-IT');
    expect(screen.getByLabelText(/personal api key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/directory \(tenant\) id/i)).not.toBeInTheDocument();
    expect(screen.getByText(/with your snipe-it host/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /edit the connector document/i }));
    const editor = screen.getByLabelText(/connector document/i) as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual(document);
  });

  it('names the target after the system that was picked', async () => {
    const document = { name: 'Microsoft Entra ID', version: 1 };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('/connector-documents')
          ? json({ documents: [{ key: 'entra-id', name: 'Microsoft Entra ID', document }] })
          : json(target()),
      ),
    );
    renderNew();

    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'httpJson');
    await userEvent.click(
      await screen.findByRole('button', { name: /microsoft entra id/i }),
    );
    // One keystroke nobody has to spend typing what they just clicked.
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Microsoft Entra ID');
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

  it('shows the native Entra field group and submits its config shape', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/api/admin/targets')) {
        return Promise.resolve(json({ id: 't1' }));
      }
      if (init?.method === 'PATCH') return Promise.resolve(json(null));
      return Promise.resolve(json(target({ type: 'entraId' })));
    });
    renderNew();

    await userEvent.selectOptions(await screen.findByLabelText(/^type$/i), 'entraId');
    expect(screen.queryByLabelText(/bind dn/i)).not.toBeInTheDocument();
    expect(screen.getByText(/User\.ReadWrite\.All/)).toBeVisible();
    expect(screen.getByText(/Direct, in assigned security groups/)).toBeVisible();

    await userEvent.type(screen.getByLabelText(/^name$/i), 'Entra');
    await userEvent.type(screen.getByLabelText(/directory \(tenant\) id/i), 'contoso.onmicrosoft.com');
    await userEvent.type(screen.getByLabelText(/application \(client\) id/i), 'client-1');
    await userEvent.type(screen.getByLabelText(/application client secret/i), 'a-secret');
    await userEvent.selectOptions(screen.getByLabelText(/correlation field/i), 'extensionAttribute1');
    await userEvent.type(screen.getByLabelText(/user principal name domain/i), 'contoso.com');
    await userEvent.click(screen.getByRole('button', { name: /create target/i }));

    await waitFor(() => {
      const create = (fetchMock.mock.calls as [unknown, RequestInit | undefined][]).find(
        ([input, init]) =>
          String(input).endsWith('/api/admin/targets') && init?.method === 'POST',
      );
      const body = JSON.parse(String(create![1]!.body));
      expect(body.type).toBe('entraId');
      expect(body.bindPassword).toBe('a-secret');
      expect(body.config).toEqual({
        tenantId: 'contoso.onmicrosoft.com',
        clientId: 'client-1',
        correlationField: 'extensionAttribute1',
        userPrincipalDomain: 'contoso.com',
      });
    });
  });

  it('renders the Entra capability matrix and says which entries still need tenant evidence', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).endsWith('/capabilities')) {
        return Promise.resolve(
          json({
            type: 'entraId',
            metadata: {
              displayName: 'Microsoft Entra ID',
              adapterVersion: '1.0.0',
              connectorApiVersion: 1,
              supportState: 'preview',
              rollout: 'controlled',
              deprecationDate: null,
              certification: {
                contractVersion: 1,
                status: 'partial',
                verifiedAt: '2026-09-23',
                evidence: 'Shared fake-Graph contract passed; direct-group tenant evidence remains required',
              },
            },
            matrix: {
              version: 1,
              entries: {
                createAccount: {
                  status: 'available',
                  validation: 'automated+tenant-evidence-required',
                  requiredPermissions: ['User.ReadWrite.All'],
                  note: 'POST /users with the correlation marker.',
                },
                dynamicGroups: {
                  status: 'unsupported',
                  validation: 'automated',
                  requiredPermissions: [],
                  note: 'Refused before any request.',
                },
                deleteAccount: {
                  status: 'never',
                  validation: 'automated',
                  requiredPermissions: [],
                  note: 'No code path issues DELETE.',
                },
              },
            },
            capabilities: {
              available: true,
              readBack: true,
              createAccount: true,
              updateAccount: true,
              disableAccount: true,
              manageEntitlements: true,
            },
          }),
        );
      }
      return Promise.resolve(
        json(target({ type: 'entraId', config: { tenantId: 'contoso.onmicrosoft.com', clientId: 'c' } })),
      );
    });
    renderExisting();

    expect(await screen.findByText('createAccount')).toBeVisible();
    expect(screen.getByText('Microsoft Entra ID v1.0.0')).toBeVisible();
    expect(screen.getByText('controlled')).toBeVisible();
    expect(screen.getByText(/direct-group tenant evidence remains required/)).toBeVisible();
    expect(screen.getByText('tenant evidence required')).toBeVisible();
    expect(screen.getByText(/1 of these are verified against the fake Graph only/)).toBeVisible();
    expect(screen.getByText('not supported')).toBeVisible();
    expect(screen.getByText('never')).toBeVisible();
    // Three statuses, three tones: an administrator must not read "never"
    // in the same colour as "available".
    const tone = (text: string) => screen.getByText(text).className;
    expect(new Set([tone('available'), tone('not supported'), tone('never')]).size).toBe(3);
  });

  describe('the configuration panel', () => {
    const problem404 = () =>
      new Response(JSON.stringify({ title: 'Not found', status: 404 }), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }) as never;

    it('warns when there is no account profile and no rule grants an account', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.endsWith('/api/admin/targets/t1/profile')) return Promise.resolve(problem404());
        if (url.endsWith('/api/admin/targets/t1/rules')) {
          // A rule that grants only entitlements, and a disabled one that
          // would grant an account: neither provisions anybody.
          return Promise.resolve(
            json({
              rules: [
                { id: 'r1', enabled: true, grantsAccount: false },
                { id: 'r2', enabled: false, grantsAccount: true },
              ],
            }),
          );
        }
        return Promise.resolve(json(target()));
      });
      renderExisting();

      expect(
        await screen.findByText('No account profile: accounts cannot be created.'),
      ).toBeVisible();
      expect(
        screen.getByText('No rule grants an account: nobody is provisioned.'),
      ).toBeVisible();
    });

    it('sits directly below the connection panel', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(json(target())));
      renderExisting();
      await screen.findByDisplayValue('Samba AD');

      const titles = screen
        .getAllByRole('heading')
        .map((heading) => heading.textContent ?? '');
      const connection = titles.indexOf('Connection');
      expect(connection).toBeGreaterThanOrEqual(0);
      expect(titles[connection + 1]).toBe('Configuration');
    });

    it('says nothing when a profile exists and an enabled rule grants an account', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.endsWith('/api/admin/targets/t1/profile')) {
          return Promise.resolve(json({ correlationKeyTemplate: '%person.givenName%' }));
        }
        if (url.endsWith('/api/admin/targets/t1/rules')) {
          return Promise.resolve(json({ rules: [{ id: 'r1', enabled: true, grantsAccount: true }] }));
        }
        return Promise.resolve(json(target()));
      });
      renderExisting();

      expect(await screen.findByDisplayValue('Samba AD')).toBeVisible();
      await waitFor(() => expect(screen.getByRole('link', { name: 'Account profile' })).toBeVisible());
      expect(screen.queryByText(/No account profile/)).toBeNull();
      expect(screen.queryByText(/No rule grants an account/)).toBeNull();
    });
  });

  it('cannot change type once a target exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));

    renderExisting();

    expect(await screen.findByLabelText(/^type$/i)).toBeDisabled();
  });

  it('labels a connection test out of date the moment the connection it tested changes', async () => {
    // "Previews can describe a previous draft." The rights below were read
    // with ONE bind account; a report that went on looking current after the
    // bind DN was retyped would be answering for an account nobody entered.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({
        ok: true,
        message: 'Bound',
        rights: [{ right: 'createUser', status: 'granted', detail: '' }],
      }),
    );
    renderNew();

    await userEvent.type(await screen.findByLabelText(/bind dn/i), 'CN=svc');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(await screen.findByText('Connected')).toBeVisible();
    expect(screen.queryByText(/out of date/i)).toBeNull();

    // A threshold is not part of what was tested, so it does not stale it.
    await userEvent.type(screen.getByLabelText('Accounts created'), '5');
    expect(screen.queryByText(/out of date/i)).toBeNull();

    await userEvent.type(screen.getByLabelText(/bind dn/i), ',DC=acme');
    // On the report, on its stage, and beside Save.
    expect(screen.getAllByText('Out of date — run again').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Test result is out of date')).toBeVisible();
    // Still shown, never quietly current: the result stays readable and says
    // what it is.
    expect(screen.getByText('granted')).toBeVisible();

    // Putting the draft back to what was tested makes it current again.
    await userEvent.type(screen.getByLabelText(/bind dn/i), '{Backspace>8}');
    expect(screen.queryByText('Test result is out of date')).toBeNull();
  });

  it('says there are unsaved changes beside Save, and only while there are', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await userEvent.type(screen.getByLabelText('Accounts created'), '5');
    expect(screen.getByText('Unsaved changes')).toBeVisible();
  });

  it('gathers every refused field at the top of the form, each a link to its control', async () => {
    // The editor is four screens long. A refusal three screens up used to
    // leave the reader looking at an unchanged button.
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              title: 'Validation failed',
              status: 400,
              errors: [
                { path: 'config.bindDn', message: 'is required' },
                { path: 'thresholds.createAccountThresholdPercent', message: 'must be between 0 and 100' },
              ],
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ) as never,
        );
      }
      return Promise.resolve(json(target()));
    });
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const summary = (await screen.findByText('Fix these before saving')).closest('[role="alert"]');
    // The summary takes focus, so a keyboard or screen-reader user lands on it.
    expect(summary).toHaveFocus();
    // Named as the controls are named, not as the API's paths.
    await userEvent.click(
      screen.getByRole('button', { name: 'Accounts created: must be between 0 and 100' }),
    );
    expect(screen.getByLabelText('Accounts created')).toHaveFocus();
    expect(screen.getByLabelText('Accounts created')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Bind DN: is required' })).toBeVisible();
    // And each stage says how many of its fields need fixing.
    expect(screen.getAllByText('1 to fix')).toHaveLength(2);
  });

  it('does not offer an example cron expression as though it were the saved schedule', async () => {
    // The report this answers: an empty box showing `0 3 * * *` was read as
    // a target scheduled nightly, and the overview then said "By hand only".
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    // The zone is the scheduler's, not the browser's: pg-boss's default.
    const schedule = screen.getByLabelText('Schedule (cron, UTC)');
    expect(schedule).toHaveValue('');
    expect(schedule).toHaveAttribute('placeholder', 'Blank — runs only when started by hand');
  });

  it('warns that automatic apply does nothing while there is no schedule, and only then', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target({ autoApply: true })));
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    const warning = /No schedule, so no scheduled run will happen/;
    expect(screen.getByText(warning)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Apply scheduled runs automatically/ })).toHaveAccessibleDescription(warning);

    await userEvent.type(screen.getByLabelText('Schedule (cron, UTC)'), '0 3 * * *');
    expect(screen.queryByText(warning)).toBeNull();
  });

  it('starts a run from the target and goes to its runs', async () => {
    granted.add('provision.manage');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/runs') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ jobId: 'j1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }) as never,
        );
      }
      return Promise.resolve(json(target()));
    });
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(await screen.findByText('Runs for this target')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/targets/t1/runs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('says why a run could not be started, and stays on the target', async () => {
    granted.add('provision.manage');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/runs') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 503,
              title: 'Background jobs are not running',
              detail: 'the run could not be enqueued; the API is up but the job scheduler is not',
            }),
            { status: 503, headers: { 'content-type': 'application/problem+json' } },
          ) as never,
        );
      }
      return Promise.resolve(json(target()));
    });
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    expect(await screen.findByText(/the job scheduler is not/)).toBeVisible();
    expect(screen.queryByText('Runs for this target')).toBeNull();
  });

  it('holds Run now on a disabled target and says why', async () => {
    // The worker drops a disabled target's job without recording a run, so
    // an enabled button here would appear to do nothing at all.
    granted.add('provision.manage');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target({ enabled: false })));
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    const button = screen.getByRole('button', { name: 'Run now' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Target is disabled');
  });

  it('offers Run now only to somebody the API would let start one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(target()));
    renderExisting();

    await screen.findByDisplayValue('Samba AD');
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('has nothing to run before the target exists', () => {
    granted.add('provision.manage');
    vi.spyOn(globalThis, 'fetch');
    renderNew();

    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });
});

describe('TargetDetailPage: Apply renames automatically', () => {
  /** The target, and the adapter report the checkbox reads rename support from. */
  const mockTarget = (overrides: Record<string, unknown>, renameRefusal: string | null = null) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'PATCH') return Promise.resolve(new Response(null, { status: 204 }) as never);
      if (String(input).endsWith('/api/admin/targets/t1/adapter')) {
        return Promise.resolve(
          json({
            type: overrides.type,
            selection: { channel: 'stable', pinnedVersion: null, rollbackVersion: null, changedAt: null, reason: null },
            effective: null,
            resolutionError: null,
            releases: [],
            writesBlockedReason: null,
            deprecationOverride: null,
            capabilities: [
              { capability: 'update_account', certified: true, refusal: null },
              { capability: 'rename_account', certified: renameRefusal === null, refusal: renameRefusal },
            ],
            warnings: [],
          }),
        );
      }
      return Promise.resolve(json(target(overrides)));
    });

  it('is off by default and warns on Active Directory', async () => {
    mockTarget({ type: 'activeDirectory' });
    renderExisting();
    const box = await screen.findByRole('checkbox', { name: /apply renames automatically/i });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
    const section = screen.getByTestId('auto-confirm-renames');
    expect(section).toHaveTextContent(/sAMAccountName: breaks cached logons and profile paths/);
  });

  it('gives an Entra target no Active Directory warning', async () => {
    mockTarget({ type: 'entraId', config: { tenantId: 'x', clientId: 'y' } });
    renderExisting();
    await screen.findByDisplayValue('Samba AD');
    await waitFor(() =>
      expect(screen.getByTestId('auto-confirm-renames')).not.toHaveTextContent(/sAMAccountName/),
    );
  });

  it('saves the setting with the rest of the target', async () => {
    const fetchMock = mockTarget({ type: 'activeDirectory' });
    renderExisting();
    await userEvent.click(await screen.findByRole('checkbox', { name: /apply renames automatically/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({ autoConfirmRenames: true });
  });

  it('is disabled, with the reason, when the adapter cannot rename accounts', async () => {
    mockTarget({ type: 'httpJson', autoConfirmRenames: false }, "refused: this target's configuration does not advertise the ability to rename accounts");
    renderExisting();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /apply renames automatically/i })).toBeDisabled(),
    );
    expect(screen.getByTestId('auto-confirm-renames')).toHaveTextContent(/cannot rename accounts/i);
  });
});

describe('TargetDetailPage: Mirror org units as OUs', () => {
  const PREVIEW = {
    mirrorOrgUnits: false,
    placesAccountsInContainers: true,
    baseDn: 'DC=ssander,DC=local',
    rootDn: 'OU=Syntra,DC=ssander,DC=local',
    rootProblem: null,
    units: [
      {
        id: 'u-it', name: 'IT', parentId: 'u-local', status: 'active', depth: 1,
        derivedDn: 'OU=IT,OU=ssander.local,OU=Syntra,DC=ssander,DC=local', row: null,
        effectiveDn: null, placement: 'unplaced', problem: null, note: null,
      },
      {
        id: 'u-local', name: 'ssander.local', parentId: null, status: 'active', depth: 0,
        derivedDn: 'OU=ssander.local,OU=Syntra,DC=ssander,DC=local', row: null,
        effectiveDn: null, placement: 'unplaced', problem: null, note: null,
      },
    ],
  };

  const mockTarget = (overrides: Record<string, unknown>) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'PATCH') return Promise.resolve(new Response(null, { status: 204 }) as never);
      if (String(input).includes('/org-unit-mirror')) return Promise.resolve(json(PREVIEW));
      return Promise.resolve(json(target(overrides)));
    });

  it('previews the tree -> DN mapping, parent first', async () => {
    mockTarget({ type: 'activeDirectory', placesAccountsInContainers: true });
    renderExisting();
    const box = await screen.findByRole('checkbox', { name: /mirror org units as ous/i });
    expect(box).not.toBeChecked();
    const preview = await screen.findByTestId('org-unit-mirror-preview');
    const rows = within(preview).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['mirror-unit-u-local', 'mirror-unit-u-it']);
    expect(rows[1]).toHaveTextContent('OU=IT,OU=ssander.local,OU=Syntra,DC=ssander,DC=local');
  });

  it('saves the setting and the root with the rest of the target', async () => {
    const fetchMock = mockTarget({ type: 'activeDirectory', placesAccountsInContainers: true });
    renderExisting();
    await userEvent.click(await screen.findByRole('checkbox', { name: /mirror org units as ous/i }));
    await userEvent.type(screen.getByLabelText(/org-unit root/i), 'OU=Syntra,DC=ssander,DC=local');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({
      mirrorOrgUnits: true,
      orgUnitRootDn: 'OU=Syntra,DC=ssander,DC=local',
    });
  });

  it('is not offered on a target that places no accounts in containers, and says why', async () => {
    const fetchMock = mockTarget({ type: 'activeDirectory', placesAccountsInContainers: false });
    renderExisting();
    expect(await screen.findByTestId('mirror-unsupported')).toHaveTextContent(/does not place accounts in containers/);
    expect(screen.queryByRole('checkbox', { name: /mirror org units as ous/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).not.toHaveProperty('mirrorOrgUnits');
  });
});

describe('TargetDetailPage: units that still use a DN typed by hand', () => {
  // The live case: every unit was materialised by hand, mirroring was turned
  // on, and nothing moved -- a typed DN always wins -- with no hint why.
  const ROOT = 'OU=Syntra,DC=ssander,DC=local';
  const manualUnit = (id: string, name: string, parentId: string | null, depth: number, typed: string, derived: string) => ({
    id, name, parentId, status: 'active', depth,
    derivedDn: derived,
    row: { dn: typed, source: 'manual', state: 'live', previousDn: null },
    effectiveDn: typed, placement: 'manual', problem: null,
    note: `materialised by hand; mirroring would place it at ${derived}`,
  });
  const HAND_TYPED = [
    manualUnit('u-local', 'ssander.local', null, 0, `OU=ssander.local,${ROOT}`, `OU=ssander.local,${ROOT}`),
    manualUnit('u-it', 'IT', 'u-local', 1, `OU=IT,${ROOT}`, `OU=IT,OU=ssander.local,${ROOT}`),
  ];
  const preview = (mirrorOrgUnits: boolean, units: unknown[]) => ({
    mirrorOrgUnits, placesAccountsInContainers: true, baseDn: 'DC=ssander,DC=local', rootDn: ROOT, rootProblem: null, units,
  });
  const mirroredAfterSwitch = HAND_TYPED.map((unit) => ({
    ...unit, row: { ...unit.row, source: 'mirrored', dn: unit.derivedDn }, effectiveDn: unit.derivedDn, placement: 'mirrored', note: null,
  }));

  /** A target whose preview lists the hand-typed units until a switch lands. */
  function mockMirroring({ mirrorOrgUnits = true }: { mirrorOrgUnits?: boolean } = {}) {
    let switched = false;
    return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/org-units/switch-to-mirrored') && init?.method === 'POST') {
        switched = true;
        return Promise.resolve(json({
          targetSystemId: 't1',
          switched: [
            { orgUnitId: 'u-local', unitName: 'ssander.local', from: `OU=ssander.local,${ROOT}`, dn: `OU=ssander.local,${ROOT}`, pendingMoveFrom: null },
            { orgUnitId: 'u-it', unitName: 'IT', from: `OU=IT,${ROOT}`, dn: `OU=IT,OU=ssander.local,${ROOT}`, pendingMoveFrom: `OU=IT,${ROOT}` },
          ],
          skipped: [],
        }));
      }
      if (url.includes('/containers/t1/switch-to-mirrored') && init?.method === 'POST') {
        switched = true;
        return Promise.resolve(json({ targetSystemId: 't1', dn: `OU=IT,OU=ssander.local,${ROOT}`, pendingMoveFrom: `OU=IT,${ROOT}` }));
      }
      if (url.includes('/org-unit-mirror')) {
        return Promise.resolve(json(preview(mirrorOrgUnits, switched ? mirroredAfterSwitch : HAND_TYPED)));
      }
      return Promise.resolve(
        json(target({ type: 'activeDirectory', placesAccountsInContainers: true, mirrorOrgUnits, orgUnitRootDn: ROOT })),
      );
    });
  }

  it('warns that typed DNs win, listing each unit with its typed and mirrored DN', async () => {
    mockMirroring();
    renderExisting();
    const warning = await screen.findByTestId('hand-typed-warning');
    expect(screen.getByText('Mirroring is on, but 2 org units use a DN typed by hand')).toBeInTheDocument();
    expect(warning).toHaveTextContent(/A typed DN always wins over the mirror/);
    expect(warning).toHaveTextContent(/Switching writes nothing to the directory/);
    expect(warning).toHaveTextContent(/a container move always holds the run for a person to confirm/);
    const itRow = screen.getByTestId('hand-typed-u-it');
    expect(itRow).toHaveTextContent(`Typed: OU=IT,${ROOT}`);
    expect(itRow).toHaveTextContent(`Mirrored: OU=IT,OU=ssander.local,${ROOT}`);
    // Parents first, as they will be switched.
    const items = within(warning).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'));
    expect(items).toEqual(['hand-typed-u-local', 'hand-typed-u-it']);
  });

  it('shows no warning while mirroring is off', async () => {
    mockMirroring({ mirrorOrgUnits: false });
    renderExisting();
    await screen.findByTestId('org-unit-mirror-preview');
    expect(screen.queryByTestId('hand-typed-warning')).toBeNull();
  });

  it('switches them all, says nothing moves until a run is confirmed, and re-reads the tree', async () => {
    const fetchMock = mockMirroring();
    renderExisting();
    await userEvent.click(await screen.findByRole('button', { name: 'Switch all to mirrored' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/admin/targets/t1/org-units/switch-to-mirrored' && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    // The press did not submit the target form around it.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(await screen.findByText('Switched 2 org units to mirrored')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing has moved in the directory yet\. The next run proposes moving 1 OU/),
    ).toHaveTextContent(/holds for a person to confirm before anything moves/);
    await waitFor(() => expect(screen.queryByTestId('hand-typed-warning')).toBeNull());
  });

  it('switches one unit from its own button', async () => {
    const fetchMock = mockMirroring();
    renderExisting();
    await userEvent.click(await screen.findByRole('button', { name: 'Switch IT' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/admin/org-units/u-it/containers/t1/switch-to-mirrored' && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Switched 1 org unit to mirrored')).toBeInTheDocument();
  });

  it('asks for the settings to be saved first while the root in the box is unsaved', async () => {
    mockMirroring();
    renderExisting();
    await screen.findByTestId('hand-typed-warning');
    await userEvent.type(screen.getByLabelText(/org-unit root/i), 'X');
    expect(screen.getByRole('button', { name: 'Switch all to mirrored' })).toBeDisabled();
    expect(screen.getByText(/Save the org-unit settings first/)).toBeInTheDocument();
  });

  it('leads with the mirroring checkbox', async () => {
    mockMirroring();
    renderExisting();
    const section = await screen.findByTestId('mirror-org-units');
    const box = within(section).getByRole('checkbox', { name: /mirror org units as ous/i });
    const root = within(section).getByLabelText(/org-unit root/i);
    // The checkbox precedes everything else in the section.
    expect(box.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
