import { Empty } from '@syntra/ui';
import { AppShell } from '../components/AppShell.js';
import { useSession } from '../session/SessionProvider.js';

export function Portal() {
  const { session } = useSession();
  const firstName = session?.displayName.split(' ')[0] ?? 'there';

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold text-ink">
            Good day, {firstName}
          </h1>
          <p className="mt-1 text-muted">
            Applications your organization has assigned to you.
          </p>
        </header>

        <div className="mt-8">
          {/*
            The tile grid is filled by the Access module. Until then the empty
            state names who to ask rather than announcing a void.
          */}
          <Empty title="No applications assigned yet">
            When your administrator assigns applications to you, they appear
            here and open with a single click.
          </Empty>
        </div>
      </div>
    </AppShell>
  );
}
