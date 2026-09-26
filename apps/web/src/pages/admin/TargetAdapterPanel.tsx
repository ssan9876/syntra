import { useState } from 'react';
import { Alert, Button, Field, Panel, Select, SkeletonRows, StateBadge, useToast } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

/**
 * Which adapter release writes to this target -- see `GET /targets/:id/adapter`.
 *
 * Certification-aware rollout (backlog 33) and capability enforcement
 * (backlog 18) share this panel because they answer one question for the
 * operator: "what will Syntra actually write here, through which code?" The
 * channel and pin choose the release; the capability list says which writes
 * that release is certified for and which this target's configuration
 * refuses; the warnings say when the release is deprecated or not fully
 * certified. A rollback changes only the release, never the configuration,
 * profile, rules or accounts.
 */
interface Release {
  adapterVersion: string;
  channel: 'stable' | 'canary';
  supportState: string;
  rollout: string;
  deprecationDate: string | null;
  certification: { status: string; evidence: string; verifiedAt: string | null; capabilities: string[] };
}

export interface AdapterReport {
  type: string;
  selection: {
    channel: 'stable' | 'canary';
    pinnedVersion: string | null;
    rollbackVersion: string | null;
    changedAt: string | null;
    reason: string | null;
  };
  effective: { source: 'pin' | 'canary' | 'stable'; release: Release } | null;
  resolutionError: string | null;
  releases: Release[];
  capabilities: { capability: string; certified: boolean; refusal: string | null }[];
  warnings: string[];
  writesBlockedReason: string | null;
  deprecationOverride: {
    version: string;
    reason: string | null;
    expiresAt: string | null;
    active: boolean;
  } | null;
}

const SOURCE_LABEL = {
  pin: 'pinned',
  canary: 'canary channel',
  stable: 'stable default',
} as const;

const CAPABILITY_LABEL: Record<string, string> = {
  create_container: 'Create containers',
  move_container: 'Move containers',
  create_account: 'Create accounts',
  update_account: 'Update accounts',
  rename_account: 'Rename accounts',
  enable_account: 'Enable accounts',
  disable_account: 'Disable accounts',
  archive_account: 'Archive accounts',
  grant_entitlement: 'Grant entitlements',
  revoke_entitlement: 'Revoke entitlements',
};

/** The "follow the channel" choice in the version select. */
const FOLLOW = '';

function problemOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback;
}

