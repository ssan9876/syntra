import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type ApplicationVisibility = 'assigned' | 'hidden';

export interface CreateApplicationInput {
  name: string;
  slug: string;
  description?: string | null | undefined;
  iconUrl?: string | null | undefined;
  launchUrl?: string | null | undefined;
  /** 'bookmark' today. Access II adds 'saml' and 'oidc'. */
  type?: string | undefined;
  visibility?: ApplicationVisibility | undefined;
}

export async function createApplication(
  tx: TenantClient,
  input: CreateApplicationInput,
) {
  const existing = await tx.application.findFirst({ where: { slug: input.slug } });
  if (existing) {
    // Checked explicitly rather than left to the unique constraint, so the
    // caller gets a domain error it can map to 409 instead of a driver error.
    throw new Error(`slug already exists: ${input.slug}`);
  }
  const tenantId = await currentTenant(tx);
  return tx.application.create({
    data: {
      tenantId,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      iconUrl: input.iconUrl ?? null,
      launchUrl: input.launchUrl ?? null,
      type: input.type ?? 'bookmark',
      visibility: input.visibility ?? 'assigned',
    },
  });
}

export async function updateApplication(
  tx: TenantClient,
  id: string,
  input: Partial<CreateApplicationInput> & { status?: string | undefined },
) {
  return tx.application.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl }),
      // `type` was accepted by `updateApplicationRequest` and dropped here, so
      // PUT answered 200 and changed nothing — and the only way to turn a
      // bookmark into a SAML application was to delete it and create it again,
      // losing its assignments. Registering a service provider against an
      // application somebody had already created was impossible through the
      // API, and the API said it had worked.
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.launchUrl === undefined ? {} : { launchUrl: input.launchUrl }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  });
}

export async function listApplications(tx: TenantClient) {
  return tx.application.findMany({ orderBy: { name: 'asc' } });
}

export async function findApplication(tx: TenantClient, id: string) {
  return tx.application.findUnique({ where: { id } });
}
