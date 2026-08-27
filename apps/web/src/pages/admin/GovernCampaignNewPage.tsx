import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Check, Field, Panel, Select } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

const RESOURCE_KINDS = [
  'targetEntitlement',
  'targetAccount',
  'syntraGroup',
  'application',
  'syntraRole',
  'syntraUser',
] as const;

/** Section 20's selectors, in the order somebody meets them. */
const SELECTORS = [
  'manager',
  'managerChain',
  'productOwner',
  'resourceOwner',
  'role',
  'group',
  'person',
];

interface ScopePreview {
  holdings: number;
  persons: number;
  systems: number;
  sample: { subjectKey: string; resourceName: string }[];
}

interface ReviewerPreview {
  resolved: number;
  viaFallback: number;
  blocked: number;
  blockedSample: { subjectKey: string; resourceName: string; reason: string }[];
}

const selectorOptions = SELECTORS.map((value) => ({ value, label: value }));

/**
 * Creating an access review.
 *
 * The whole module was inert from the console. `createCampaign`,
 * `startCampaign`, `rebaseCampaign` and both previews existed on the server
 * and had routes; nothing could invoke any of them, while the campaigns
 * page's empty state told the reader to create one. This screen is what makes
 * Govern a product rather than a set of endpoints.
 *
 * BOTH PREVIEWS ARE ON THE PAGE, above the create button, because section 20
 * asks for them there: "1,102 items resolve, 61 fall to the fallback, 17
 * resolve to nobody -- here they are" is the screen that catches an
 * unreviewable campaign before 200 people are emailed rather than at 3am on
 * the due date. They write nothing.
 */
