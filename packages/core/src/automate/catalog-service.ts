// `Prisma` and the row types come through `@syntra/db`, which re-exports them.
// `packages/core` deliberately does not depend on `@prisma/client` directly:
// not declaring it is what makes `new PrismaClient()` unresolvable here, and
// therefore what makes `withTenant` the only route to the database.
import { Prisma, withTenant, type Product, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';
import { activeContracts } from '../identity/contract-service.js';
import type { ConditionFacts } from '../provision/condition.js';
import {
  audienceAdmits,
  audienceConditionSchema,
  type AudienceCondition,
  type SubjectSetFacts,
} from './audience.js';
import { formSchemaSchema, type FormSchema } from './form.js';
import type { DurationMode } from './duration.js';
import {
  LIVE_GRANT_STATUSES,
  RESOURCE_TYPE_FOR_KIND,
  type ProductKind,
  type ResourceType,
} from './types.js';

/**
 * A configuration the catalog refuses, with a code the API turns into a
 * problem type and the console turns into a message against the right field.
 */
export class ProductConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProductConfigurationError';
  }
}

export interface ProductGrantInput {
  resourceType: ResourceType;
  resourceId: string;
  targetSystemId?: string | null;
  optional?: boolean;
}

export interface ProductInput {
  name: string;
  slug: string;
  description?: string | null;
  category?: string | null;
  iconUrl?: string | null;
  requestInstructions?: string | null;
  kind: ProductKind;
  grants: ProductGrantInput[];
  /** NULL MEANS NOBODY. */
  audienceCondition: AudienceCondition | null;
  workflowId: string;
  formSchema: FormSchema;
  durationMode: DurationMode;
  defaultDurationDays: number | null;
  maxDurationDays: number | null;
  ownerPersonId: string | null;
  ownerGroupId: string | null;
  status: 'draft' | 'active' | 'retired';
}

/**
 * Everything a product's configuration is refused for, in one place, so the
 * create path and the update path cannot disagree about what is legal.
 */
async function validateProduct(tx: TenantClient, input: ProductInput): Promise<void> {
  if (input.audienceCondition !== null) {
    audienceConditionSchema.parse(input.audienceCondition);
  }
  formSchemaSchema.parse(input.formSchema);

  if (input.grants.length === 0) {
    throw new ProductConfigurationError(
      'no-grants',
      'A product has to grant something. Name at least one resource.',
    );
  }

  const expected = RESOURCE_TYPE_FOR_KIND[input.kind];
  for (const grant of input.grants) {
    if (grant.resourceType !== expected) {
      throw new ProductConfigurationError(
        'kind-mismatch',
        `A ${input.kind} product grants ${expected} resources, not ${grant.resourceType}.`,
      );
    }
  }

  if (input.kind === 'targetEntitlement') {
    const targets = new Set(input.grants.map((g) => g.targetSystemId ?? ''));
    if (targets.size > 1) {
      throw new ProductConfigurationError(
        'bundle-spans-targets',
        'Every entitlement in one product must belong to the same target system, so a single Provision run can fulfil the whole request.',
      );
    }
    const entitlements = await tx.entitlement.findMany({
      where: { id: { in: input.grants.map((g) => g.resourceId) } },
      select: { id: true, displayName: true, requestable: true, targetSystemId: true },
    });
    for (const grant of input.grants) {
      const entitlement = entitlements.find((e) => e.id === grant.resourceId);
      if (entitlement === undefined) {
        throw new ProductConfigurationError(
          'entitlement-missing',
          'One of the entitlements named here no longer exists on that target.',
        );
      }
      if (!entitlement.requestable) {
        throw new ProductConfigurationError(
          'entitlement-not-requestable',
          `${entitlement.displayName} is not marked requestable. Publish it on the target's catalog first.`,
        );
      }
      if (entitlement.targetSystemId !== grant.targetSystemId) {
        throw new ProductConfigurationError(
          'entitlement-target-mismatch',
          `${entitlement.displayName} does not belong to the target system named here.`,
        );
      }
    }
  }

  if (input.kind === 'localGroup') {
    const groups = await tx.group.findMany({
      where: { id: { in: input.grants.map((g) => g.resourceId) } },
      include: { source: { select: { name: true } } },
    });
    for (const grant of input.grants) {
      const group = groups.find((g) => g.id === grant.resourceId);
      if (group === undefined) {
        throw new ProductConfigurationError(
          'group-missing',
          'One of the groups named here no longer exists.',
        );
      }
      // A synced group's membership is rewritten by its source every run. A
      // request-granted membership would survive until the small hours and
      // then vanish, which is worse than refusing it here. The correct way to
      // request one is as the targetEntitlement it corresponds to.
      if (group.sourceId !== null) {
        throw new ProductConfigurationError(
          'group-is-synced',
          `${group.name} is owned by the directory source ${group.source?.name ?? 'unknown'}, which rewrites its membership on every run. Request the target entitlement it comes from instead.`,
        );
      }
    }
  }

  const workflow = await tx.approvalWorkflow.findUnique({
    where: { id: input.workflowId },
    select: { id: true },
  });
  if (workflow === null) {
    throw new ProductConfigurationError(
      'workflow-missing',
      'That approval workflow does not exist.',
    );
  }
}

