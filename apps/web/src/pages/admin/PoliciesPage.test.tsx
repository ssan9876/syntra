import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PoliciesPage } from './PoliciesPage.js';

const policy = {
  fallback: { outcome: 'allow', factorType: null },
  rules: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Finance needs a key',
      enabled: true,
      position: 1,
      outcome: 'require_factor',
      factorType: 'webauthn',
      applicationIds: [],
      groupIds: [],
      contractField: 'department',
      contractValues: ['Finance'],
      ipRanges: [],
      daysOfWeek: [],
      startMinute: null,
      endMinute: null,
      timezone: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Offsite is refused',
      enabled: true,
      position: 2,
      outcome: 'deny',
      factorType: null,
      applicationIds: [],
      groupIds: [],
      contractField: null,
      contractValues: [],
      ipRanges: ['203.0.113.0/24'],
      daysOfWeek: [],
      startMinute: null,
      endMinute: null,
      timezone: null,
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const renderPage = () =>
  render(
    <MemoryRouter>
      <PoliciesPage />
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('PoliciesPage', () => {
  it('lists rules in evaluation order with their position', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();

    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Finance needs a key');
    expect(rows[0]).toHaveTextContent('1');
    expect(rows[1]).toHaveTextContent('Offsite is refused');
  });

  it('states first-match-wins on the page rather than leaving it implicit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();
    expect(await screen.findByText(/first rule that matches/i)).toBeInTheDocument();
  });

  it('shows the tenant default as the last resort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();
    expect(await screen.findByText(/when no rule matches/i)).toBeInTheDocument();
  });

  it('summarises a rule conditions in words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(policy)));
    renderPage();
    expect(await screen.findByText(/department is Finance/i)).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.0\/24/)).toBeInTheDocument();
  });

  it('moves a rule up and sends the whole new order', async () => {
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? json(policy) : json(policy),
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderPage();

    await userEvent.click((await screen.findAllByRole('button', { name: /move up/i }))[0]!);

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([u]) => String(u).includes('/rules/order'));
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        ruleIds: [
          '22222222-2222-4222-8222-222222222222',
          '11111111-1111-4111-8111-111111111111',
        ],
      });
    });
  });

  it('reports how many users a rule would affect before it is saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/rules/impact')
          ? json({
              totalActiveUsers: 40,
              matchedUsers: 12,
              usersNeedingEnrolment: 9,
              unevaluatedConditions: [],
            })
          : json(policy),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /add a rule/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Everyone needs a factor');
    await userEvent.click(screen.getByRole('button', { name: /check who this affects/i }));

    expect(await screen.findByText(/matches 12 of 40 active users/i)).toBeInTheDocument();
    expect(screen.getByText(/9 of them hold no factor/i)).toBeInTheDocument();
  });

  it('says which conditions the count could not include', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/rules/impact')
          ? json({
              totalActiveUsers: 40,
              matchedUsers: 40,
              usersNeedingEnrolment: 40,
              unevaluatedConditions: ['source address'],
            })
          : json(policy),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /add a rule/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Offsite');
    await userEvent.click(screen.getByRole('button', { name: /check who this affects/i }));

    expect(await screen.findByText(/counted without source address/i)).toBeInTheDocument();
  });

  it('reports a rejected rule with the server message attached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) =>
        init?.method === 'POST'
          ? json(
              {
                status: 400,
                title: 'That rule cannot be stored as written',
                detail: 'ipRanges holds something that is not an address or CIDR: 10.0.0.0/33',
              },
              400,
            )
          : json(policy),
      ),
    );
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /add a rule/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Bad rule');
    await userEvent.type(screen.getByLabelText(/addresses/i), '10.0.0.0/33');
    await userEvent.click(screen.getByRole('button', { name: /save rule/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not an address or CIDR/i);
  });
});
