import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TenantSettingsPage } from './TenantSettingsPage.js';

const settings = {
  name: 'Acme Care',
  slug: 'acme',
  primaryDomain: 'acme.localhost',
  additionalDomains: [] as string[],
  adminMfaRequired: false,
  selfEnrolmentEnabled: true,
  passwordMinLength: 12,
  webauthnAvailable: true,
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
      <TenantSettingsPage />
    </MemoryRouter>,
  );

let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stub = (
  handler: (url: string, init?: RequestInit) => Response = () => json(settings),
) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return handler(String(url), init);
    }),
  );
};

describe('TenantSettingsPage', () => {
  it('shows the settings the chokepoint actually reads', async () => {
    stub();
    renderPage();

    expect(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /enrol a factor themselves/i }),
    ).toBeChecked();
    expect(screen.getByLabelText(/minimum password length/i)).toHaveValue(12);
  });

  it('saves the change the README told the operator to make', async () => {
    stub();
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put).toBeDefined();
      expect(JSON.parse(String(put!.init!.body))).toMatchObject({
        adminMfaRequired: true,
        selfEnrolmentEnabled: true,
      });
    });
  });

  it('warns before the pair that refuses every administrator without a factor', async () => {
    stub();
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: /enrol a factor themselves/i }),
    );

    expect(
      await screen.findByText(/nobody can enrol their way in/i),
    ).toBeInTheDocument();
  });

  it('shows the server refusal rather than paraphrasing it', async () => {
    stub((url, init) =>
      init?.method === 'PUT'
        ? json(
            {
              type: 'https://syntra.dev/problems/would-lock-you-out',
              title: 'Set up your own second factor first',
              status: 409,
              detail: 'Enrol from the Security page, then save this again.',
            },
            409,
          )
        : json(settings),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /second factor for the console/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    expect(await screen.findByText(/enrol from the security page/i)).toBeInTheDocument();
  });

  it('says a security key cannot be registered when the tenant has no domain', async () => {
    stub(() => json({ ...settings, primaryDomain: null, webauthnAvailable: false }));
    renderPage();

    expect(
      await screen.findByText(/only an authenticator app can satisfy it/i),
    ).toBeInTheDocument();
  });
});

describe('the primary domain, and the passkeys it would break', () => {
  it('refuses to move the domain until the passkey count is acknowledged', async () => {
    // WebAuthn binds every credential to the relying party it was created
    // against. Moving the domain does not migrate them — it makes each one
    // unusable, silently, at whatever moment its holder next signs in. So the
    // save is refused with the number, and the number has to come back.
    let attempt = 0;
    stub((url, init) => {
      if (init?.method !== 'PUT') return json(settings);
      attempt += 1;
      const body = JSON.parse(String(init.body));
      if (body.ackPasskeys !== 3) {
        return json(
          {
            type: 'https://syntra.dev/problems/passkeys-would-break',
            title: 'Confirmation required',
            status: 409,
            detail: 'changing the primary domain will invalidate 3 registered security keys',
            passkeys: 3,
          },
          409,
        );
      }
      return json({ ...settings, primaryDomain: 'moved.example.com' });
    });
    renderPage();

    const field = await screen.findByLabelText('Primary domain');
    await userEvent.clear(field);
    await userEvent.type(field, 'moved.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    // The count is shown, in the warning, with what it costs.
    expect(
      await screen.findByText(/invalidate registered security keys/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 keys are/)).toBeInTheDocument();

    // And the confirming control names the price rather than saying "OK".
    await userEvent.click(
      screen.getByRole('button', { name: /Change the domain and invalidate 3 keys/ }),
    );

    await waitFor(() => expect(screen.getByText('Settings saved.')).toBeInTheDocument());
    expect(attempt).toBe(2);
    const sent = JSON.parse(String(calls.filter((c) => c.init?.method === 'PUT').at(-1)!.init!.body));
    expect(sent).toMatchObject({ primaryDomain: 'moved.example.com', ackPasskeys: 3 });
  });

  it('reopens the question when the domain is edited after the warning', async () => {
    // The count acknowledged was for the value typed at the time. Editing it
    // makes that answer stale, and carrying it forward would confirm a
    // decision about a different change.
    stub((url, init) => {
      if (init?.method !== 'PUT') return json(settings);
      return json(
        {
          type: 'https://syntra.dev/problems/passkeys-would-break',
          title: 'Confirmation required',
          status: 409,
          detail: 'would invalidate 3 keys',
          passkeys: 3,
        },
        409,
      );
    });
    renderPage();

    const field = await screen.findByLabelText('Primary domain');
    await userEvent.clear(field);
    await userEvent.type(field, 'first.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/3 keys are/)).toBeInTheDocument();

    await userEvent.type(field, 'x');
    expect(screen.queryByText(/3 keys are/)).toBeNull();
  });

  it('sends null for an empty domain rather than an empty string', async () => {
    // Empty means "clear it", which turns WebAuthn off. An empty string is a
    // hostname the resolver would compare against and never match.
    stub((url, init) => (init?.method === 'PUT' ? json(settings) : json(settings)));
    renderPage();

    const field = (await screen.findByLabelText('Primary domain')) as HTMLInputElement;
    // WAIT FOR THE LOADED VALUE BEFORE EDITING IT.
    //
    // The field renders as soon as `data` exists, but the effect that copies
    // `data` into form state runs after that render — so an edit made in
    // between is overwritten by the effect a moment later, and the test fails
    // claiming the page ignored it. Observing the loaded value first closes
    // that window.
    await waitFor(() => expect(field.value).toBe('acme.localhost'));

    // `fireEvent.change`, not `userEvent.clear`. Clearing a controlled input
    // with `clear()` empties the DOM node without React seeing an onChange, so
    // the component's state keeps the old value and the form posts it — which
    // is a property of the harness, not of the page.
    fireEvent.change(field, { target: { value: '' } });
    await waitFor(() => expect(field.value).toBe(''));
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const sent = JSON.parse(
      String(calls.find((c) => c.init?.method === 'PUT')!.init!.body),
    );
    expect(sent.primaryDomain).toBeNull();
  });
});