function productData(input: ProductInput, tenantId: string) {
  return {
    tenantId,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    category: input.category ?? null,
    iconUrl: input.iconUrl ?? null,
    requestInstructions: input.requestInstructions ?? null,
    kind: input.kind,
    // `Prisma.DbNull`, NOT `undefined`. Prisma reads `undefined` as "do not
    // touch this column", so `?? undefined` is harmless on create -- the
    // column defaults to NULL -- and on UPDATE it makes clearing the audience
    // impossible: an administrator editing a product to be visible to nobody
    // gets a product whose previous audience is still in force. This is the
    // one field in the slice whose default IS the access control (Global
    // Constraint 11: NULL means NOBODY), and a control that cannot be reset is
    // a control that is not there.
    audienceCondition: (input.audienceCondition ?? Prisma.DbNull) as never,
    workflowId: input.workflowId,
    // `as never` because `FormSchema = FormField[]` and `FormField` is an
    // `interface`, which TypeScript never gives an implicit index signature,
    // so it is not assignable to `Prisma.InputJsonValue` (Global Constraint
    // 21). The repository's convention, per `sync/source-service.ts:41`.
    formSchema: input.formSchema as never,
    durationMode: input.durationMode,
    defaultDurationDays: input.defaultDurationDays,
    maxDurationDays: input.maxDurationDays,
    ownerPersonId: input.ownerPersonId,
    ownerGroupId: input.ownerGroupId,
    status: input.status,
  };
}

export async function createProduct(
  tenantId: string,
  actorUserId: string | null,
  input: ProductInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    await validateProduct(tx, input);
    const created = await tx.product.create({ data: productData(input, tenantId) });
    await tx.productGrant.createMany({
      data: input.grants.map((grant) => ({
        tenantId,
        productId: created.id,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId ?? null,
        optional: grant.optional ?? false,
      })),
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.product.create',
      targetType: 'Product',
      targetId: created.id,
      outcome: 'success',
      sourceIp: null,
      payload: {
        slug: input.slug,
        kind: input.kind,
        status: input.status,
        audienceCondition: input.audienceCondition,
        grants: input.grants.map((g) => `${g.resourceType}:${g.resourceId}`),
      },
    });
    return { id: created.id };
  });
}

/**
 * Replaces a product whole.
 *
 * The audit payload carries before and after, because a product's workflow
 * edited from two stages to zero is functionally the same act as approving
 * everything that product will ever grant, and the record of it has to survive
 * the edit.
 */
