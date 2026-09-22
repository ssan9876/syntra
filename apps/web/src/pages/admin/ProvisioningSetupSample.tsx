import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, Panel, SkeletonRows } from '@syntra/ui';
import { useApiResource } from './hooks.js';
interface Person { id: string; givenName: string; familyName: string }
interface Contract { id: string; startDate: string; endDate: string | null; department: string | null; isPrimary: boolean }
function SampleDetail({ person }: { person: Person }) {
  const detail = useApiResource<Person & { contracts: Contract[] }>(`/api/admin/persons/${person.id}`);
  if (detail.loading) return <SkeletonRows rows={2} cols={1} />;
  if (detail.error) return <Alert tone="danger">{detail.error}</Alert>;
  return <div className="mt-4">
    <h3 className="font-medium">{person.givenName} {person.familyName}</h3>
    {detail.data?.contracts.length ? <ul className="mt-2 space-y-2 text-sm text-muted">{detail.data.contracts.map((contract) => <li key={contract.id}>{contract.isPrimary ? 'Primary contract' : 'Additional contract'}: {contract.department ?? 'No department'} · Starts {contract.startDate.slice(0, 10)} · {contract.endDate ? `Ends ${contract.endDate.slice(0, 10)}` : 'No end date'}</li>)}</ul> : <p className="mt-2 text-sm text-muted">No employment contract saved. Lifecycle dates cannot be checked.</p>}
    <p className="mt-2 text-sm text-muted">These are saved employment dates. Actual access dates depend on all contracts, matching rules and the target’s lifecycle policy; inspect a fresh target run before applying.</p>
    <div className="mt-2 flex flex-wrap gap-4 text-sm"><Link className="text-primary underline" to={`/admin/people/${person.id}`}>Review employee and contracts</Link><Link className="text-primary underline" to={`/admin/people/${person.id}/access`}>Inspect recorded access</Link></div>
  </div>;
}
function SearchResults({ query }: { query: string }) {
  const people = useApiResource<{ persons: Person[]; total: number }>(`/api/admin/persons?q=${encodeURIComponent(query)}&pageSize=20`);
  const [person, setPerson] = useState<Person | null>(null);
  if (people.loading) return <SkeletonRows rows={2} cols={1} />;
  if (people.error) return <Alert tone="danger">{people.error}</Alert>;
  return <>
    {people.data?.persons.length ? <ul className="mt-3 flex flex-wrap gap-2">{people.data.persons.map((item) => <li key={item.id}><Button size="sm" aria-pressed={person?.id === item.id} onClick={() => setPerson(item)}>{item.givenName} {item.familyName}</Button></li>)}</ul> : <p className="mt-3 text-sm text-muted">No employees match. Import an employee or adjust the search.</p>}
    {!!people.data && people.data.total > people.data.persons.length && <p className="mt-2 text-sm text-muted">Showing the first 20 results. Refine the search to find another employee.</p>}
    {person && <SampleDetail key={person.id} person={person} />}
  </>;
}
export function ProvisioningSetupSample() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  return <Panel><div className="p-5"><h2 className="mb-3 font-semibold text-ink">Inspect a sample employee</h2><p className="mb-3 text-sm text-muted">Search saved employees by name or email, then verify the imported contract dates. Search includes employees from all HR sources.</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); setQuery(draft.trim()); }}><Field label="Employee name or email" value={draft} onChange={setDraft} /><Button type="submit" disabled={!draft.trim()}>Find employee</Button></form>
    {query && <SearchResults key={query} query={query} />}
  </div></Panel>;
}
