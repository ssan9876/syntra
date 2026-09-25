import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Panel, StateBadge, Table, type State } from '@syntra/ui';
import { receiptStage } from './lifecycle-verdict.js';

/**
 * Marks a `Field`, `Select` or picker as required, visually.
 *
 * The control itself carries `required`, which is what a screen reader
 * announces; this adds the asterisk for everybody else. The `/ ''` is CSS
 * alternative text for generated content, so the asterisk is not ALSO read
 * out as "star" beside the announced "required". Applied to the wrapper
 * because the label is the wrapper's first child and the primitives take
 * the label as a string.
 */
export const REQUIRED = "[&>label]:after:ml-0.5 [&>label]:after:text-danger [&>label]:after:content-['*'_/_'']";

/**
 * A provisioning receipt's status, in the words the onboarding receipt uses.
 *
 * Three different claims that the old receipt printed as raw status words:
 * PLANNED (Syntra has decided what to do, nothing written), APPLIED (the
 * target accepted a write and Syntra is waiting to read it back) and
 * OBSERVED (read back from the target). Only the last means the person can
 * sign in, and only the last is green.
 */
export function receiptState(receipt: { status: string; message: string | null }): { state: State; label: string } {
  switch (receiptStage(receipt)) {
    case 'observed': return { state: 'healthy', label: 'Observed' };
    case 'awaiting_read_back': return { state: 'pending', label: 'Applied, awaiting read-back' };
    case 'applying': return { state: 'running', label: 'Applying' };
    case 'no_account': return { state: 'inactive', label: 'No requirement' };
    case 'intervention': return { state: 'blocked', label: 'Needs intervention' };
    default: return { state: 'pending', label: 'Planned' };
  }
}

export interface ReceiptRow {
  key: string;
  title: string;
  state: State;
  label: string;
  evidence?: ReactNode;
}

/** What one submission wrote, one row per thing, each with its state. */
export function OnboardingReceipt({ title = 'Receipt', rows, actions }: { title?: string; rows: ReceiptRow[]; actions?: ReactNode }) {
  return <Panel title={title} actions={actions}>
    <Table>
      <caption className="sr-only">{title}</caption>
      <thead><tr><th scope="col">Step</th><th scope="col">State</th><th scope="col">Evidence</th></tr></thead>
      <tbody aria-live="polite">
        {rows.map((row) => <tr key={row.key}>
          <td className="text-ink">{row.title}</td>
          <td><StateBadge state={row.state}>{row.label}</StateBadge></td>
          <td className="text-sm">{row.evidence ?? '—'}</td>
        </tr>)}
      </tbody>
    </Table>
  </Panel>;
}

/** The evidence cell of a target receipt: its message and its exact run. */
export function receiptEvidence(receipt: { targetSystemId: string; runId: string | null; message: string | null }) {
  if (!receipt.runId && !receipt.message) return undefined;
  return <>
    {receipt.message && <span className="block text-muted">{receipt.message}</span>}
    {receipt.runId && <Link className="link" to={`/admin/targets/${receipt.targetSystemId}/runs/${receipt.runId}`}>Review exact run</Link>}
  </>;
}