export async function updateProduct(
  tenantId: string,
  actorUserId: string | null,
  productId: string,
  input: ProductInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await validateProduct(tx, input);
    const before = await tx.product.findUnique({
      where: { id: productId },
      include: { grants: true },
    });
    if (before === null) {
      throw new ProductConfigurationError('not-found', 'That product does not exist.');
    }

    await tx.product.update({ where: { id: productId }, data: productData(input, tenantId) });
    await tx.productGrant.deleteMany({ where: { productId } });
    await tx.productGrant.createMany({
      data: input.grants.map((grant) => ({
        tenantId,
        productId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
        targetSystemId: grant.targetSystemId ?? null,
        optional: grant.optional ?? false,
      })),
    });

    await recordEvent(tx, {
      actorUserId,
      action: 'automate.product.update',
      targetType: 'Product',
      targetId: productId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        before: {
          status: before.status,
          workflowId: before.workflowId,
          audienceCondition: before.audienceCondition,
          grants: before.grants.map((g) => `${g.resourceType}:${g.resourceId}`),
        },
        after: {
          status: input.status,
          workflowId: input.workflowId,
          audienceCondition: input.audienceCondition,
          grants: input.grants.map((g) => `${g.resourceType}:${g.resourceId}`),
        },
      },
    });
  });
}

/** Every product, for the console. Behind `automate.read`, never the portal. */
export async function listAllProducts(tx: TenantClient) {
  return tx.product.findMany({ include: { grants: true }, orderBy: { name: 'asc' } });
}

export interface SubjectAudienceFacts extends SubjectSetFacts {
  contracts: ConditionFacts[];
  hasActiveContract: boolean;
  personStatus: string;
}

/**
 * The org unit a user sits in, and every unit above it.
 *
 * A local walk rather than a call into `access/resolve.ts`, whose `orgUnitChain`
 * is module-private and not exported. The depth cap and the seen-set are the
 * same, and for the same reason: `parentId` is a self-relation with no
 * database-level acyclicity check.
 */
export async function orgUnitChainFor(
  tx: TenantClient,
  orgUnitId: string | null,
): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = orgUnitId;

  for (let depth = 0; current !== null && depth < 64; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    const row = await tx.orgUnit.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = row?.parentId ?? null;
  }
  return chain;
}

/**
 * Everything the audience evaluator needs about one person, read once.
 *
 * `entitlementIds` counts both what the target actually holds and what a LIVE
 * grant says they hold. A grant Provision has not applied yet still counts:
 * the person asked, somebody accountable approved, and a second product
 * gated on the first should be offerable now rather than after the next run.
 */
export async function subjectAudienceFacts(
  tx: TenantClient,
  personId: string,
  on: Date,
): Promise<SubjectAudienceFacts> {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { status: true },
  });
  const contracts = await activeContracts(tx, personId, on);
  const users = await tx.user.findMany({
    where: { personId },
    select: { id: true, orgUnitId: true },
  });

  const groupIds = new Set<string>();
  const orgUnitChainIds = new Set<string>();
  for (const user of users) {
    const memberships = await tx.groupMembership.findMany({
      where: { userId: user.id },
      select: { groupId: true },
    });
    for (const membership of memberships) groupIds.add(membership.groupId);
    for (const unit of await orgUnitChainFor(tx, user.orgUnitId)) {
      orgUnitChainIds.add(unit);
    }
  }

  const holdings = await tx.accountEntitlement.findMany({
    where: { state: 'held', account: { personId } },
    select: { entitlementId: true },
  });
  const granted = await tx.accessGrant.findMany({
    where: {
      subjectPersonId: personId,
      resourceType: 'entitlement',
      status: { in: [...LIVE_GRANT_STATUSES] },
    },
    select: { resourceId: true },
  });

  return {
    personStatus: person?.status ?? 'inactive',
    hasActiveContract: contracts.length > 0,
    groupIds: [...groupIds],
    orgUnitChainIds: [...orgUnitChainIds],
    entitlementIds: [
      ...new Set([
        ...holdings.map((h) => h.entitlementId),
        ...granted.map((g) => g.resourceId),
      ]),
    ],
    contracts: contracts.map((contract) => ({
      'contract.department': contract.department,
      'contract.jobTitle': contract.jobTitle,
      'contract.costCentre': contract.costCentre,
      'contract.employer': contract.employer,
      'contract.location': contract.location,
      // Prisma returns Decimal. The evaluator compares numerically and a
      // Decimal object compared with `>` is a string comparison in disguise.
      'contract.fte': contract.fte === null ? null : Number(contract.fte),
      'person.status': person?.status ?? null,
    })),
  };
}

