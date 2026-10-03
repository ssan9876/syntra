import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage, ago, describeAction } from './DashboardPage.js';

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

const RECENT = new Date(Date.now() - 5 * 60_000).toISOString();

const BODIES: Record<string, unknown> = {
  '/api/admin/status': {
    overall: 'operational',
    generatedAt: RECENT,
    components: [],
    degradation: {
      writeStop: { active: false, since: null, expiresAt: null },
      targetWriteStops: [],
      staleReadiness: [{ targetId: 't1', name: 'Local AD', reason: 'failing', checkedAt: null }],
      connectorOutages: [],
      queueReadable: true,
    },
  },
  '/api/admin/job-health': { queueReadable: true, findings: [] },
  '/api/admin/directory/summary': {
    people: { total: 12, active: 10, withoutAccount: 1 },
    accounts: { total: 9, active: 8, locked: 2 },
  },
  '/api/admin/users/unlinked': { accounts: [] },
  '/api/admin/employee-work': { lanes: { action: 3, waiting: 1, blocked: 0, overdue: 0 } },
  '/api/admin/targets': {
    targets: [
      { id: 't1', name: 'Local AD', type: 'activeDirectory', enabled: true, schedule: '*/15 * * * *', lastRunAt: RECENT, consecutiveSkippedRuns: 0 },
      { id: 't2', name: 'Snipe-IT', type: 'httpJson', enabled: true, schedule: null, lastRunAt: null, consecutiveSkippedRuns: 0 },
    ],
  },
  '/api/admin/sources': { sources: [] },
  '/api/admin/applications': { applications: [{}, {}] },
  '/api/admin/audit': {
    events: [
      { id: 'e1', occurredAt: RECENT, actorUserId: 'u1', action: 'person.unlinkUser', outcome: 'success' },
    ],
  },
  '/api/admin/users': { users: [{ id: 'u1', displayName: 'Jo Admin' }] },
};

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]!;
    return Promise.resolve(json(BODIES[path] ?? {}));
  }) as typeof fetch);
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('the overview', () => {
  it('lists what needs a person, each linking to where it is done', async () => {
    for (const p of ['audit.read', 'directory.read', 'identity.read', 'provision.read', 'sync.read', 'access.read']) {
      granted.add(p);
    }
    mockApi();
    renderPage();

    const work = await screen.findByRole('link', { name: /Employee work to act on/ });
    expect(work).toHaveAttribute('href', '/admin/employee-work?lane=action');
    expect(within(work).getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Accounts locked out/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Retest Local AD/ })).toHaveAttribute('href', '/admin/targets/t1');
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('shows the connected systems with their state, and the latest activity by name', async () => {
    for (const p of ['audit.read', 'directory.read', 'provision.read']) granted.add(p);
    mockApi();
    renderPage();

    expect(await screen.findByText('Never run')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Local AD Target/ })).toHaveAttribute('href', '/admin/targets/t1');
    expect(await screen.findByText('Person unlink user')).toBeInTheDocument();
    expect(await screen.findByText('Jo Admin')).toBeInTheDocument();
  });

  it('asks for nothing the reader may not see', async () => {
    granted.add('access.read');
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByText('Applications');
    const asked = fetchSpy.mock.calls.map(([input]) => String(input));
    expect(asked).toEqual(['/api/admin/applications']);
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
  });
});

describe('the sign-in security checklist', () => {
  const FAILING = {
    adminsWithoutSecondFactor: [
      { userId: 'u-m', login: 'mpuleo', displayName: 'M Puleo', owner: true },
      { userId: 'u-r', login: 'rsander', displayName: 'R Sander', owner: true },
      { userId: 'u-a', login: 'agray', displayName: 'A Gray', owner: true },
    ],
    adminMfaRequired: false,
    lockoutEnabled: false,
    breakGlassDesignated: false,
  };

  it('lists each failing check with where it is fixed', async () => {
    granted.add('tenant.manage');
    BODIES['/api/admin/tenant/sign-in-security'] = FAILING;
    mockApi();
    renderPage();

    const section = (await screen.findByRole('heading', { name: 'Sign-in security' })).closest('section')!;
    const items = within(section).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('3 Owners have no second factor: mpuleo, rsander, agray.');
    expect(within(items[0]!).getByRole('link', { name: 'mpuleo' })).toHaveAttribute('href', '/admin/users/u-m');
    expect(items[1]).toHaveTextContent('The console does not require a second factor.');
    expect(within(items[1]!).getByRole('link', { name: 'Sign-in settings' })).toHaveAttribute('href', '/admin/settings?tab=sign-in');
    expect(items[2]).toHaveTextContent('Account lockout is off.');
    expect(items[3]).toHaveTextContent('No break-glass account designated.');
    expect(within(items[3]!).getByRole('link', { name: 'Break-glass settings' })).toHaveAttribute('href', '/admin/settings?tab=break-glass');
  });

  it('shows only the checks that fail', async () => {
    granted.add('tenant.manage');
    BODIES['/api/admin/tenant/sign-in-security'] = {
      ...FAILING,
      adminsWithoutSecondFactor: [],
      adminMfaRequired: true,
      breakGlassDesignated: true,
    };
    mockApi();
    renderPage();

    const section = (await screen.findByRole('heading', { name: 'Sign-in security' })).closest('section')!;
    expect(within(section).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Account lockout is off.Sign-in settings',
    ]);
  });

  it('shows nothing when every check passes', async () => {
    granted.add('tenant.manage');
    granted.add('access.read');
    BODIES['/api/admin/tenant/sign-in-security'] = {
      adminsWithoutSecondFactor: [],
      adminMfaRequired: true,
      lockoutEnabled: true,
      breakGlassDesignated: true,
    };
    const fetchSpy = mockApi();
    renderPage();

    await screen.findByText('Applications');
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.map(([input]) => String(input))).toContain('/api/admin/tenant/sign-in-security'),
    );
    expect(screen.queryByRole('heading', { name: 'Sign-in security' })).not.toBeInTheDocument();
  });
});

describe('the overview helpers', () => {
  it('reads an audit action as a phrase', () => {
    expect(describeAction('user.kindChanged')).toBe('User kind changed');
    expect(describeAction('access.saml_configured')).toBe('Access saml configured');
  });

  it('reads an age rather than a timestamp', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(ago('2026-09-26T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-09-26T11:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-09-26T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-09-22T12:00:00Z', now)).toBe('4 days ago');
  });
});
