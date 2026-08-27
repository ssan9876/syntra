import type { ReactNode } from 'react';

/**
 * The top of every console page: what this is, and what you can do to it.
 *
 * The description is gone, and the prop with it. Fifty-five pages carried one,
 * and read together they were an argument against themselves: several existed
 * only to explain a split in the navigation ("their sign-in accounts are
 * listed under Users"), several restated the title in a longer sentence, and
 * the rest described what the table underneath already showed. A reader
 * arriving mid-task confirms where they are in one glance and stops looking —
 * a paragraph they never read is a paragraph that pushed the content down.
 *
 * The prop is removed rather than left unused on purpose. An optional
 * `description` that nobody passes is an invitation, and this came back once
 * already. Anything genuinely load-bearing has somewhere better to be: a
 * consequence belongs on the control it affects as a `warning`, a value
 * belongs in the body as a labelled value, and an explanation of the
 * navigation means the navigation is wrong.
 */
export function PageHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <h1 className="min-w-0 text-xl font-semibold text-ink">{title}</h1>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export interface Fact {
  label: string;
  value: ReactNode;
}

/**
 * The facts that identify a record, under its title.
 *
 * Removing `description` turned up three pages where the prop was not
 * carrying prose at all — it held the source a run belonged to, the instant a
 * snapshot was assembled, an application's client ID. Deleting those with the
 * sentences around them would have lost real information, so they get a shape
 * of their own.
 *
 * It is a list of label/value pairs and not a slot for free text, and that is
 * the entire point. `description` was removed because an open slot next to a
 * title gets filled, and eventually filled with a paragraph; a pair cannot
 * become a paragraph without looking obviously wrong. The constraint is the
 * design.
 */
export function PageFacts({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="-mt-2 mb-5 flex flex-wrap gap-x-8 gap-y-2">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt className="text-sm font-medium text-muted">{fact.label}</dt>
          <dd className="mt-0.5 font-medium text-ink tabular-nums">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