function admits(product: Product, facts: SubjectAudienceFacts): boolean {
  return audienceAdmits(
    product.audienceCondition as AudienceCondition | null,
    facts.contracts,
    facts,
  );
}

/**
 * THE read path. Every other one calls this or `findVisibleProduct`.
 *
 * `draft` and `retired` products are excluded here rather than by each caller:
 * a draft is a product still being written, and a retired one has stopped
 * accepting requests. Neither is a catalog entry.
 */
export async function visibleProducts(
  tx: TenantClient,
  personId: string,
  on: Date = new Date(),
): Promise<Product[]> {
  const facts = await subjectAudienceFacts(tx, personId, on);
  const products = await tx.product.findMany({
    where: { status: 'active' },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  return products.filter((product) => admits(product, facts));
}

/**
 * Null rather than the row when the caller's audience does not admit it, so
 * the route answers 404. A 403 confirms the thing exists.
 */
export async function findVisibleProduct(
  tx: TenantClient,
  personId: string,
  productId: string,
  on: Date = new Date(),
): Promise<Product | null> {
  const product = await tx.product.findFirst({
    where: { id: productId, status: 'active' },
  });
  if (product === null) return null;
  const facts = await subjectAudienceFacts(tx, personId, on);
  return admits(product, facts) ? product : null;
}

/**
 * Search, filtered by exactly the same resolver. This is the endpoint the
 * whole "one resolver" rule exists for: a filter applied in the console and
 * not in search is the leak.
 */
export async function searchVisibleProducts(
  tx: TenantClient,
  personId: string,
  query: string,
  on: Date = new Date(),
): Promise<Product[]> {
  const visible = await visibleProducts(tx, personId, on);
  const needle = query.trim().toLowerCase();
  if (needle === '') return visible;
  return visible.filter(
    (product) =>
      product.name.toLowerCase().includes(needle) ||
      (product.description ?? '').toLowerCase().includes(needle) ||
      (product.category ?? '').toLowerCase().includes(needle),
  );
}

export interface AudiencePreview {
  matched: number;
  total: number;
  /** Every matched person, not a page of them. The screen's promise is "show me who". */
  sample: { personId: string; displayName: string }[];
}

/**
 * Everything the audience evaluator needs about EVERY person, in a fixed
 * number of queries.
 *
 * The per-person `subjectAudienceFacts` is roughly seven round trips. Calling
 * it in a loop over the tenant -- which both `previewAudience` and
 * `previewExpirySweep` did in the first draft of this plan -- issues over
 * eight thousand statements at spec section 17's own worked example of 1,180
 * persons, inside `withTenant`, which is `prisma.$transaction` with Prisma's
 * **5000 ms** default and no `transactionOptions` on the client. It raises
 * P2028, and it does so on the console preview and on the one nightly job
 * that must not fail.
 *
 * SEVEN queries, whatever the population -- `person`, `contract`, `user`,
 * `groupMembership`, `orgUnit`, `accountEntitlement`, `accessGrant`. The
 * property that matters is that the count is FIXED and independent of the
 * population, not the number itself; the number is stated so that adding an
 * eighth is a visible edit rather than a drift. The org-unit chain is walked
 * in memory from one `orgUnit` read; the depth cap and the seen-set are the same
 * as `orgUnitChainFor`'s, and for the same reason: `parentId` is a
 * self-relation with no database-level acyclicity check.
 *
 * Persons with no contract in force on `on` are present in the map with
 * `hasActiveContract: false`, so a caller can tell "not admitted" from
 * "not employed" -- a distinction spec section 12 and Global Constraint 16
 * both turn on.
 */
export async function allSubjectAudienceFacts(
  tx: TenantClient,
  on: Date,
): Promise<Map<string, SubjectAudienceFacts>> {
  const persons = await tx.person.findMany({
    select: { id: true, givenName: true, familyName: true, status: true },
    orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }],
  });
  const contracts = await tx.contract.findMany({
    where: { startDate: { lte: on }, OR: [{ endDate: null }, { endDate: { gte: on } }] },
    orderBy: { sequence: 'asc' },
  });
  const users = await tx.user.findMany({
    select: { id: true, personId: true, orgUnitId: true },
  });
  const memberships = await tx.groupMembership.findMany({
    select: { userId: true, groupId: true },
  });
  const orgUnits = await tx.orgUnit.findMany({ select: { id: true, parentId: true } });
  const holdings = await tx.accountEntitlement.findMany({
    where: { state: 'held' },
    select: { entitlementId: true, account: { select: { personId: true } } },
  });
  const grants = await tx.accessGrant.findMany({
    where: { resourceType: 'entitlement', status: { in: [...LIVE_GRANT_STATUSES] } },
    select: { subjectPersonId: true, resourceId: true },
  });

  const parentOf = new Map(orgUnits.map((u) => [u.id, u.parentId]));
  const chainOf = (orgUnitId: string | null): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = orgUnitId;
    for (let depth = 0; current !== null && depth < 64; depth += 1) {
      if (seen.has(current)) break;
      seen.add(current);
      chain.push(current);
      current = parentOf.get(current) ?? null;
    }
    return chain;
  };

  const usersByPerson = new Map<string, typeof users>();
  for (const user of users) {
    if (user.personId === null) continue;
    const list = usersByPerson.get(user.personId) ?? [];
    list.push(user);
    usersByPerson.set(user.personId, list);
  }
  const groupsByUser = new Map<string, string[]>();
  for (const membership of memberships) {
    const list = groupsByUser.get(membership.userId) ?? [];
    list.push(membership.groupId);
    groupsByUser.set(membership.userId, list);
  }
  const contractsByPerson = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    const list = contractsByPerson.get(contract.personId) ?? [];
    list.push(contract);
    contractsByPerson.set(contract.personId, list);
  }
  const entitlementsByPerson = new Map<string, Set<string>>();
  const addEntitlement = (personId: string | null | undefined, id: string) => {
    if (personId === null || personId === undefined) return;
    const set = entitlementsByPerson.get(personId) ?? new Set<string>();
    set.add(id);
    entitlementsByPerson.set(personId, set);
  };
  for (const holding of holdings) addEntitlement(holding.account?.personId, holding.entitlementId);
  for (const grant of grants) addEntitlement(grant.subjectPersonId, grant.resourceId);

  const out = new Map<string, SubjectAudienceFacts>();
  for (const person of persons) {
    const own = contractsByPerson.get(person.id) ?? [];
    const groupIds = new Set<string>();
    const orgUnitChainIds = new Set<string>();
    for (const user of usersByPerson.get(person.id) ?? []) {
      for (const groupId of groupsByUser.get(user.id) ?? []) groupIds.add(groupId);
      for (const unit of chainOf(user.orgUnitId)) orgUnitChainIds.add(unit);
    }
    out.set(person.id, {
      personStatus: person.status,
      hasActiveContract: own.length > 0,
      groupIds: [...groupIds],
      orgUnitChainIds: [...orgUnitChainIds],
      entitlementIds: [...(entitlementsByPerson.get(person.id) ?? [])],
      contracts: own.map((contract) => ({
        'contract.department': contract.department,
        'contract.jobTitle': contract.jobTitle,
        'contract.costCentre': contract.costCentre,
        'contract.employer': contract.employer,
        'contract.location': contract.location,
        // Prisma returns Decimal. The evaluator compares numerically and a
        // Decimal object compared with `>` is a string comparison in disguise.
        'contract.fte': contract.fte === null ? null : Number(contract.fte),
        'person.status': person.status,
      })),
    });
  }
  return out;
}