export function GovernCampaignNewPage() {
  const navigate = useNavigate();
  const { data: snapshotList } = useApiResource<{
    snapshots: { id: string; asOf: string; status: string }[];
  }>('/api/admin/govern/snapshots?limit=25');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [systemIds, setSystemIds] = useState('');
  const [privilegedOnly, setPrivilegedOnly] = useState(false);
  const [reviewerSelector, setReviewerSelector] = useState('manager');
  const [fallbackSelector, setFallbackSelector] = useState('productOwner');
  const [ownerPersonId, setOwnerPersonId] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [allowBulkCertify, setAllowBulkCertify] = useState(false);
  const [snapshotId, setSnapshotId] = useState('');
  const [scopePreview, setScopePreview] = useState<ScopePreview | null>(null);
  const [reviewerPreview, setReviewerPreview] = useState<ReviewerPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleKind = (kind: string, on: boolean) => {
    const next = new Set(kinds);
    if (on) next.add(kind);
    else next.delete(kind);
    setKinds(next);
  };

  /**
   * The scope object both previews and the create call share.
   *
   * `resourceKinds` is `.min(1)` in `campaignScopeInput` and the button is
   * disabled without one, because a scope with an empty kind list covers
   * NOTHING -- "review the finance system" with no kinds ticked would create a
   * campaign over zero holdings that nobody could tell from a broken one.
   */
  const scope = () => ({
    resourceKinds: [...kinds],
    ...(systemIds.trim() === ''
      ? {}
      : {
          systemIds: systemIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
    ...(privilegedOnly ? { privilegedOnly: true } : {}),
  });

  const snapshotPart = () => (snapshotId === '' ? {} : { snapshotId });

  const report = (cause: unknown, fallback: string) =>
    setProblem(
      cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : fallback,
    );

  const previewScope = async () => {
    setProblem(null);
    try {
      setScopePreview(
        await api<ScopePreview>('/api/admin/govern/campaigns/preview-scope', {
          method: 'POST',
          body: JSON.stringify({ scope: scope(), ...snapshotPart() }),
        }),
      );
    } catch (cause) {
      report(cause, 'That scope could not be previewed.');
    }
  };

  const previewReviewers = async () => {
    setProblem(null);
    try {
      setReviewerPreview(
        await api<ReviewerPreview>('/api/admin/govern/campaigns/preview-reviewers', {
          method: 'POST',
          body: JSON.stringify({
            scope: scope(),
            reviewerSelector,
            reviewerConfig: {},
            fallbackSelector,
            fallbackConfig: {},
            ...snapshotPart(),
          }),
        }),
      );
    } catch (cause) {
      report(cause, 'The reviewers could not be resolved.');
    }
  };

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const created = await api<{ id: string }>('/api/admin/govern/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description.trim() === '' ? null : description,
          scope: scope(),
          reviewerSelector,
          reviewerConfig: {},
          fallbackSelector,
          fallbackConfig: {},
          ownerPersonId,
          opensAt,
          dueAt,
          allowBulkCertify,
          recurrence: null,
          ...snapshotPart(),
        }),
      });
      // A campaign is created as a DRAFT and generates nothing until it is
      // started, so the next screen is the one with the Start button on it.
      navigate(`/admin/govern/campaigns/${created.id}`);
    } catch (cause) {
      report(cause, 'That campaign could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const ready =
    name.trim() !== '' &&
    kinds.size > 0 &&
    ownerPersonId.trim() !== '' &&
    opensAt !== '' &&
    dueAt !== '';

  const snapshotOptions = [
    { value: '', label: 'Latest complete snapshot' },
    ...(snapshotList?.snapshots ?? []).map((s) => ({
      value: s.id,
      label: `${new Date(s.asOf).toLocaleString()} — ${s.status}`,
    })),
  ];

  return (
    <>
      <PageHeader
        title="New access review"
      />

      {problem && <Alert tone="danger">{problem}</Alert>}

      <Panel title="What it covers">
        <div className="space-y-4 p-4">
          <Field label="Name" value={name} onChange={setName} />
          <Field label="Description" value={description} onChange={setDescription} />

          <fieldset aria-label="Resource kinds" className="space-y-2">
            <legend className="mb-1.5 font-medium text-ink">Resource kinds</legend>
            {RESOURCE_KINDS.map((kind) => (
              <Check
                key={kind}
                checked={kinds.has(kind)}
                onChange={(on) => toggleKind(kind, on)}
                label={kind}
              />
            ))}
          </fieldset>

          <Field
            label="System ids"
            value={systemIds}
            onChange={setSystemIds}
          />
          <Check
            checked={privilegedOnly}
            onChange={setPrivilegedOnly}
            label="Privileged holdings only"
          />
          <Select
            label="Point in time"
            value={snapshotId}
            onChange={setSnapshotId}
            options={snapshotOptions}
          />

          <div>
            <Button onClick={() => void previewScope()} disabled={kinds.size === 0}>
              Show me what this covers
            </Button>
          </div>

          {scopePreview && (
            <Alert tone={scopePreview.holdings === 0 ? 'warning' : 'info'}>
              This scope covers {scopePreview.holdings.toLocaleString()} holdings across{' '}
              {scopePreview.persons.toLocaleString()} persons and {scopePreview.systems}{' '}
              systems.
              {scopePreview.sample.length > 0 && (
                <> For example: {scopePreview.sample.map((s) => s.resourceName).join(', ')}.</>
              )}
              {scopePreview.holdings === 0 && ' Nobody would have anything to review.'}
            </Alert>
          )}
        </div>
      </Panel>

      <div className="mt-6">
        <Panel
          title="Who reviews it"
        >
          <div className="space-y-4 p-4">
            <Select
              label="Reviewer"
              value={reviewerSelector}
              onChange={setReviewerSelector}
              options={selectorOptions}
            />
            <Select
              label="Fallback"
              value={fallbackSelector}
              onChange={setFallbackSelector}
              options={selectorOptions}
            />

            <div>
              <Button onClick={() => void previewReviewers()} disabled={kinds.size === 0}>
                Show me who would review it
              </Button>
            </div>

            {reviewerPreview && (
              <Alert tone={reviewerPreview.blocked === 0 ? 'info' : 'warning'}>
                {reviewerPreview.resolved.toLocaleString()} items resolve,{' '}
                {reviewerPreview.viaFallback.toLocaleString()} fall to the fallback, and{' '}
                {reviewerPreview.blocked.toLocaleString()} resolve to nobody.
                {reviewerPreview.blockedSample.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">
                    {reviewerPreview.blockedSample.map((row) => (
                      <li key={`${row.subjectKey}:${row.resourceName}`}>
                        {row.resourceName} — {row.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </Alert>
            )}
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="When">
          <div className="space-y-4 p-4">
            <Field label="Owner person id" value={ownerPersonId} onChange={setOwnerPersonId} />
            <Field label="Opens" type="date" value={opensAt} onChange={setOpensAt} />
            <Field label="Due" type="date" value={dueAt} onChange={setDueAt} />
            <Check
              checked={allowBulkCertify}
              onChange={setAllowBulkCertify}
              label="Allow bulk certify"
            />
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void create()}>
          Create the campaign
        </Button>
      </div>
    </>
  );
}
