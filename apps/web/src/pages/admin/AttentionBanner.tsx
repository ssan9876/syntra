import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@syntra/ui';
import { api } from '../../session/api.js';
import {
  ATTENTION_TAB,
  ATTENTION_URL,
  attentionHeadline,
  attentionSignature,
  changeRequestSentence,
  lifecycleSentences,
  runSentence,
  type AttentionSummary,
} from './attention.js';

const POLL_MS = 60_000;
/** Runs named in the banner itself; the rest are one click away on Attention. */
const RUNS_SHOWN = 3;
const DISMISSED_KEY = 'syntra.attention.dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(signature: string) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, signature);
  } catch {
    // Storage refused (a private window, a policy): the dismissal lasts
    // until the next render that sees something new, which is acceptable.
  }
}

/**
 * Work waiting for a person, on every console page.
 *
 * A run the guard held — "would create 1 of 2 accounts (50.0%), above the 20%
 * threshold", "the first run is confirmed by a person" — used to be visible
 * only on the target's own run list, and nothing sent anybody there. Every
 * onboarding on that target then waited behind it. This names the target and
 * what the run would do, and links to the run.
 *
 * Follows `BreakGlassBanner`: polls once a minute, and a failed poll hides
 * nothing it already showed. Unlike that banner it can be dismissed, for the
 * session and for the items it showed only — anything new brings it back.
 * `role="status"`, polite: this is work to pick up, not an emergency, and a
 * screen reader should not be interrupted by it on every page load.
 */
export function AttentionBanner() {
  const [summary, setSummary] = useState<AttentionSummary | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());

  useEffect(() => {
    let alive = true;
    const load = () => api<AttentionSummary>(ATTENTION_URL)
      .then((next) => { if (alive) setSummary(next); })
      .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!summary || summary.total === 0) return null;
  const signature = attentionSignature(summary);
  if (dismissed === signature) return null;

  const runs = summary.provisionRuns;
  const moreRuns = runs ? runs.count - Math.min(runs.items.length, RUNS_SHOWN) : 0;
  const lifecycle = summary.lifecycle ? lifecycleSentences(summary.lifecycle) : [];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Work that needs your attention"
      className="mb-4 rounded-panel border border-warning/35 bg-warning-soft px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="font-semibold text-warning">{attentionHeadline(summary.total)}</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => { writeDismissed(signature); setDismissed(signature); }}
        >
          Dismiss for this session
        </Button>
      </div>
      <ul className="mt-1 space-y-1 text-ink">
        {runs?.items.slice(0, RUNS_SHOWN).map((item) => (
          <li key={item.runId}>
            {runSentence(item)}.{' '}
            <Link className="link" to={item.href}>Review the run</Link>
          </li>
        ))}
        {moreRuns > 0 && (
          <li>
            {moreRuns} more provisioning {moreRuns === 1 ? 'run is' : 'runs are'} waiting for review.
          </li>
        )}
        {lifecycle.map((line) => (
          <li key={line}>
            {line}.{' '}
            <Link className="link" to="/admin/employee-work">Open employee work</Link>
          </li>
        ))}
        {(summary.changeRequests?.count ?? 0) > 0 && (
          <li>
            {changeRequestSentence(summary.changeRequests!.count)}.{' '}
            <Link className="link" to="/admin/settings?tab=change-control">Open change control</Link>
          </li>
        )}
      </ul>
      <p className="mt-2 text-sm">
        <Link className="link" to={ATTENTION_TAB}>See everything in Activity → Attention</Link>
      </p>
    </div>
  );
}
