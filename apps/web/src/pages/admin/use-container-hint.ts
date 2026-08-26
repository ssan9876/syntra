import { useEffect, useState } from 'react';
import { api } from '../../session/api.js';

export interface ContainerHint {
  targetId: string;
  targetName: string;
  container: string;
  fallbackUsed: boolean;
  missing: string[];
}

interface Target {
  id: string;
  name: string;
  enabled: boolean;
}

export interface HintFacts {
  givenName: string;
  familyName: string;
  department: string;
  jobTitle: string;
  costCentre: string;
  employer: string;
  location: string;
}

/** Long enough that typing a department does not fire a request per keystroke. */
const DEBOUNCE_MS = 400;

/**
 * Where each enabled target would create this person's account.
 *
 * The point of showing it is narrow and worth stating: this deployment applies
 * provisioning automatically, with no confirmation step, so the container a
 * contract resolves to is never reviewed by anybody before an account lands in
 * it. A department typed `Nursinng` produces a real OU with a real account in
 * it, and the cheapest moment to notice is while the field still has focus.
 *
 * One line per enabled target rather than one for the first. Two targets can
 * place the same person in different containers, and showing one of them would
 * be showing an answer that is true of half the system.
 *
 * Every failure is silent. A target with no account profile, a caller without
 * `provision.read`, a request that simply fails — all of them mean "no answer
 * available", and a form asking for a joiner is not the place to raise
 * configuration somebody did not come here to do. The server refuses nothing
 * on the strength of this; it is a hint, and its absence costs only the hint.
 */
export function useContainerHints(
  targets: Target[],
  facts: HintFacts,
): ContainerHint[] {
  const [hints, setHints] = useState<ContainerHint[]>([]);

  // Serialised rather than passed as an object, so the effect re-runs when the
  // VALUES change rather than on every render that rebuilds the literal.
  const key = JSON.stringify(facts);
  const enabled = targets.filter((t) => t.enabled);
  const targetKey = enabled.map((t) => `${t.id}:${t.name}`).join(',');

  useEffect(() => {
    if (enabled.length === 0) {
      setHints([]);
      return;
    }
    // Nothing to render a name from yet. Asking would return the fallback for
    // every target and tell the reader only that they have not typed anything.
    if (facts.givenName.trim() === '' && facts.department.trim() === '') {
      setHints([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all(
        enabled.map(async (target) => {
          try {
            const preview = await api<{
              container: string;
              fallbackUsed: boolean;
              missing: string[];
            }>(`/api/admin/targets/${target.id}/profile/preview-container`, {
              method: 'POST',
              body: JSON.stringify(facts),
            });
            return {
              targetId: target.id,
              targetName: target.name,
              ...preview,
            } satisfies ContainerHint;
          } catch {
            return null;
          }
        }),
      ).then((results) => {
        if (cancelled) return;
        setHints(results.filter((r): r is ContainerHint => r !== null));
      });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, targetKey]);

  return hints;
}
