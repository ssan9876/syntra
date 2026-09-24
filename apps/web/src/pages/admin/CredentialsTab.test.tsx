import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CredentialsTab, ExpiryBadge, type CredentialItem } from './CredentialsTab.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SOURCE_ID = '0b1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const item = (over: Partial<CredentialItem> = {}): CredentialItem => ({
  key: `person_source_secret.${SOURCE_ID}`,
  kind: 'person_source_secret',
  label: 'SFTP password or private key',
  subject: { type: 'PersonSource', id: SOURCE_ID, name: 'HR nightly', href: `/admin/person-sources/${SOURCE_ID}` },
  expiresAt: null,
  expirySource: 'unknown',
  lastRotatedAt: '2026-06-01T00:00:00.000Z',
  ownerUserId: null,
  ownerName: null,
  note: null,
  declaredExpiresAt: null,
  discovery: null,
  status: 'unknown',
  daysRemaining: null,
  rotation: { systemKind: 'person_source', systemId: SOURCE_ID },
  openRotation: null,
  ...over,
});

const rotation = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'r1',
  systemKind: 'person_source',
  systemId: SOURCE_ID,
  status,
  reason: null,
  newExpiresAt: null,
  stagedAt: '2026-09-23T12:00:00.000Z',
  verifiedAt: null,
  verificationOk: null,
  verificationMessage: null,
  cutOverAt: null,
  completedAt: null,
  overlapActive: status === 'cut_over',
  evidence: [{ step: 'staged', at: '2026-09-23T12:00:00.000Z' }],
  ...over,
});

const renderTab = () =>
  render(
    <MemoryRouter>
      <CredentialsTab />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('ExpiryBadge', () => {
  it('names each state the inventory can be in', () => {
    const { rerender } = render(<ExpiryBadge item={{ status: 'expired', daysRemaining: -2 }} />);
    expect(screen.getByText('Expired')).toBeVisible();
    rerender(<ExpiryBadge item={{ status: 'expiring', daysRemaining: 1 }} />);
    expect(screen.getByText('1 day left')).toBeVisible();
    rerender(<ExpiryBadge item={{ status: 'expiring', daysRemaining: 0 }} />);
    expect(screen.getByText('Expires today')).toBeVisible();
    rerender(<ExpiryBadge item={{ status: 'no_expiry', daysRemaining: null }} />);
    expect(screen.getByText('No expiry')).toBeVisible();
    rerender(<ExpiryBadge item={{ status: 'unknown', daysRemaining: null }} />);
    expect(screen.getByText('Expiry unknown')).toBeVisible();
  });
});

describe('CredentialsTab', () => {
  it('lists credentials with expiry badges, the source of the expiry, and a summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        alertDays: [30, 14, 7, 1],
        items: [
          item({
            key: `api_token.${SOURCE_ID}`,
            kind: 'api_token',
            label: 'API token "SCIM from Workday"',
            status: 'expiring',
            daysRemaining: 6,
            expiresAt: '2026-09-29T12:00:00.000Z',
            expirySource: 'issued',
            rotation: null,
            ownerName: 'Admin',
          }),
          item(),
        ],
      }),
    );
    renderTab();
    expect(await screen.findByText('API token "SCIM from Workday"')).toBeVisible();
    expect(screen.getByText('6 days left')).toBeVisible();
    expect(screen.getByText('Expiry unknown')).toBeVisible();
    expect(screen.getByText(/1 expiring within 30 days/)).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'HR nightly' })[0]).toHaveAttribute('href', `/admin/person-sources/${SOURCE_ID}`);
    expect(screen.getByText('Unassigned')).toBeVisible();
    // Only a connector secret offers the rotation workflow.
    expect(screen.getAllByRole('button', { name: 'Rotate' })).toHaveLength(1);
  });

  it('stages a new secret without echoing it, then offers the test', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ alertDays: [30], items: [item()] }))
      .mockResolvedValueOnce(json(rotation('staged'), 201))
      .mockResolvedValueOnce(json({ alertDays: [30], items: [item({ openRotation: rotation('staged') })] }));
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    const stage = screen.getByRole('button', { name: 'Stage new secret' });
    expect(stage).toBeDisabled();
    await userEvent.type(screen.getByLabelText('New secret'), 'n3w-s3cret');
    expect(screen.getByText(/Keep the current secret valid at the issuer/)).toBeVisible();
    await userEvent.click(stage);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(String(fetch.mock.calls[1]![0])).toBe('/api/admin/credentials/rotations');
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toMatchObject({
      systemKind: 'person_source',
      systemId: SOURCE_ID,
      secret: 'n3w-s3cret',
      newExpiresAt: null,
    });
    expect(await screen.findByText('New secret staged. Test it before cutting over.')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Test staged secret' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel rotation' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cut over' })).toBeNull();
  });

  it('offers cut-over only after a passed test, then complete or roll back', async () => {
    const verified = rotation('verified', {
      verificationOk: true,
      verificationMessage: 'connected; the file is readable',
      evidence: [
        { step: 'staged', at: '2026-09-23T12:00:00.000Z' },
        { step: 'verified', at: '2026-09-23T12:01:00.000Z', ok: true },
      ],
    });
    const cut = rotation('cut_over', { verificationOk: true });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ alertDays: [30], items: [item({ openRotation: verified })] }))
      .mockResolvedValueOnce(json(cut))
      .mockResolvedValueOnce(json({ alertDays: [30], items: [item({ openRotation: cut })] }));
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    expect(screen.getByText('Connection test: passed', { exact: false })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cut over' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(String(fetch.mock.calls[1]![0])).toBe('/api/admin/credentials/rotations/r1/cutover');
    expect(await screen.findByRole('button', { name: 'Complete and erase old secret' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeVisible();
  });

  it('shows the server refusal of a step', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ alertDays: [30], items: [item({ openRotation: rotation('cut_over') })] }))
      .mockResolvedValueOnce(
        json(
          {
            type: 'https://syntra.dev/problems/rotation-check-failed',
            title: 'Rotation refused',
            status: 422,
            detail: 'the live secret failed its check, so the previous one was kept for rollback: authentication refused',
          },
          422,
        ),
      )
      .mockResolvedValue(json({ alertDays: [30], items: [item({ openRotation: rotation('cut_over') })] }));
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    await userEvent.click(screen.getByRole('button', { name: 'Complete and erase old secret' }));
    expect(await screen.findByText(/previous one was kept for rollback/)).toBeVisible();
  });

  it('saves an owner and a declared expiry', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.startsWith('/api/admin/users')) {
        return Promise.resolve(json({ users: [{ id: 'u-1', displayName: 'Dana Owner', login: 'dana' }] }));
      }
      if (url.startsWith(`/api/admin/credentials/`)) return Promise.resolve(json(item({ ownerUserId: 'u-1' })));
      return Promise.resolve(json({ alertDays: [30], items: [item()] }));
    });
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const owner = await screen.findByLabelText('Owner');
    await waitFor(() => expect(within(owner).getByRole('option', { name: 'Dana Owner (dana)' })).toBeInTheDocument());
    await userEvent.selectOptions(owner, 'u-1');
    await userEvent.type(screen.getByLabelText('Expires on (declared)'), '2027-01-31');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([u, init]) => String(u) === `/api/admin/credentials/person_source_secret.${SOURCE_ID}` && init?.method === 'PATCH')).toBe(true),
    );
    const patch = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({
      ownerUserId: 'u-1',
      declaredExpiresAt: '2027-01-31T00:00:00.000Z',
      note: null,
    });
  });
});
