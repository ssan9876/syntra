import { withTenant } from '@syntra/db';
import { personDisplayName } from './desired.js';
import { renderContainer, type TemplateContext } from './templates.js';

/**
 * Where a joiner's account would be created, answered before they exist.
 *
 * `previewAccountProfile` already previews a profile, and takes a `personId` to
 * do it. That is exactly what the onboarding form cannot supply: the form's
 * whole purpose is showing an administrator where somebody will land while
 * that is still free to correct, which is necessarily before the person has
 * been written. So this renders from the values typed into the form instead.
 *
 * It goes through `renderContainer` rather than a second renderer, and that is
 * the load-bearing part. The container is a distinguished name composed out of
 * HR-supplied strings, and the escaping is structural: a department of
 * `Finance,OU=Domain Controllers` is not a mangled DN, it is a DIFFERENT one.
 * A preview that rendered it any other way would show the wrong answer on the
 * one screen somebody checks it on, which is worse than being silently wrong
 * somewhere nobody looks.
 *
 * Deliberately reads rather than writes, and answers `null` — not an error —
 * for a target with no profile or no such target. A form asking "where will
 * this go" gets "no answer available" and shows nothing; it is not the place
 * to raise configuration somebody did not come here to do.
 */
export interface ContainerPreviewFacts {
  givenName: string;
  familyName: string;
  // `| undefined` on each, deliberately: `exactOptionalPropertyTypes` is on
  // repo-wide, and the caller is a zod-parsed body where an omitted optional
  // field is `undefined` rather than absent. Widening here permits strictly
  // more and changes no behaviour — `blank()` below folds both to null.
  businessEmail?: string | null | undefined;
  personalEmail?: string | null | undefined;
  department?: string | null | undefined;
  jobTitle?: string | null | undefined;
  costCentre?: string | null | undefined;
  employer?: string | null | undefined;
  location?: string | null | undefined;
}

export interface ContainerPreview {
  /** The rendered DN, or the fallback container when rendering failed. */
  container: string;
  fallbackUsed: boolean;
  /** Placeholders that resolved to nothing, e.g. `contract.department`. */
  missing: string[];
}

export async function previewContainerForFacts(
  tenantId: string,
  targetSystemId: string,
  facts: ContainerPreviewFacts,
): Promise<ContainerPreview | null> {
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findUnique({
      where: { id: targetSystemId },
      select: { id: true, config: true },
    });
    if (!target) return null;

    const profile = await tx.accountProfile.findFirst({
      where: { targetSystemId },
      select: { containerTemplate: true, fallbackContainer: true },
    });
    if (!profile) return null;

    const person = {
      givenName: facts.givenName,
      familyName: facts.familyName,
      businessEmail: facts.businessEmail ?? null,
      personalEmail: facts.personalEmail ?? null,
      // Not a stored field on an unsaved person. `desiredState` reads the
      // person's own convention; a form has not chosen one, so the default
      // stands and `displayName` is composed the same way either path does.
      nameConvention: 'familyName',
      displayName: personDisplayName({
        givenName: facts.givenName,
        familyName: facts.familyName,
      } as Parameters<typeof personDisplayName>[0]),
      status: 'active',
    };

    // The same shape `desiredState` builds, so a preview and a run cannot
    // disagree about what a template resolves to. An empty string is NOT the
    // same as absent here: a blank department should report as missing and
    // fall back, not render `OU=,OU=Users,...`.
    const blank = (value: string | null | undefined) =>
      value === undefined || value === null || value.trim() === '' ? null : value;

    const context: TemplateContext = {
      person,
      contract: {
        department: blank(facts.department),
        jobTitle: blank(facts.jobTitle),
        costCentre: blank(facts.costCentre),
        employer: blank(facts.employer),
        location: blank(facts.location),
      },
      baseDn: (target.config as { baseDn?: string }).baseDn ?? '',
    };

    const rendered = renderContainer(profile.containerTemplate, context);
    if (rendered.ok) {
      return { container: rendered.value, fallbackUsed: false, missing: [] };
    }
    // `fallbackContainer` is a literal and is not rendered, exactly as
    // `desiredState` treats it.
    return {
      container: profile.fallbackContainer,
      fallbackUsed: true,
      missing: rendered.missing,
    };
  });
}
