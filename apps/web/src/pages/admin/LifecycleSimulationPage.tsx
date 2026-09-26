import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, ErrorSummary, Field, Panel, Select, StateBadge, Table } from '@syntra/ui';
import { api, ApiError } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Named { entitlementId: string; displayName: string; privileged: boolean }
interface SimulatedTarget {
  targetSystemId: string; targetName: string; accountStatus: string;
  account: 'create' | 'enable' | 'keep' | 'disable' | 'none';
  add: Named[]; retain: Named[]; remove: Named[];
  unverified: boolean; unprocessable: { kind: string; message: string } | null;
  departure?: { disableAt: string; revokeEntitlementsAt: string; archiveAt: string | null };
  blockers: string[]; verificationCoverage: 'read-back' | 'manual';
}
interface PersonSimulation {
  personId: string; personName: string; department: string | null; targets: SimulatedTarget[];
  syntraLogins: { userId: string; login: string; status: string; effect: string }[]; summary: string[];
}
interface SimulationResult {
  kind: string; scope: string; writesPerformed: false; computedAt: string;
  people: PersonSimulation[]; unsupported: string[]; safetyBlockers: string[];
}
interface Simulation { id: string; kind: string; scope: string; personId: string | null; department: string | null; peopleCount: number; createdAt: string; expiresAt: string | null; result?: SimulationResult }

const ACCOUNT_LABEL: Record<SimulatedTarget['account'], string> = { create: 'create', enable: 'enable', keep: 'keep', disable: 'disable', none: 'none' };

