import { useState } from 'react';
import { Alert, Button, Check, Field, Panel, SkeletonRows } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';

interface Category {
  key: string;
  label: string;
  description: string;
  actions: string[];
  emailEnabled: boolean;
}

interface Policy {
  emailCategories: string[];
  alertDays: number[];
  categories: Category[];
}

/** Parses "30, 14, 7, 1" into days, or null when any part is not a whole number 1..365. */
export function parseAlertDays(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 8) return null;
  const days = parts.map(Number);
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 365)) return null;
  return [...new Set(days)].sort((a, b) => b - a);
}

/**
 * The security notification policy (backlog #52): which customer-visible
 * security events also email every `tenant.manage` holder, and the days
 * before a credential's expiry at which the scan warns.
 *
 * Every category is delivered to webhooks already; what is chosen here is
 * only the mail. The events behind each category come from the server, so
 * this screen and configure.md's policy table cannot disagree.
 */
export function SecurityAlertsTab() {
  const { data, error, loading, reload } = useApiResource<Policy>('/api/admin/security-notifications');
  // Null until somebody edits, so the saved policy is what renders first --
  // never an empty form that flips to the real values a frame later.
  const [edited, setEdited] = useState<Set<string> | null>(null);
  const [editedDays, setDays] = useState<string | null>(null);
  const chosen = edited ?? new Set(data?.emailCategories ?? []);
  const days = editedDays ?? (data?.alertDays ?? []).join(', ');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  const parsedDays = parseAlertDays(days);

  async function save() {
    if (!parsedDays) return;
    setBusy(true);
    setNotice(null);
    try {
      await api('/api/admin/security-notifications', {
        method: 'PUT',
        body: JSON.stringify({ emailCategories: [...chosen].sort(), alertDays: parsedDays }),
      });
      setNotice({ tone: 'success', text: 'Security notification policy saved.' });
      setEdited(null);
      setDays(null);
      reload();
    } catch (cause) {
      setNotice({
        tone: 'warning',
        text: cause instanceof ApiError ? (cause.problem.detail ?? cause.problem.title) : 'The policy was not saved.',
      });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    setEdited(next);
  };

  return (
    <div className="space-y-4">
      <div aria-live="polite">{notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}</div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!error && (
        <Panel title="Email administrators about">
          {loading && <SkeletonRows rows={6} cols={1} />}
          {data && (
            <ul className="divide-y divide-border-subtle">
              {data.categories.map((category) => (
                <li key={category.key} className="p-4">
                  <Check
                    label={category.label}
                    checked={chosen.has(category.key)}
                    onChange={(on) => toggle(category.key, on)}
                  />
                  <p className="mt-1 max-w-[72ch] pl-6.5 text-sm text-muted">{category.description}</p>
                  <p className="mt-0.5 pl-6.5 font-mono text-xs text-muted">{category.actions.join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
      {data && (
        <Panel title="Credential expiry warnings">
          <div className="space-y-3 p-4">
            <Field
              label="Warn this many days before expiry"
              value={days}
              onChange={setDays}
              error={parsedDays ? undefined : 'Up to eight whole numbers between 1 and 365, separated by commas.'}
            />
            <Button variant="primary" loading={busy} disabled={!parsedDays} onClick={() => void save()}>
              Save policy
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
