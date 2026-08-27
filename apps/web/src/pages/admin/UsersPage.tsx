import { Alert } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { PeopleTab } from './PeopleTab.js';
import { AccountsTab } from './AccountsTab.js';
import { ImportTab } from './ImportTab.js';

interface PersonRow {
  id: string;
  status: string;
}

interface UserRow {
  id: string;
  status: string;
  locked?: boolean;
}

/**
 * Users: the people the organization knows, and the accounts they sign in with.
 *
 * These were two destinations, "Users" and "People", listed two rows apart in
 * the same navigation group. Keeping them apart cost a paragraph on each of
 * them explaining the other — People ended with "their sign-in accounts are
 * listed under Users", Users ended with "to onboard a new joiner, start under
 * People", and the deactivation prompt carried a third sentence saying that
 * turning off one does not turn off the other. Three pieces of prose existed
 * solely to describe a split the reader never asked for.
 *
 * They are not the same object and are not merged into one: a service account
 * has no person, and a joiner has a person for days before an account exists —
 * Kaycen Tyre sat in exactly that state while a provisioning guard held. What
 * was wrong was presenting two VIEWS of one subject as two PLACES. Tabs say
 * "same subject, different view" structurally, and the cards above them show
 * the relationship as a number instead of a sentence: when "Awaiting an
 * account" reads 1, the split explains itself.
 *
 * The counts are fetched here as well as in the tabs. That is two extra
 * requests on this screen, and the alternative — threading one resource down
 * into both tables — would have made each tab untestable on its own and
 * un-mountable anywhere else. Paid deliberately.
 */
export function UsersPage() {
  const can = useCan();
  const persons = useApiResource<{ persons: PersonRow[] }>('/api/admin/persons');
  const users = useApiResource<{ users: UserRow[] }>('/api/admin/users');

  // Optional all the way down, not just past `data`. The summary is the
  // first thing painted on the console's front door, and a response that
  // arrives without its collection — an error document, a truncated proxy
  // reply, a permission boundary answering with a different shape — should
  // read as zero rather than take the whole screen down with it. The tabs
  // below still report the failure properly; this row simply must not be the
  // thing that throws.
  const personRows = persons.data?.persons ?? [];
  const userRows = users.data?.users ?? [];

  const peopleCount = personRows.length;
  const activePeople = personRows.filter((p) => p.status === 'active').length;
  const accountCount = userRows.length;
  const lockedCount = userRows.filter((u) => u.locked).length;

  // The figure that used to be a paragraph. An active person with no account
  // is the joiner state — provisioned but not yet signed in — and it is the
  // only number on this screen that ever needs acting on.
  const awaiting = Math.max(0, activePeople - accountCount);

  const error = persons.error ?? users.error;

  return (
    <>
      <PageHeader title="Users" />

      {error && <Alert tone="danger">{error}</Alert>}

      <StatGrid>
        <StatCard label="People" value={peopleCount} to="/admin/users?tab=people" />
        <StatCard label="Accounts" value={accountCount} to="/admin/users?tab=accounts" />
        <StatCard
          label="Awaiting an account"
          value={awaiting}
          tone="warning"
          quietWhenZero
          to="/admin/users?tab=people"
        />
        <StatCard
          label="Locked out"
          value={lockedCount}
          tone="danger"
          quietWhenZero
          to="/admin/users?tab=accounts"
        />
      </StatGrid>

      <Tabs
        label="Users"
        tabs={[
          {
            id: 'people',
            label: 'People',
            badge: peopleCount || undefined,
            content: <PeopleTab />,
            hidden: !can('identity.read'),
          },
          {
            id: 'accounts',
            label: 'Accounts',
            badge: accountCount || undefined,
            content: <AccountsTab />,
            hidden: !can('directory.read'),
          },
          {
            id: 'import',
            label: 'Import',
            content: <ImportTab />,
            hidden: !can('identity.write'),
          },
        ]}
      />
    </>
  );
}
