import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, SkeletonRows, Table, type ComboOption } from '@syntra/ui';
import { useApiResource } from './hooks.js';
import { PersonPicker } from './PickerNote.js';
import type { SampleLike } from './provisioning-readiness.js';

interface Contract { id: string; startDate: string; endDate: string | null; department: string | null; jobTitle?: string | null; isPrimary: boolean }

function SampleDetail({ person, onInspect }: { person: ComboOption; onInspect(sample: SampleLike | null): void }) {
  const detail = useApiResource<{ contracts: Contract[] }>(`/api/admin/persons/${person.value}`);
  const contracts = detail.data?.contracts ?? null;
  // Reported only once the contracts are READ. A name picked in the box is
  // not an inspection; the dates on screen are.
  useEffect(() => {
    if (contracts) onInspect({ personId: person.value, name: person.label, contracts: contracts.length });
  }, [contracts, person, onInspect]);

  if (!detail.data && detail.loading) return <SkeletonRows rows={2} cols={4} />;
  if (detail.error) return <Alert tone="danger">{detail.error}</Alert>;
  return <div className="mt-4 space-y-3">
    {contracts && contracts.length > 0 ? (
      <Table tight>
        <caption className="sr-only">Contracts of {person.label}</caption>
        <thead><tr><th scope="col">Contract</th><th scope="col">Department</th><th scope="col">Job title</th><th scope="col">Starts</th><th scope="col">Ends</th></tr></thead>
        <tbody>{contracts.map((contract) => <tr key={contract.id}>
          <td>{contract.isPrimary ? 'Primary' : 'Additional'}</td>
          <td>{contract.department ?? '—'}</td>
          <td>{contract.jobTitle ?? '—'}</td>
          <td className="tabular-nums">{contract.startDate.slice(0, 10)}</td>
          <td className="tabular-nums">{contract.endDate ? contract.endDate.slice(0, 10) : 'Open-ended'}</td>
        </tr>)}</tbody>
      </Table>
    ) : <Alert tone="warning">No employment contract saved. Lifecycle dates cannot be checked for {person.label}.</Alert>}
    <div className="flex flex-wrap gap-4 text-sm">
      <Link className="link" to={`/admin/people/${person.value}`}>Review employee and contracts</Link>
      <Link className="link" to={`/admin/people/${person.value}/access`}>Inspect recorded access</Link>
    </div>
  </div>;
}

/**
 * Step 3 of setup, in place: pick anybody the HR feed brought in and read
 * their contract dates.
 *
 * The picker asks the server, so the employee somebody means to check is
 * findable however large the directory is — the old version searched on
 * submit and then showed twenty buttons.
 *
 * Not a `Panel`: a panel clips its overflow, and the picker's list is an
 * overlay that has to be able to hang below the box.
 */
export function ProvisioningSetupSample({ onInspect }: { onInspect(sample: SampleLike | null): void }) {
  const [person, setPerson] = useState<ComboOption | null>(null);
  return <section id="sample-employee" aria-labelledby="sample-employee-title" tabIndex={-1} className="rounded-panel border border-border-subtle bg-bg">
    <header className="rounded-t-panel border-b border-border-subtle bg-surface px-4 py-3">
      <h2 id="sample-employee-title" className="text-md font-semibold text-ink">Sample employee</h2>
    </header>
    <div className="p-4">
      <PersonPicker
        label="Employee"
        value={person}
        onChange={(next) => { setPerson(next); if (!next) onInspect(null); }}
        className="max-w-md"
      />
      {person && <SampleDetail key={person.value} person={person} onInspect={onInspect} />}
    </div>
  </section>;
}
