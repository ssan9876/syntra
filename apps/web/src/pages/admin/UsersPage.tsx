import { Alert } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { useApiResource } from './hooks.js';
import { Tabs } from '../../components/Tabs.js';
import { StatCard, StatGrid } from '../../components/StatCards.js';
import { PageHeader } from './PageHeader.js';
import { PeopleTab } from './PeopleTab.js';
import { AccountsTab } from './AccountsTab.js';
import { ImportTab } from './ImportTab.js';

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
 * The counts come from /directory/summary rather than from the collections
 * the tabs fetch. That was two extra full-collection reads on this screen;
 * now it is one small one, and it stays correct once those lists page --
 * filtering a fetched array would describe fifty rows while still reading as
 * a total. Threading one resource down into both tables would still make each
 * tab untestable on its own, so the separate read stays deliberate.
 */
export function UsersPage() {
  const can = useCan();
  // The cards ask the server for its counts rather than counting a collection
  // they fetched. Both lists page now, so filtering the fetched array would
  // describe fifty rows while still reading as a total.
  const summary = useApiResource<{
    people: { total: number; active: number; withoutAccount: number };
    accounts: { total: number; active: number; locked: number };
  }>('/api/admin/directory/summary');
  // The orphan backlog. Its error is deliberately NOT folded into the banner
  // below: a caller who may read the directory but not people gets a card
  // reading zero rather than a broken front door, the same tolerance the
  // sources read already gets on the accounts tab.
  const unlinked = useApiResource<{ accounts: unknown[] }>(
    '/api/admin/users/unlinked',
  );

  // Optional all the way down, not just past `data`. The summary is the
  // first thing painted on the console's front door, and a response that
  // arrives without its collection — an error document, a truncated proxy
  // reply, a permission boundary answering with a different shape — should
  // read as zero rather than take the whole screen down with it. The tabs
  // below still report the failure properly; this row simply must not be the
  // thing that throws.
  const peopleCount = summary.data?.people?.total ?? 0;
  const accountCount = summary.data?.accounts?.total ?? 0;
  const lockedCount = summary.data?.accounts?.locked ?? 0;

  // The figure that used to be a paragraph. An active person with no account
  // is the joiner state — provisioned but not yet signed in — and it is the
  // only number on this screen that ever needs acting on.
  //
  // COUNTED BY THE SERVER, not derived here. Subtracting all accounts from
  // active people counts service accounts, leavers' accounts and second
  // accounts against the joiners: it read zero on any real tenant, and
  // `Math.max` was what hid that it had gone negative.
  const awaiting = summary.data?.people?.withoutAccount ?? 0;

  const error = summary.error;

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
        {/* A card and not a fourth tab, for the reason the two above are
            cards: the backlog is transient, `quietWhenZero` makes the control
            disappear once it is cleared, and a tab would be a permanently
            visible destination that is usually empty. */}
        <StatCard
          label="Accounts with no person"
          value={(unlinked.data?.accounts ?? []).length}
          tone="warning"
          quietWhenZero
          to="/admin/users/unlinked"
        />
      </StatGrid>

      <Tabs
        label="Users"
        // People and Accounts both read these, and they are not the same list.
        resetParams={['q', 'status', 'page']}
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