/** The display names the preview shows, read alongside the facts. */
async function personNamesFor(tx: TenantClient): Promise<Map<string, string>> {
  const persons = await tx.person.findMany({
    select: { id: true, givenName: true, familyName: true },
    orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }],
  });
  return new Map(persons.map((p) => [p.id, `${p.givenName} ${p.familyName}`]));
}

/**
 * "Visible to 412 of 1,180 persons — show me who."
 *
 * The direct analogue of Provision's business-rule impact preview, and it
 * exists for the same reason: an audience whose blast radius is only visible
 * after saving is an audience that gets saved and then discovered.
 */
export async function previewAudience(
  tenantId: string,
  condition: AudienceCondition | null,
  limit?: number,
  on: Date = new Date(),
): Promise<AudiencePreview> {
  // One short transaction that returns plain data; the evaluation, which is
  // pure, happens after it has committed.
  const loaded = await withTenant(tenantId, async (tx) => ({
    facts: await allSubjectAudienceFacts(tx, on),
    names: await personNamesFor(tx),
  }));

  let total = 0;
  let matched = 0;
  const sample: { personId: string; displayName: string }[] = [];

  for (const [personId, facts] of loaded.facts) {
    if (!facts.hasActiveContract) continue;
    total += 1;
    if (!audienceAdmits(condition, facts.contracts, facts)) continue;
    matched += 1;
    // Uncapped by default. The console's copy is "412 of 1,180 -- show me
    // who", and answering it with 25 names is not that. `limit` stays
    // available for a caller that genuinely wants a page.
    if (limit === undefined || sample.length < limit) {
      sample.push({ personId, displayName: loaded.names.get(personId) ?? personId });
    }
  }

  return { matched, total, sample };
}

