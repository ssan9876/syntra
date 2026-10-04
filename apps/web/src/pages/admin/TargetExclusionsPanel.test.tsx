import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TargetExclusionsPanel } from './TargetExclusionsPanel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SETH = '11111111-1111-4111-8111-111111111111';

const exclusion = {
  targetSystemId: 't-1',
  targetName: 'fmx.ssander.xyz',
  personId: SETH,
  personName: 'Seth Sander',
  businessEmail: 'seth@acme.test',
  reason: 'FMX bootstrap administrator',
  createdByUserId: null,
  createdByName: 'Jane Doe',
  createdAt: '2026-10-03T10:00:00.000Z',
  message: 'Left out of this target by Jane Doe on 3 Oct 2026: FMX bootstrap administrator.',
};

afterEach(() => vi.restoreAllMocks());

describe('TargetExclusionsPanel', () => {
  it('says so when no one is left out, and offers nothing to a reader', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ exclusions: [] }));
    render(<TargetExclusionsPanel targetId="t-1" canManage={false} />);
    expect(await screen.findByText('No one is left out')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('leaves a person out with a reason', async () => {
    let rows: unknown[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/admin/persons?')) {
        return json({ persons: [{ id: SETH, givenName: 'Seth', familyName: 'Sander', businessEmail: 'seth@acme.test' }] });
      }
      if (url.endsWith('/targets/t-1/exclusions') && init?.method === 'POST') {
        rows = [exclusion];
        return json(exclusion, 201);
      }
      if (url.endsWith('/targets/t-1/exclusions')) return json({ exclusions: rows });
      throw new Error(`unmocked fetch: ${url}`);
    });
    const user = userEvent.setup();
    render(<TargetExclusionsPanel targetId="t-1" canManage />);
    await screen.findByText('No one is left out');

    await user.click(screen.getByRole('button', { name: 'Add' }));
    const leave = screen.getByRole('button', { name: 'Leave out' });
    expect(leave).toBeDisabled();
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'seth');
    await user.click(await screen.findByRole('option', { name: /Seth Sander/ }));
    expect(leave).toBeDisabled();
    await user.type(screen.getByLabelText(/Why/), 'FMX bootstrap administrator');
    await user.click(leave);

    expect(await screen.findByText(exclusion.message)).toBeVisible();
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ personId: SETH, reason: 'FMX bootstrap administrator' });
  });

  it('removes a person with a reason', async () => {
    let rows: unknown[] = [exclusion];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/targets/t-1/exclusions/${SETH}`) && init?.method === 'DELETE') {
        rows = [];
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/targets/t-1/exclusions')) return json({ exclusions: rows });
      throw new Error(`unmocked fetch: ${url}`);
    });
    const user = userEvent.setup();
    render(<TargetExclusionsPanel targetId="t-1" canManage />);
    const row = (await screen.findByText('Seth Sander')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Remove' }));
    const confirm = within(row).getByRole('button', { name: 'Remove' });
    expect(confirm).toBeDisabled();
    await user.type(within(row).getByLabelText(/Why/), 'FMX retired');
    await user.click(confirm);

    await waitFor(() => expect(screen.getByText('No one is left out')).toBeVisible());
    const del = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(JSON.parse(String(del?.[1]?.body))).toEqual({ reason: 'FMX retired' });
  });

  it('shows the refusal the API gives', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/api/admin/persons?')) {
        return json({ persons: [{ id: SETH, givenName: 'Seth', familyName: 'Sander' }] });
      }
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            type: 'https://syntra.dev/problems/already-left-out',
            title: 'Already left out',
            status: 409,
            detail: 'Seth Sander is already left out of target "fmx.ssander.xyz".',
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return json({ exclusions: [] });
    });
    const user = userEvent.setup();
    render(<TargetExclusionsPanel targetId="t-1" canManage />);
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    await user.type(screen.getByRole('combobox', { name: 'Person' }), 'seth');
    await user.click(await screen.findByRole('option', { name: /Seth Sander/ }));
    await user.type(screen.getByLabelText(/Why/), 'again');
    await user.click(screen.getByRole('button', { name: 'Leave out' }));
    expect(await screen.findByText('Seth Sander is already left out of target "fmx.ssander.xyz".')).toBeVisible();
  });
});
