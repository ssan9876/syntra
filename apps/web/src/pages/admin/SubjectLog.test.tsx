import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SubjectLog } from './SubjectLog.js';

let permitted = true;

vi.mock('../../session/SessionProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/SessionProvider.js')>()),
  useCan: () => (permission: string) =>
    permission === 'audit.read' ? permitted : true,
}));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const EVENTS = [
  {
    id: 'e2',
    sequence: 12,
    occurredAt: '2026-08-27T09:00:00.000Z',
    action: 'user.unlock',
    targetType: 'User',
    outcome: 'success',
    sourceIp: '10.0.0.1',
    payload: { login: 'jdoe' },
  },
  {
    id: 'e1',
    sequence: 7,
    occurredAt: '2026-08-26T09:00:00.000Z',
    action: 'auth.login',
    targetType: 'User',
    outcome: 'failure',
    sourceIp: '10.0.0.1',
    payload: {},
  },
];

function mockAudit(body: unknown = { events: EVENTS, chainValid: true }) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() => Promise.resolve(json(body)));
}

beforeEach(() => {
  vi.restoreAllMocks();
  permitted = true;
});

describe('SubjectLog', () => {
  it('asks the audit log for every subject it was given', async () => {
    const fetchSpy = mockAudit();
    render(<SubjectLog subjects={['p1', 'u1']} />);

    await screen.findByText('user.unlock');

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('subject=p1');
    expect(url).toContain('subject=u1');
  });

  it('lists the events with their outcome', async () => {
    mockAudit();
    render(<SubjectLog subjects={['u1']} />);

    expect(await screen.findByText('user.unlock')).toBeInTheDocument();
    expect(screen.getByText('auth.login')).toBeInTheDocument();
    expect(screen.getByText('failure')).toBeInTheDocument();
  });

  /**
   * The panel disappears rather than showing a permission error. An
   * administrator who may edit the directory but not read the audit log is not
   * missing anything they can act on, and a red box on every account screen
   * telling them so is a permanent apology.
   */
  it('renders nothing at all without audit.read', async () => {
    permitted = false;
    const fetchSpy = mockAudit();
    const { container } = render(<SubjectLog subjects={['u1']} />);

    expect(container).toBeEmptyDOMElement();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says so when the subject has no history', async () => {
    mockAudit({ events: [], chainValid: true });
    render(<SubjectLog subjects={['u1']} />);

    expect(await screen.findByText(/nothing recorded/i)).toBeInTheDocument();
  });

  /**
   * The whole point of filtering server-side. An empty subject list is a
   * person with no id and no accounts, and asking for it unfiltered would put
   * every other account's history on their screen.
   */
  it('asks for nothing when there is no subject to ask about', async () => {
    const fetchSpy = mockAudit();
    render(<SubjectLog subjects={[]} />);

    await waitFor(() => expect(screen.getByText(/nothing recorded/i)).toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leads with the tamper warning when the chain no longer verifies', async () => {
    mockAudit({ events: EVENTS, chainValid: false, brokenAtSequence: 4 });
    render(<SubjectLog subjects={['u1']} />);

    expect(await screen.findByText(/has been altered/i)).toBeInTheDocument();
    expect(screen.getByText(/entry 4/)).toBeInTheDocument();
  });

  /**
   * `chainValid` is a statement about the WHOLE log, and this panel shows a
   * slice of it. Repeating AuditTab's green "chain verified" line here would
   * read as a claim that these particular entries were verified together,
   * which is not what was checked.
   */
  it('makes no verification claim about the slice it shows', async () => {
    mockAudit();
    render(<SubjectLog subjects={['u1']} />);

    await screen.findByText('user.unlock');
    expect(screen.queryByText(/chain verified/i)).not.toBeInTheDocument();
  });
});