export function LifecycleSimulationPage() {
  const [kind, setKind] = useState<'hire' | 'move' | 'leaver'>('hire');
  const [scope, setScope] = useState<'person' | 'department'>('department');
  const [personId, setPersonId] = useState('');
  const [department, setDepartment] = useState('');
  const [newDepartment, setNewDepartment] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [result, setResult] = useState<Simulation | null>(null);
  /**
   * The scenario the result on screen was computed FOR, or null for one
   * opened from the history (which describes its own scenario in its row).
   *
   * The result sits directly under the fields that produced it, so a changed
   * department or scenario leaves a table of effects for a rehearsal that was
   * never run — and a reviewer signing off on "what a leaver in Finance does"
   * could be reading what a joiner in Finance does. It is labelled out of
   * date the moment the inputs move away from it.
   */
  const [ranWith, setRanWith] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useApiResource<{ simulations: Simulation[] }>('/api/admin/lifecycle-simulations');
  const inputs = JSON.stringify({ kind, scope, personId: personId.trim(), department: department.trim(), newDepartment, newTitle, newLocation });
  const run = async () => {
    const basis = inputs;
    setBusy(true); setProblem('');
    try {
      const changes = kind === 'move'
        ? { ...(newDepartment ? { department: newDepartment } : {}), ...(newTitle ? { jobTitle: newTitle } : {}), ...(newLocation ? { location: newLocation } : {}) }
        : undefined;
      const simulation = await api<Simulation>('/api/admin/lifecycle-simulations', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          ...(scope === 'person' ? { personId: personId.trim() } : { department: department.trim() }),
          ...(changes && Object.keys(changes).length ? { changes } : {}),
        }),
      });
      setResult(simulation);
      setRanWith(basis);
      history.reload();
    } catch (error) {
      setProblem(error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : error instanceof Error ? error.message : 'Simulation could not run.');
    } finally { setBusy(false); }
  };
  const load = async (id: string) => {
    setBusy(true); setProblem('');
    try { setResult(await api<Simulation>(`/api/admin/lifecycle-simulations/${id}`)); setRanWith(null); }
    catch { setProblem('That simulation could not be loaded.'); }
    finally { setBusy(false); }
  };
  const outcome = result?.result;
  const stale = outcome !== undefined && ranWith !== null && ranWith !== inputs;
  return <>
    <PageHeader title="Lifecycle simulation" actions={<Link className="link" to="/admin/employee-work">Employee work</Link>} />
    <Panel title="Rehearse a hire, change or departure"><form noValidate className="space-y-4 p-4" onSubmit={(event) => { event.preventDefault(); if (scope === 'person' ? personId.trim() : department.trim()) void run(); }}>
      <ErrorSummary errors={problem ? [{ message: problem }] : []} title="Not simulated" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Select label="Scenario" value={kind} onChange={(value) => setKind(value as typeof kind)} options={[{ value: 'hire', label: 'Joiner' }, { value: 'move', label: 'Mover' }, { value: 'leaver', label: 'Leaver' }]} />
        <Select label="Scope" value={scope} onChange={(value) => setScope(value as typeof scope)} options={[{ value: 'department', label: 'Every active person in a department' }, { value: 'person', label: 'One person' }]} />
        {scope === 'person' ? <Field name="personId" label="Person ID" value={personId} onChange={setPersonId} /> : <Field name="department" label="Department" value={department} onChange={setDepartment} placeholder="exactly as recorded on the primary contract" />}
      </div>
      {kind === 'move' ? <div className="grid gap-4 sm:grid-cols-3">
        <Field label="New department (optional)" value={newDepartment} onChange={setNewDepartment} />
        <Field label="New job title (optional)" value={newTitle} onChange={setNewTitle} />
        <Field label="New location (optional)" value={newLocation} onChange={setNewLocation} />
      </div> : null}
      <Button type="submit" loading={busy} disabled={scope === 'person' ? !personId.trim() : !department.trim()}>{stale ? 'Simulate again' : 'Simulate without writes'}</Button>
    </form></Panel>
    {outcome ? <Panel title={`Expected effects — ${outcome.kind} (${outcome.people.length} ${outcome.people.length === 1 ? 'person' : 'people'})`} actions={stale ? <StateBadge state="attention">Out of date</StateBadge> : null}><div className="space-y-3 p-4" aria-live="polite">
      <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-2"><dt className="text-muted">Computed</dt><dd className="text-ink">{new Date(outcome.computedAt).toLocaleString()}</dd></div>
        <div className="flex gap-2"><dt className="text-muted">External writes</dt><dd><StateBadge state="healthy">None</StateBadge></dd></div>
      </dl>
      {outcome.unsupported.length ? <Alert tone="warning" title="Unsupported capabilities">{outcome.unsupported.join('; ')}</Alert> : null}
      {outcome.safetyBlockers.length ? <Alert tone="warning" title="Safety blockers">{outcome.safetyBlockers.join('; ')}</Alert> : null}
      {outcome.people.length === 0 ? <p>No active person matched.</p> : <Table>
        <thead><tr><th scope="col">Person</th><th scope="col">Target</th><th scope="col">Account</th><th scope="col">Grant</th><th scope="col">Revoke</th><th scope="col">Verification</th><th scope="col">Blockers</th></tr></thead>
        <tbody>{outcome.people.flatMap((person) => person.targets.length === 0
          ? [<tr key={person.personId}><td><Link className="link" to={`/admin/people/${person.personId}`}>{person.personName}</Link></td><td colSpan={6} className="text-muted">No enabled target</td></tr>]
          : person.targets.map((target, index) => <tr key={`${person.personId}:${target.targetSystemId}`}>
            <td>{index === 0 ? <Link className="link" to={`/admin/people/${person.personId}`}>{person.personName}</Link> : null}</td>
            <td>{target.targetName}{target.unverified ? <> <StateBadge state="attention">Unverified</StateBadge></> : null}</td>
            <td>{ACCOUNT_LABEL[target.account]}{target.departure ? <p className="text-muted">disable {new Date(target.departure.disableAt).toLocaleDateString()} · revoke {new Date(target.departure.revokeEntitlementsAt).toLocaleDateString()}{target.departure.archiveAt ? ` · archive ${new Date(target.departure.archiveAt).toLocaleDateString()}` : ''}</p> : null}</td>
            <td>{target.add.map((item) => item.displayName).join(', ') || '—'}</td>
            <td>{target.remove.map((item) => item.displayName).join(', ') || '—'}</td>
            <td>{target.verificationCoverage}</td>
            <td>{target.blockers.length ? target.blockers.join('; ') : '—'}</td>
          </tr>))}</tbody>
      </Table>}
    </div></Panel> : null}
    <Panel title="Previous simulations"><div className="p-4">
      {history.data?.simulations.length ? <Table tight><thead><tr><th scope="col">When</th><th scope="col">Scenario</th><th scope="col">Scope</th><th scope="col">People</th><th scope="col">Expires</th><th scope="col"></th></tr></thead><tbody>
        {history.data.simulations.map((simulation) => <tr key={simulation.id}><td>{new Date(simulation.createdAt).toLocaleString()}</td><td>{simulation.kind}</td><td>{simulation.department ?? simulation.personId ?? simulation.scope}</td><td>{simulation.peopleCount}</td><td>{simulation.expiresAt ? new Date(simulation.expiresAt).toLocaleDateString() : '—'}</td><td><Button size="sm" variant="ghost" onClick={() => void load(simulation.id)}>Open</Button></td></tr>)}
      </tbody></Table> : <p className="text-sm text-muted">No simulations yet</p>}
    </div></Panel>
  </>;
}