/**
 * The tenant's settings row, created on first read.
 *
 * Get-or-create rather than seeded at tenant creation, because Automate lands
 * after tenants already exist and a nullable settings read scattered through
 * six services is six places to forget the defaults.
 *
 * **`INSERT ... ON CONFLICT DO NOTHING`, not `upsert`.** `runOutboxJob` (every
 * minute), `runTickJob` (every five) and `runSweepJob` all call this, so two
 * callers arriving before the row exists is ordinary rather than exotic, and
 * the loser gets a P2002 out of a job whose log explains nothing.
 *
 * Prisma's `upsert` is NOT that statement. It compiles to a find, then a
 * create or an update, so two concurrent transactions both find nothing and
 * both insert. This was written as an `upsert` on exactly that assumption and
 * it survived four whole-suite runs; the fifth -- the first with the suite
 * running eight workers in parallel -- failed on the very case that names the
 * race. A test that passes because nothing was contending is not evidence that
 * the code handles contention.
 *
 * The retry-on-P2002 shape does not work here and is worth ruling out
 * explicitly: this runs inside the CALLER's `withTenant`, and in PostgreSQL an
 * error aborts the whole transaction, so catching it and reading again would
 * issue the read on a transaction that can no longer do anything. The
 * conflict has to be handled by the statement itself.
 *
 * `ON CONFLICT DO NOTHING` never raises. Under two concurrent transactions the
 * second one blocks on the first's uncommitted row, then does nothing, and the
 * `findUniqueOrThrow` after it sees the committed row -- which is why the read
 * is a separate statement rather than a `RETURNING`, since `DO NOTHING`
 * returns no row to the loser.
 *
 * `gen_random_uuid()` and `now()` are supplied because the columns behind
 * Prisma's `@default(uuid())` and `@updatedAt` have no database-side default;
 * everything else on the table does, which is what keeps this to one statement.
 */
export async function automateSettings(tx: TenantClient) {
  const tenantId = await currentTenant(tx);
  await tx.$executeRaw`
    INSERT INTO "AutomateSettings" ("id", "tenantId", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, now())
    ON CONFLICT ("tenantId") DO NOTHING
  `;
  return tx.automateSettings.findUniqueOrThrow({ where: { tenantId } });
}

const SETTING_KEYS = [
  'sweepSchedule',
  'sweepThresholdPercent',
  'perProductSweepThresholdPercent',
  'personPopulationDropPercent',
  'fulfilmentSlaHours',
  'expiryWarningDays',
  'preHireHorizonDays',
  'maxDelegationDays',
  'maxApprovers',
  'delegatedBulkLimit',
] as const;

/**
 * Bounds checked here so that an out-of-range value is a message against a
 * field rather than a 500 out of a constraint violation. Kept next to
 * `SETTING_KEYS` so adding a setting without a bound is visible.
 *
 * **These are NOT simply the CHECK constraints restated.** The migration
 * enforces `BETWEEN 0 AND 100` on the three percentages and nothing but
 * `> 0` / `>= 0` on the four day/hour/count settings -- it has no upper bound
 * on any of them. The maxima below are this service's own judgement, and the
 * only place they exist besides `settingsBody` in `@syntra/contracts`, which
 * carries the same numbers so the route refuses what the service would refuse
 * rather than accepting a value that fails one layer in. If these two lists
 * disagree, the route is a lie about what the product accepts.
 */
