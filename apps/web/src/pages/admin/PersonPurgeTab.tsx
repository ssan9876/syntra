import { useState } from 'react';
import { Alert, Button, Field, Panel, SkeletonRows } from '@syntra/ui';
import { useCan } from '../../session/SessionProvider.js';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface Policy {
  afterDays: number | null;
}

/**
 * Automatic deletion of people who left. Readable by anyone who can read
 * people; changed only by a holder of `person.purge` (the Data deletion
 * role), because switching it on deletes people.
 */
export function PersonPurgeTab() {
  const can = useCan();
  const mayChange = can('person.purge');
  const { data, error, loading, reload } = useApiResource<Policy>('/api/admin/person-purge-policy');
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const text = edited ?? (data?.afterDays === null || data === null ? '' : String(data.afterDays));
  const parsed = text.trim() === '' ? null : Number(text);
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await api('/api/admin/person-purge-policy', { method: 'PUT', body: JSON.stringify({ afterDays: parsed }) });
      setNotice({ tone: 'success', text: parsed === null ? 'Automatic deletion off.' : `People are deleted ${parsed} days after they leave.` });
      setEdited(null);
      reload();
    } catch (cause) {
      setNotice({ tone: 'danger', text: cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'Not saved.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div aria-live="polite">{notice && <Alert tone={notice.tone}>{notice.text}</Alert>}</div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Panel title="Delete people who left">
        {loading && <SkeletonRows rows={1} cols={1} />}
        {data && (
          <div className="space-y-3 p-4">
            <Field
              label="Days after leaving"
              value={text}
              onChange={setEdited}
              placeholder="Never"
              inputMode="numeric"
              disabled={!mayChange}
              error={invalid ? 'A whole number from 1 to 3650, or empty for never' : undefined}
              warning={
                mayChange
                  ? undefined
                  : 'Only a holder of the Data deletion role can change this.'
              }
            />
            {mayChange && (
              <Button variant="primary" loading={busy} disabled={invalid || edited === null} onClick={() => void save()}>
                Save
              </Button>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
