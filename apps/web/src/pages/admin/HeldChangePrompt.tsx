import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Field } from '@syntra/ui';
import { onChangeApprovalRequired, type Problem } from '../../session/api.js';

const REASON_MIN = 10;

interface Pending {
  problem: Problem;
  resolve: (reason: string | null) => void;
}

/**
 * Asks for the reason a held privileged change needs, for every form in the
 * console at once.
 *
 * When the tenant holds a class of change for a second administrator, the
 * server answers the first attempt `409 change-approval-required` and writes
 * nothing. `api()` hands that here; given a reason it sends the same request
 * again with it, and the change is stored for approval. No form has to know
 * which of its changes are held.
 */
export function HeldChangePrompt() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => onChangeApprovalRequired((problem) => new Promise((resolve) => {
    setReason('');
    setPending({ problem, resolve });
  })), []);

  useEffect(() => {
    if (pending) field.current?.focus();
  }, [pending]);

  if (!pending) return null;

  const finish = (value: string | null) => {
    pending.resolve(value);
    setPending(null);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length >= REASON_MIN) finish(reason.trim());
  };
  const summary = typeof pending.problem.summary === 'string' ? pending.problem.summary : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="held-change-title"
        onSubmit={submit}
        onKeyDown={(event) => { if (event.key === 'Escape') finish(null); }}
        className="w-full max-w-md space-y-4 rounded-panel border border-border-subtle bg-bg p-6 shadow-lg"
      >
        <h2 id="held-change-title" className="text-lg font-semibold text-ink">{pending.problem.title}</h2>
        {summary ? <p className="text-sm text-ink">{summary}</p> : null}
        <p className="text-sm text-muted">{pending.problem.detail}</p>
        <Field
          ref={field}
          label="Reason for the approver"
          value={reason}
          onChange={setReason}
          warning={reason.trim().length > 0 && reason.trim().length < REASON_MIN ? `At least ${REASON_MIN} characters` : undefined}
        />
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="secondary" onClick={() => finish(null)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={reason.trim().length < REASON_MIN}>Send for approval</Button>
        </div>
      </form>
    </div>
  );
}
