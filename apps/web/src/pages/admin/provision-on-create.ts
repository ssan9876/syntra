import { api } from '../../session/api.js';

/** The status a run carries while its plan is still being computed. */
const PLANNING = 'running';

export interface PollOptions {
  /** How many times to look before leaving the run to the run page. */
  attempts?: number;
  intervalMs?: number;
}

const DEFAULTS = { attempts: 20, intervalMs: 1500 } as const;

const wait = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs one target and applies only what it proposed for one person.
 *
 * Separate from the page because it is not page logic: it is a small
 * state machine over four endpoints, with two failure modes that are worth
 * testing directly and neither of which is about rendering.
 *
 * **The scoping is load-bearing.** A run is computed over the WHOLE target, so
 * applying it wholesale would also commit every disable and archive pending
 * for everybody else — actions nobody reviewed, committed on the strength of
 * an unrelated person being hired. `only` restricts the apply to the actions
 * carrying this person's id and leaves the rest of the plan where it was.
 *
 * `confirm` is left at its default of false. A joiner's actions are additive
 * and trip no guard; anything that does trip one stays unapplied and surfaces
 * on the run page, which is where somebody should be looking at it anyway.
 *
 * The run list is newest-first and the enqueue is asynchronous, so the id
 * present BEFORE enqueueing is captured and waited past. Without that the
 * first poll reads the PREVIOUS run — quite possibly a previewed one full of
 * somebody else's pending actions — and applies it.
 *
 * Returns how many actions were applied. Zero is an ordinary answer: no rule
 * matched their contract, or the run did not finish planning in time.
 */
export async function provisionForPerson(
  targetId: string,
  personId: string,
  options: PollOptions = {},
): Promise<number> {
  const { attempts, intervalMs } = { ...DEFAULTS, ...options };

  const previous = await api<{ runs: { id: string; status: string }[] }>(
    `/api/admin/targets/${targetId}/runs`,
  );
  const before = previous.runs[0]?.id ?? null;

  await api(`/api/admin/targets/${targetId}/runs`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(intervalMs);
    const { runs } = await api<{ runs: { id: string; status: string }[] }>(
      `/api/admin/targets/${targetId}/runs`,
    );
    const latest = runs[0];
    if (!latest || latest.id === before || latest.status === PLANNING) continue;

    const detail = await api<{ actions: { id: string; personId: string | null }[] }>(
      `/api/admin/targets/${targetId}/runs/${latest.id}`,
    );
    const only = detail.actions
      .filter((action) => action.personId === personId)
      .map((action) => action.id);
    // Applying an empty set is a write for no reason.
    if (only.length === 0) return 0;

    await api(`/api/admin/targets/${targetId}/runs/${latest.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ only }),
    });
    return only.length;
  }

  // Bounded on purpose. A target that will not finish planning must not hold
  // onboarding open indefinitely; the run continues server-side either way.
  return 0;
}