export function TargetAdapterPanel({ targetId }: { targetId: string }) {
  const { data, error, loading, reload } = useApiResource<AdapterReport>(
    `/api/admin/targets/${targetId}/adapter`,
  );
  const [channel, setChannel] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [rollbackReason, setRollbackReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideExpiry, setOverrideExpiry] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toast = useToast();

  // A read-only supplement to the editor: an older API without the route
  // must not take the page down.
  if (error || (data && (!Array.isArray(data.capabilities) || !data.selection))) return null;
  if (loading || !data) {
    return (
      <Panel title="Adapter release">
        <SkeletonRows rows={3} cols={2} />
      </Panel>
    );
  }

  const chosenChannel = channel ?? data.selection.channel;
  const chosenVersion = version ?? data.selection.pinnedVersion ?? FOLLOW;
  const effective = data.effective?.release ?? null;
  const deprecated = effective?.deprecationDate != null;

  async function submit(key: string, path: string, method: 'PUT' | 'POST', body: unknown, done: string) {
    setBusy(key);
    setProblem(null);
    setNotice(null);
    try {
      await api(`/api/admin/targets/${targetId}/${path}`, { method, body: JSON.stringify(body) });
      // Inline as well as a toast: a rollback or an override is a receipt
      // somebody may need to read back after the toast has gone.
      setNotice(done);
      toast({ tone: 'success', title: done.replace(/\.$/, '') });
      setReason('');
      setRollbackReason('');
      setOverrideReason('');
      setOverrideExpiry('');
      setChannel(null);
      setVersion(null);
      reload();
    } catch (cause) {
      setProblem(problemOf(cause, 'The adapter change could not be saved.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Adapter release"
      actions={
        effective ? (
          <StateBadge state={data.writesBlockedReason ? 'blocked' : data.warnings.length > 0 ? 'attention' : 'healthy'}>
            v{effective.adapterVersion} · {SOURCE_LABEL[data.effective!.source]}
          </StateBadge>
        ) : (
          <StateBadge state="blocked">Unresolved</StateBadge>
        )
      }
    >
      <div className="space-y-4 p-4">
        {data.writesBlockedReason && (
          <Alert tone="danger" title="New writes are blocked">
            {data.writesBlockedReason}
          </Alert>
        )}
        {data.warnings.length > 0 && !data.writesBlockedReason && (
          <Alert tone="warning" title="Readiness warning">
            <ul className="list-disc pl-5">
              {data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        )}
        <div aria-live="polite">
          {problem && <Alert tone="danger">{problem}</Alert>}
          {notice && <Alert tone="info">{notice}</Alert>}
        </div>

        {effective && (
          <p className="text-sm text-muted">
            Certification {effective.certification.status}: {effective.certification.evidence}
            {effective.deprecationDate ? ` · deprecated from ${effective.deprecationDate}` : ''}
          </p>
        )}

        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Certified writes">
          {data.capabilities.map((entry) => (
            <li key={entry.capability} className="flex items-start justify-between gap-3 text-sm">
              <span>
                {CAPABILITY_LABEL[entry.capability] ?? entry.capability}
                {entry.refusal && entry.certified && (
                  <span className="block text-xs text-muted">not advertised by this configuration</span>
                )}
              </span>
              <StateBadge state={entry.refusal === null ? 'healthy' : 'inactive'}>
                {entry.refusal === null ? 'allowed' : 'refused'}
              </StateBadge>
            </li>
          ))}
        </ul>

        <fieldset className="space-y-3 border-t border-border-subtle pt-4" disabled={busy !== null}>
          <legend className="font-medium text-ink">Rollout</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Channel"
              value={chosenChannel}
              onChange={setChannel}
              options={[
                { value: 'stable', label: 'Stable (catalog default)' },
                { value: 'canary', label: 'Canary (newest canary release)' },
              ]}
            />
            <Select
              label="Pinned release"
              value={chosenVersion}
              onChange={setVersion}
              options={[
                { value: FOLLOW, label: 'Follow the channel' },
                ...data.releases.map((r) => ({
                  value: r.adapterVersion,
                  label: `${r.adapterVersion} · ${r.channel} · certification ${r.certification.status}`,
                })),
              ]}
            />
          </div>
          <Field label="Reason for the rollout change" value={reason} onChange={setReason} />
          <Button
            loading={busy === 'select'}
            disabled={reason.trim().length < 10}
            onClick={() =>
              void submit(
                'select',
                'adapter',
                'PUT',
                { channel: chosenChannel, version: chosenVersion === FOLLOW ? null : chosenVersion, reason },
                'Adapter selection saved.',
              )
            }
          >
            Save rollout
          </Button>
        </fieldset>

        <fieldset className="space-y-3 border-t border-border-subtle pt-4" disabled={busy !== null}>
          <legend className="font-medium text-ink">Rollback</legend>
          {!data.selection.rollbackVersion && (
            <p className="text-sm text-muted">No earlier certified release recorded.</p>
          )}
          <Field label="Reason for the rollback" value={rollbackReason} onChange={setRollbackReason} />
          <Button
            variant="danger"
            loading={busy === 'rollback'}
            disabled={!data.selection.rollbackVersion || rollbackReason.trim().length < 10}
            onClick={() =>
              void submit('rollback', 'adapter/rollback', 'POST', { reason: rollbackReason }, 'Rolled back.')
            }
          >
            Roll back to {data.selection.rollbackVersion ?? 'previous release'}
          </Button>
        </fieldset>

        {(deprecated || data.deprecationOverride) && (
          <fieldset className="space-y-3 border-t border-border-subtle pt-4" disabled={busy !== null}>
            <legend className="font-medium text-ink">Deprecation override</legend>
            {data.deprecationOverride ? (
              <>
                <p className="text-sm">
                  {data.deprecationOverride.active ? 'Active' : 'Expired'} override for{' '}
                  {data.deprecationOverride.version}
                  {data.deprecationOverride.expiresAt
                    ? ` until ${new Date(data.deprecationOverride.expiresAt).toLocaleString()}`
                    : ''}
                  : {data.deprecationOverride.reason}
                </p>
                <Field label="Reason for ending the override" value={overrideReason} onChange={setOverrideReason} />
                <Button
                  variant="secondary"
                  loading={busy === 'clear'}
                  disabled={overrideReason.trim().length < 10}
                  onClick={() =>
                    void submit(
                      'clear',
                      'adapter/deprecation-override/clear',
                      'POST',
                      { reason: overrideReason },
                      'Override ended.',
                    )
                  }
                >
                  End override
                </Button>
              </>
            ) : (
              <>
                <Field label="Reason for the override" value={overrideReason} onChange={setOverrideReason} />
                <Field
                  label="Override expires (maximum 30 days)"
                  type="datetime-local"
                  value={overrideExpiry}
                  onChange={setOverrideExpiry}
                />
                <Button
                  loading={busy === 'override'}
                  disabled={overrideReason.trim().length < 10 || !overrideExpiry}
                  onClick={() =>
                    void submit(
                      'override',
                      'adapter/deprecation-override',
                      'POST',
                      { reason: overrideReason, expiresAt: new Date(overrideExpiry).toISOString() },
                      'Override recorded.',
                    )
                  }
                >
                  Record override
                </Button>
              </>
            )}
          </fieldset>
        )}
      </div>
    </Panel>
  );
}