const SETTING_BOUNDS: Record<string, { min: number; max: number }> = {
  sweepThresholdPercent: { min: 0, max: 100 },
  perProductSweepThresholdPercent: { min: 0, max: 100 },
  personPopulationDropPercent: { min: 0, max: 100 },
  fulfilmentSlaHours: { min: 1, max: 8760 },
  preHireHorizonDays: { min: 0, max: 365 },
  maxDelegationDays: { min: 1, max: 365 },
  maxApprovers: { min: 1, max: 100 },
  delegatedBulkLimit: { min: 1, max: 1000 },
};

/** Structural equality, because two of these settings are arrays. */
function sameSetting(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => value === b[index])
    );
  }
  return a === b;
}

/**
 * Changing a threshold is a privileged action for the reason Provision treats
 * it as one: lowering it is functionally the same act as approving everything
 * it would otherwise have caught. The audit payload names every field that
 * moved, with both values.
 */
export async function updateAutomateSettings(
  tenantId: string,
  actorUserId: string | null,
  input: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const before = (await automateSettings(tx)) as unknown as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    for (const key of SETTING_KEYS) {
      if (!(key in input)) continue;
      const next = input[key];

      // Validated here, against the same numbers the CHECK constraints
      // enforce. Without this a percentage of 900 reaches PostgreSQL and
      // comes back as an opaque 500; the constraint is the backstop, not the
      // interface.
      const bound = SETTING_BOUNDS[key];
      if (bound !== undefined) {
        if (typeof next !== 'number' || !Number.isInteger(next)) {
          throw new ProductConfigurationError(
            'setting-invalid',
            `${key} must be a whole number.`,
          );
        }
        if (next < bound.min || next > bound.max) {
          throw new ProductConfigurationError(
            'setting-out-of-range',
            `${key} must be between ${bound.min} and ${bound.max}.`,
          );
        }
      }
      if (key === 'expiryWarningDays') {
        if (!Array.isArray(next) || next.some((d) => !Number.isInteger(d) || d < 0)) {
          throw new ProductConfigurationError(
            'setting-invalid',
            'expiryWarningDays must be a list of whole numbers of days.',
          );
        }
      }

      // Structural, not `===`. `expiryWarningDays` is `Int[]`, and two arrays
      // are never `===`, so a reference comparison records it as changed and
      // rewrites it on every save -- and the audit log fills with a field
      // nobody touched.
      if (sameSetting(next, before[key])) continue;
      data[key] = next;
      changed[key] = { from: before[key], to: next };
    }
    if (Object.keys(data).length === 0) return;

    await tx.automateSettings.update({ where: { tenantId }, data });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.settings.update',
      targetType: 'AutomateSettings',
      targetId: tenantId,
      outcome: 'success',
      sourceIp: null,
      payload: { changed },
    });
  });
}

/**
 * Records who owns a resource, for the `resourceOwner` selector.
 *
 * A separate table rather than a column on `Entitlement`, `Application` and
 * `Group`, because two of those three are owned by other subsystems.
 */
export async function upsertResourceOwner(
  tenantId: string,
  actorUserId: string | null,
  input: {
    resourceType: ResourceType;
    resourceId: string;
    ownerPersonId: string | null;
    ownerGroupId: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.resourceOwner.upsert({
      where: {
        tenantId_resourceType_resourceId: {
          tenantId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        },
      },
      create: {
        tenantId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ownerPersonId: input.ownerPersonId,
        ownerGroupId: input.ownerGroupId,
      },
      update: {
        ownerPersonId: input.ownerPersonId,
        ownerGroupId: input.ownerGroupId,
      },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'automate.resource_owner.set',
      targetType: 'ResourceOwner',
      targetId: input.resourceId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        resourceType: input.resourceType,
        ownerPersonId: input.ownerPersonId,
        ownerGroupId: input.ownerGroupId,
      },
    });
  });
}
