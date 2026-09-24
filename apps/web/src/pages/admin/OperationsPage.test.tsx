import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OperationsPage, type JobHealthBody, type TenantStatusBody } from './OperationsPage.js';

const granted = new Set<string>();
vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) => granted.has(permission),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const status: TenantStatusBody = {
  overall: 'degraded',
  generatedAt: '2026-09-23T12:00:00.000Z',
  components: [
    { name: 'api', state: 'operational', detail: 'The API is answering.' },
    { name: 'key_provider', state: 'unavailable', detail: 'The key provider is not answering.' },
  ],
  degradation: {
    writeStop: { active: true, since: '2026-09-23T11:00:00.000Z', expiresAt: null },
    targetWriteStops: [],
    staleReadiness: [{ targetId: 't-1', name: 'Contoso AD', reason: 'never_tested', checkedAt: null }],
    connectorOutages: [{ systemKind: 'target', id: 't-2', name: 'Fabrikam SCIM', since: '2026-09-23T10:00:00.000Z', errorClass: 'unauthorized' }],
    queueReadable: true,
  },
};

const orphan = {
  id: 'sync_run:r-1:orphaned',
  finding: 'orphaned' as const,
  kind: 'sync_run',
  subjectId: '0d4d7a7e-3a0f-4bb7-9a32-0b9b2c1b1e11',
  status: 'queued',
  since: '2026-09-23T11:00:00.000Z',
  detail: 'This directory sync run is queued but no job exists to start it.',
  repairs: ['requeue' as const, 'mark_failed' as const],
};

function mockApi(health: JobHealthBody[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let reads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/api/admin/status')) return Promise.resolve(json(status));
    if (url.endsWith('/api/admin/job-health/repair')) {
      return Promise.resolve(json({ repair: { outcome: 'repaired', detail: 'A job was queued for this work.' } }));
    }
    if (url.endsWith('/api/admin/job-health')) {
      const body = health[Math.min(reads, health.length - 1)]!;
      reads += 1;
      return Promise.resolve(json(body));
    }
    if (url.endsWith('/api/admin/exports')) return Promise.resolve(json({ export: { id: 'x-1' } }, 202));
    return Promise.resolve(json({}, 404));
  });
  return calls;
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <OperationsPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  granted.clear();
});

describe('OperationsPage', () => {
  it("shows shared components apart from this tenant's own degradation", async () => {
    granted.add('audit.read');
    mockApi([{ queueReadable: true, findings: [] }]);
    renderPage();
    expect(await screen.findByText('Shared components')).toBeInTheDocument();
    expect(screen.getByText('Key provider')).toBeInTheDocument();
    expect(screen.getByText(/External writes are stopped for every target/)).toBeInTheDocument();
    expect(screen.getByText(/Fabrikam SCIM: unauthorized/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contoso AD' })).toHaveAttribute('href', '/admin/targets/t-1');
    expect(await screen.findByText('Nothing stuck')).toBeInTheDocument();
    // No support bundle without tenant.manage.
    expect(screen.queryByText('Generate support bundle')).not.toBeInTheDocument();
  });

  it('offers repairs only to tenant.manage, asks for a reason, and announces the result', async () => {
    granted.add('audit.read');
    mockApi([{ queueReadable: true, findings: [orphan] }]);
    const { unmount } = renderPage();
    expect(await screen.findByText('Orphaned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Requeue' })).not.toBeInTheDocument();
    unmount();
    vi.restoreAllMocks();

    granted.add('tenant.manage');
    const calls = mockApi([{ queueReadable: true, findings: [orphan] }, { queueReadable: true, findings: [] }]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Requeue' }));
    const confirm = screen.getAllByRole('button', { name: 'Requeue' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'worker lost in node drain');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/job-health/repair'))).toBe(true));
    const repair = calls.find((c) => c.url.endsWith('/job-health/repair'))!;
    expect(repair).toMatchObject({ method: 'POST', body: { kind: 'sync_run', subjectId: orphan.subjectId, action: 'requeue', reason: 'worker lost in node drain' } });
    expect(await screen.findAllByText(/Requeue: A job was queued for this work./)).not.toHaveLength(0);
  });

  it('requests a support bundle for the chosen window through the export service', async () => {
    granted.add('audit.read');
    granted.add('tenant.manage');
    const calls = mockApi([{ queueReadable: true, findings: [] }]);
    renderPage();
    const panel = (await screen.findByText('Generate support bundle')).closest('section')!;
    await userEvent.selectOptions(within(panel).getByLabelText('Covering'), '7');
    await userEvent.click(within(panel).getByRole('button', { name: 'Generate support bundle' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/admin/exports'))).toBe(true));
    const request = calls.find((c) => c.url.endsWith('/api/admin/exports'))!;
    const body = request.body as { kind: string; params: { from: string } };
    expect(body.kind).toBe('support_bundle');
    const days = (Date.now() - Date.parse(body.params.from)) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7.01);
    expect(await within(panel).findByText(/download it from Activity → Exports/)).toBeInTheDocument();
  });
});
