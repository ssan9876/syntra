import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SettingsSignInTab } from './SettingsSignInTab.js';

const settings = {
  name: 'Acme Care',
  slug: 'acme',
  primaryDomain: 'acme.localhost',
  additionalDomains: [] as string[],
  adminMfaRequired: false,
  selfEnrolmentEnabled: true,
  passwordMinLength: 12,
  lockoutThreshold: 0,
  lockoutWindowMinutes: 15,
  lockoutDurationMinutes: 15,
  portalSessionIdleMinutes: 60,
  portalSessionAbsoluteMinutes: 720,
  adminSessionIdleMinutes: 15,
  adminSessionAbsoluteMinutes: 120,
  adminWebauthnRequired: false,
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
      <SettingsSignInTab />
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

/**
 * The primary-domain field, loaded and then set to `value` in one step.
 *
 * TWO harness traps live here, and every test that types into this field has
 * to avoid both.
 *
 * The field renders as soon as `data` exists, but the effect that copies
 * `data` into form state runs after that render — so an edit made in between
 * is overwritten a moment later, and the test fails claiming the page ignored
 * it. Waiting for the loaded value first closes that window. (The symptom is
 * a value like `acme.localhostmoved.example.com`: the clear landed on an empty
 * field, the effect then filled it, and the typing appended.)
 *
 * And `userEvent.clear` empties a controlled input's DOM node without React
 * seeing an onChange, so the component keeps the old value and the form posts
 * it — a property of the harness, not of the page. `fireEvent.change` is what
 * a controlled input actually responds to.
 *
 * Both were found the expensive way: as an intermittent failure that passed on
 * re-run. Anything typing into this field goes through here.
 */
async function setDomain(value: string): Promise<HTMLInputElement> {
  const field = (await screen.findByLabelText('Primary domain')) as HTMLInputElement;
  await waitFor(() => expect(field.value).toBe(settings.primaryDomain));
  fireEvent.change(field, { target: { value } });
  await waitFor(() => expect(field.value).toBe(value));
  return field;
}

describe('SettingsSignInTab', () => {
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
      await screen.findByText(/only an authenticator app can satisfy this/i),
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

    await setDomain('moved.example.com');
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

    const field = await setDomain('first.example.com');
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

    await setDomain('');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const sent = JSON.parse(
      String(calls.find((c) => c.init?.method === 'PUT')!.init!.body),
    );
    expect(sent.primaryDomain).toBeNull();
  });
});

describe('SettingsSignInTab and session lifetimes', () => {
  const bodyOf = (init?: RequestInit) =>
    JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

  it('shows the lifetimes in force and saves them as numbers', async () => {
    stub();
    renderPage();

    const adminIdle = (await screen.findByLabelText(
      /console idle timeout/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(adminIdle.value).toBe('15'));
    expect(screen.getByLabelText(/portal session lasts/i)).toHaveValue(720);

    fireEvent.change(adminIdle, { target: { value: '10' } });
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put).toBeDefined();
      expect(bodyOf(put!.init)).toMatchObject({
        adminSessionIdleMinutes: 10,
        adminSessionAbsoluteMinutes: 120,
        portalSessionIdleMinutes: 60,
        portalSessionAbsoluteMinutes: 720,
      });
    });
  });

  it('warns that shortening reaches sessions already signed in, only while shortening', async () => {
    stub();
    renderPage();

    const field = (await screen.findByLabelText(
      /console session lasts/i,
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('120'));
    expect(screen.queryByText(/apply to everyone signed in now/i)).toBeNull();

    fireEvent.change(field, { target: { value: '60' } });
    expect(await screen.findByText(/apply to everyone signed in now/i)).toBeInTheDocument();

    fireEvent.change(field, { target: { value: '240' } });
    await waitFor(() =>
      expect(screen.queryByText(/apply to everyone signed in now/i)).toBeNull(),
    );
  });
});

describe('SettingsSignInTab and the security-key requirement', () => {
  const bodyOf = (init?: RequestInit) =>
    JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

  it('warns about the sessions it ends before it is switched on, and sends it', async () => {
    stub();
    renderPage();

    const box = await screen.findByRole('checkbox', {
      name: /security key for the console/i,
    });
    expect(box).not.toBeChecked();
    expect(screen.queryByText(/sessions started without a key end/i)).toBeNull();

    await userEvent.click(box);
    expect(
      await screen.findByText(/sessions started without a key end/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(bodyOf(put!.init).adminWebauthnRequired).toBe(true);
    });
  });

  it('shows the lockout refusal in the server\'s words', async () => {
    stub((url, init) =>
      init?.method === 'PUT'
        ? json(
            {
              type: 'https://syntra.dev/problems/security-key-session-required',
              title: 'Elevate with your security key first',
              status: 409,
              detail: 'Leave the console, elevate again using your key, then save this again.',
            },
            409,
          )
        : json(settings),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('checkbox', { name: /security key for the console/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

    expect(
      await screen.findByText(/elevate again using your key/i),
    ).toBeInTheDocument();
  });

  it('cannot be switched on without a domain, but can always be switched off', async () => {
    stub(() => json({ ...settings, primaryDomain: null, webauthnAvailable: false }));
    const { unmount } = renderPage();
    expect(
      await screen.findByRole('checkbox', { name: /security key for the console/i }),
    ).toBeDisabled();
    unmount();

    stub(() =>
      json({
        ...settings,
        primaryDomain: null,
        webauthnAvailable: false,
        adminWebauthnRequired: true,
      }),
    );
    renderPage();
    const box = await screen.findByRole('checkbox', {
      name: /security key for the console/i,
    });
    await waitFor(() => expect(box).toBeChecked());
    expect(box).toBeEnabled();
  });
});

describe('SettingsSignInTab and account lockout', () => {
  const bodyOf = (init?: RequestInit) =>
    JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

  it('hides the numbers until lockout is switched on', async () => {
    stub();
    renderPage();

    expect(await screen.findByLabelText(/lock an account after/i)).not.toBeChecked();
    expect(screen.queryByLabelText(/failures before locking/i)).toBeNull();
  });

  it('saves zero for a tenant that leaves it off', async () => {
    const user = userEvent.setup();
    stub();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /save settings/i }));

    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(bodyOf(put.init).lockoutThreshold).toBe(0);
  });

  it('saves the default threshold when it is switched on', async () => {
    const user = userEvent.setup();
    stub();
    renderPage();

    await user.click(await screen.findByLabelText(/lock an account after/i));
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    const put = calls.find((c) => c.init?.method === 'PUT')!;
    // Five, not the contract's floor of three: the floor and the default are
    // different questions, and starting somebody at three costs them two more
    // attempts on their first typo.
    expect(bodyOf(put.init).lockoutThreshold).toBe(5);
  });

  it('warns when the lock will never lift itself', async () => {
    const user = userEvent.setup();
    stub(() => json({ ...settings, lockoutThreshold: 5, lockoutDurationMinutes: 0 }));
    renderPage();

    expect(
      await screen.findByText(/do not lift themselves/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/has to be reachable to unlock them/i)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/lock lasts/i));
    await user.type(screen.getByLabelText(/lock lasts/i), '30');
    await waitFor(() =>
      expect(screen.queryByText(/do not lift themselves/i)).toBeNull(),
    );
  });
});
