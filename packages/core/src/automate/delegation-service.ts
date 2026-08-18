// `Prisma` comes through `@syntra/db` (Ruling A-13): `packages/core` does not
// declare `@prisma/client`, and not declaring it is what makes
// `new PrismaClient()` unresolvable here.
import { Prisma, withTenant, type TenantClient } from "@syntra/db";
import { recordEvent } from "../audit/audit-service.js";
import { hasPermission } from "../rbac/rbac-service.js";
import { PERMISSIONS } from "../rbac/permissions.js";
import {
  allSubjectAudienceFacts,
  automateSettings,
} from "./catalog-service.js";
import { audienceAdmits, type AudienceCondition } from "./audience.js";
import { fulfilRequest, revokeGrant, type FulfilOptions } from "./fulfil.js";
import { displayNames, enqueueOutbox, recipientsForPersons } from "./notify.js";
import { LIVE_GRANT_STATUSES, type ResourceType } from "./types.js";

export class DelegationRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DelegationRefusedError";
  }
}

export type ResourceCapability =
  "view_members" | "approve" | "grant" | "revoke";

export const RESOURCE_CAPABILITIES: readonly ResourceCapability[] = [
  "view_members",
  "approve",
  "grant",
  "revoke",
];

const DAY_MS = 86_400_000;

/**
 * Records an approval delegation.
 *
 * Adds an approver; never replaces one. Depth 1 is enforced here, at creation,
 * as well as by the resolver expanding exactly one level -- the resolver's
 * half holds whatever gets into the table, and this half tells somebody why
 * their delegation was refused instead of leaving it silently ineffective.
 */
export async function createApprovalDelegation(
  tenantId: string,
  actorUserId: string | null,
  input: {
    delegatorPersonId: string;
    delegatePersonId: string;
    category: string | null;
    startsAt: Date;
    endsAt: Date;
  },
  options: { now?: Date; publicUrl?: string } = {},
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);

    // Spec section 8: a delegation may be created "by the delegator, or by an
    // administrator holding `automate.manage` on their behalf". That rule
    // lived nowhere in code — the function took `delegatorPersonId` from its
    // input and `actorUserId` separately and never compared them. Nothing was
    // exposed while the only caller was an admin route already gated on
    // `automate.manage`, but this function is exported from `@syntra/core`,
    // the portal is about to call it (spec section 17's "record an absence"),
    // and a rule that lives only in a route is a rule the next route forgets.
    if (actorUserId !== null) {
      const actor = await tx.user.findUnique({
        where: { id: actorUserId },
        select: { personId: true },
      });
      const isDelegator = actor?.personId === input.delegatorPersonId;
      if (
        !isDelegator &&
        !(await hasPermission(tx, actorUserId, PERMISSIONS.AUTOMATE_MANAGE))
      ) {
        throw new DelegationRefusedError(
          "not-permitted",
          "You can record an absence for yourself; delegating on somebody else’s behalf needs automate.manage.",
        );
      }
    }

    if (input.delegatorPersonId === input.delegatePersonId) {
      throw new DelegationRefusedError(
        "self",
        "A person cannot delegate to themselves.",
      );
    }
    if (input.endsAt <= input.startsAt) {
      throw new DelegationRefusedError(
        "window",
        "A delegation ends after it starts.",
      );
    }
    const days = (input.endsAt.getTime() - input.startsAt.getTime()) / DAY_MS;
    if (days > settings.maxDelegationDays) {
      throw new DelegationRefusedError(
        "too-long",
        `A delegation may run for at most ${settings.maxDelegationDays} days. An indefinite delegation is a permanent transfer of authority that nobody ever re-decides.`,
      );
    }

    // Depth 1, both directions: the delegate must not already delegate
    // onwards, and the delegator must not already be somebody's delegate.
    const chained = await tx.approvalDelegation.findFirst({
      where: {
        revokedAt: null,
        endsAt: { gt: input.startsAt },
        OR: [
          { delegatorPersonId: input.delegatePersonId },
          { delegatePersonId: input.delegatorPersonId },
        ],
      },
    });
    if (chained !== null) {
      throw new DelegationRefusedError(
        "not-transitive",
        "Delegation is not transitive: one of these two already holds a delegation, and chaining them would route approvals to somebody neither party chose.",
      );
    }

    const created = await tx.approvalDelegation.create({
      data: {
        tenantId,
        delegatorPersonId: input.delegatorPersonId,
        delegatePersonId: input.delegatePersonId,
        category: input.category,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdByUserId: actorUserId,
      },
    });

    await recordEvent(tx, {
      actorUserId,
      action: "automate.delegation.create",
      targetType: "ApprovalDelegation",
      targetId: created.id,
      outcome: "success",
      sourceIp: null,
      payload: {
        delegatorPersonId: input.delegatorPersonId,
        delegatePersonId: input.delegatePersonId,
        category: input.category,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
      },
    });

    // Both parties, at both ends. A delegation nobody was told about is a
    // transfer of authority nobody agreed to — and a mail saying
    // "guid-4f2a... has delegated approvals to guid-91be..." tells neither of
    // them anything.
    const recipients = await recipientsForPersons(tx, [
      input.delegatorPersonId,
      input.delegatePersonId,
    ]);
    const names = await displayNames(tx, {
      personIds: [input.delegatorPersonId, input.delegatePersonId],
    });
    await enqueueOutbox(
      tx,
      recipients.map((r) => ({
        template: "automate-delegation-started" as const,
        to: r.email,
        vars: {
          displayName: r.displayName,
          delegatorName:
            names.get(`person:${input.delegatorPersonId}`) ?? "the delegator",
          delegateName:
            names.get(`person:${input.delegatePersonId}`) ?? "the delegate",
          endsAt: input.endsAt.toDateString(),
        },
        requestId: null,
        userId: r.userId,
      })),
    );

    return { id: created.id };
  });
}

export async function endApprovalDelegation(
  tenantId: string,
  actorUserId: string | null,
  delegationId: string,
  options: { now?: Date; publicUrl?: string } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  await withTenant(tenantId, async (tx) => {
    const delegation = await tx.approvalDelegation.findUniqueOrThrow({
      where: { id: delegationId },
    });
    if (delegation.revokedAt !== null) return;
    await tx.approvalDelegation.update({
      where: { id: delegationId },
      data: { revokedAt: now },
    });
    await recordEvent(tx, {
      actorUserId,
      action: "automate.delegation.end",
      targetType: "ApprovalDelegation",
      targetId: delegationId,
      outcome: "success",
      sourceIp: null,
      payload: {
        delegatorPersonId: delegation.delegatorPersonId,
        delegatePersonId: delegation.delegatePersonId,
      },
    });
    const recipients = await recipientsForPersons(tx, [
      delegation.delegatorPersonId,
      delegation.delegatePersonId,
    ]);
    const names = await displayNames(tx, {
      personIds: [delegation.delegatorPersonId, delegation.delegatePersonId],
    });
    await enqueueOutbox(
      tx,
      recipients.map((r) => ({
        template: "automate-delegation-ended" as const,
        to: r.email,
        vars: {
          displayName: r.displayName,
          delegatorName:
            names.get(`person:${delegation.delegatorPersonId}`) ??
            "the delegator",
          delegateName:
            names.get(`person:${delegation.delegatePersonId}`) ??
            "the delegate",
          endsAt: now.toDateString(),
        },
        requestId: null,
        userId: r.userId,
      })),
    );
  });
}

export async function upsertResourceDelegation(
  tenantId: string,
  actorUserId: string | null,
  input: {
    id?: string;
    resourceType: ResourceType;
    resourceId: string;
    delegatePersonId: string | null;
    delegateGroupId: string | null;
    capabilities: ResourceCapability[];
    audienceCondition: AudienceCondition | null;
    startsAt: Date;
    endsAt: Date | null;
  },
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    if (input.capabilities.length === 0) {
      throw new DelegationRefusedError(
        "no-capabilities",
        "A delegation with no capabilities does nothing; remove it instead.",
      );
    }
    // Applications and local groups only.
    //
    // `delegatedGrant` writes a `RequestItem` with `targetSystemId: null`,
    // and `fulfilRequest` copies that onto the `AccessGrant` — so an
    // entitlement delegation produces `resourceType: 'entitlement',
    // targetSystemId: null`, which fails the `access_grant_target_matches_type`
    // check constraint as a 500 out of the portal, on a capability the console
    // lets an administrator configure. Even with the constraint satisfied,
    // `targetSystemIds` would be empty, no Provision run would ever be
    // enqueued, and the grant would sit `pending` forever.
    //
    // Refusing is the honest fix rather than resolving the target here: spec
    // section 14 is written entirely about groups a team lead owns, and a
    // target entitlement is Provision's to grant, behind a product and an
    // approval chain. `resourceParam` in the contracts is narrowed to match.
    if (input.resourceType === "entitlement") {
      throw new DelegationRefusedError(
        "entitlement-not-delegable",
        "A target entitlement cannot be delegated. It is granted through a catalog product and a Provision run, so that the approval and the target write stay in one place; delegate the application or the local group instead.",
      );
    }
    // Scope is per resource, never per type. There is no "manage all groups"
    // delegation; that is a role, and roles live in the console.
    const data = {
      tenantId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      delegatePersonId: input.delegatePersonId,
      delegateGroupId: input.delegateGroupId,
      capabilities: input.capabilities,
      // `Prisma.DbNull`, NOT `undefined`. Prisma reads `undefined` as "do not
      // touch this column", so on the update path `?? undefined` makes
      // CLEARING the audience impossible — and this audience is the control
      // that stops a delegated manager putting anybody in the organization
      // into their group (spec section 14). Same defect as
      // `Product.audienceCondition`, same fix; see Global Constraint 22.
      audienceCondition: (input.audienceCondition ?? Prisma.DbNull) as never,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdByUserId: actorUserId,
    };
    const row =
      input.id === undefined
        ? await tx.resourceDelegation.create({ data })
        : await tx.resourceDelegation.update({ where: { id: input.id }, data });

    await recordEvent(tx, {
      actorUserId,
      action: "automate.resource_delegation.upsert",
      targetType: "ResourceDelegation",
      targetId: row.id,
      outcome: "success",
      sourceIp: null,
      payload: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        capabilities: input.capabilities,
        endsAt: input.endsAt?.toISOString() ?? null,
      },
    });
    return { id: row.id };
  });
}

export interface ManagedResource {
  delegationId: string;
  resourceType: ResourceType;
  resourceId: string;
  capabilities: ResourceCapability[];
  endsAt: Date | null;
  audienceCondition: AudienceCondition | null;
}

/** What "Resources you manage" lists. A portal read, under a portal session. */
export async function resourcesManagedBy(
  tx: TenantClient,
  personId: string,
  now: Date,
): Promise<ManagedResource[]> {
  const users = await tx.user.findMany({
    where: { personId },
    select: { id: true },
  });
  const memberships = await tx.groupMembership.findMany({
    where: { userId: { in: users.map((u) => u.id) } },
    select: { groupId: true },
  });
  const groupIds = memberships.map((m) => m.groupId);

  // Read the live delegations and filter in memory below. The delegation
  // table is per tenant and small, and expressing "delegated to this person
  // OR to any of these groups" alongside the window predicate needs a second
  // `OR` key, which Prisma has no spelling for -- an earlier draft wrote
  // `OR2: undefined`, which Prisma rejects outright.
  const rows = await tx.resourceDelegation.findMany({
    where: {
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
  });

  return rows
    .filter(
      (row) =>
        row.delegatePersonId === personId ||
        (row.delegateGroupId !== null &&
          groupIds.includes(row.delegateGroupId)),
    )
    .map((row) => ({
      delegationId: row.id,
      resourceType: row.resourceType as ResourceType,
      resourceId: row.resourceId,
      capabilities: row.capabilities as ResourceCapability[],
      endsAt: row.endsAt,
      audienceCondition: row.audienceCondition as AudienceCondition | null,
    }));
}

async function delegationFor(
  tx: TenantClient,
  personId: string,
  resourceType: ResourceType,
  resourceId: string,
  capability: ResourceCapability,
  now: Date,
): Promise<ManagedResource> {
  const managed = await resourcesManagedBy(tx, personId, now);
  const match = managed.find(
    (m) => m.resourceType === resourceType && m.resourceId === resourceId,
  );
  if (match === undefined || !match.capabilities.includes(capability)) {
    throw new DelegationRefusedError(
      "not-permitted",
      "You do not manage that resource, or not in that way.",
    );
  }
  return match;
}

/**
 * A delegated administrator adding somebody.
 *
 * Creates an `AccessRequest` with `productId` null, `origin`
 * `delegated_admin`, no approval stages, and the acting person recorded as the
 * submitter, then fulfils it down the ordinary path. The alternative -- a
 * direct membership write -- is faster and forks the audit trail and the
 * fulfilment path in two, which is precisely the inventory gap Govern will be
 * asked to close.
 */
export async function delegatedGrant(
  tenantId: string,
  input: {
    actingPersonId: string;
    actingUserId: string;
    resourceType: ResourceType;
    resourceId: string;
    subjectPersonIds: string[];
    justification: string;
    durationDays: number | null;
  },
  options: FulfilOptions = {},
): Promise<{ requestIds: string[] }> {
  const now = options.now ?? new Date();

  const requestIds = await withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    const subjects = [...new Set(input.subjectPersonIds)];
    if (subjects.length > settings.delegatedBulkLimit) {
      throw new DelegationRefusedError(
        "too-many",
        `A delegated act may name at most ${settings.delegatedBulkLimit} people. For more than that, ask an administrator.`,
      );
    }

    // The same refusal as `upsertResourceDelegation`, restated at the act
    // rather than only at the configuration: a row written before that guard
    // existed must not produce a grant that violates
    // `access_grant_target_matches_type`.
    if (input.resourceType === "entitlement") {
      throw new DelegationRefusedError(
        "entitlement-not-delegable",
        "A target entitlement cannot be granted by a delegated manager; it goes through a catalog product and a Provision run.",
      );
    }

    const delegation = await delegationFor(
      tx,
      input.actingPersonId,
      input.resourceType,
      input.resourceId,
      "grant",
      now,
    );

    if (input.resourceType === "group") {
      const group = await tx.group.findUniqueOrThrow({
        where: { id: input.resourceId },
        include: { source: { select: { name: true } } },
      });
      if (group.sourceId !== null) {
        throw new DelegationRefusedError(
          "group-is-synced",
          `${group.name} is owned by the directory source ${group.source?.name ?? "unknown"}, which rewrites its membership on every run.`,
        );
      }
    }

    // The resource's own audience rule applies: where it is reachable through
    // a product, that product's condition; otherwise the delegation's own.
    // Without this, delegation is a hole underneath section 6.
    const productGrant = await tx.productGrant.findFirst({
      where: { resourceType: input.resourceType, resourceId: input.resourceId },
      include: {
        product: { select: { audienceCondition: true, status: true } },
      },
    });
    const condition =
      productGrant?.product.status === "active"
        ? (productGrant.product.audienceCondition as AudienceCondition | null)
        : delegation.audienceCondition;

    // Read ONCE for everybody, not per subject.
    //
    // `subjectAudienceFacts` is roughly seven round trips. Called in this loop
    // it is seven per subject inside a single `prisma.$transaction` whose
    // default budget is 5000 ms -- 175 statements at the default
    // `delegatedBulkLimit` of 25, and over seven thousand at the 1000 that
    // `SETTING_BOUNDS` permits a tenant to set. That is a P2028 on a portal
    // action a team lead takes, and the failure lands on them.
    //
    // `allSubjectAudienceFacts` answers for the whole tenant in SEVEN queries
    // whatever the population, which is the same remedy this slice already
    // applies in `previewAudience` and `previewExpirySweep`. This path was
    // missed; found by the whole-branch invariant sweep, not by a test, because
    // every case in the suite names one or two subjects.
    const factsByPerson = await allSubjectAudienceFacts(tx, now);

    const ids: string[] = [];
    for (const subjectPersonId of subjects) {
      const facts = factsByPerson.get(subjectPersonId);
      // A subject the tenant does not hold is outside every audience there is.
      if (
        facts === undefined ||
        !audienceAdmits(condition, facts.contracts, facts)
      ) {
        throw new DelegationRefusedError(
          "outside-audience",
          "One of these people is outside the audience for this resource, so it is not yours to grant them.",
        );
      }

      const request = await tx.accessRequest.create({
        data: {
          tenantId,
          productId: null,
          subjectPersonId,
          requestedByUserId: input.actingUserId,
          requestedByPersonId: input.actingPersonId,
          origin: "delegated_admin",
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          justification: input.justification,
          requestedDurationDays: input.durationDays,
          status: "approved",
          decidedAt: now,
        },
      });
      await tx.requestItem.create({
        data: {
          tenantId,
          requestId: request.id,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          targetSystemId: null,
        },
      });
      await recordEvent(tx, {
        actorUserId: input.actingUserId,
        action: "automate.delegated.grant",
        targetType: "AccessRequest",
        targetId: request.id,
        outcome: "success",
        sourceIp: null,
        payload: {
          delegationId: delegation.delegationId,
          subjectPersonId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
        },
      });
      ids.push(request.id);
    }
    return ids;
  });

  for (const requestId of requestIds) {
    await fulfilRequest(tenantId, requestId, options);
  }
  return { requestIds };
}

/**
 * A delegated administrator removing somebody.
 *
 * The same act inverted: it revokes the `AccessGrant`, which removes the term
 * from desired state, and the removal follows the ordinary path. A holding
 * that came from a business rule is NOT this delegation's to remove -- that is
 * Provision's, and revoking zero grants is the honest answer.
 */
export async function delegatedRevoke(
  tenantId: string,
  input: {
    actingPersonId: string;
    actingUserId: string;
    resourceType: ResourceType;
    resourceId: string;
    subjectPersonIds: string[];
  },
  options: FulfilOptions = {},
): Promise<{ revoked: number }> {
  const now = options.now ?? new Date();

  const grantIds = await withTenant(tenantId, async (tx) => {
    const settings = await automateSettings(tx);
    const subjects = [...new Set(input.subjectPersonIds)];
    if (subjects.length > settings.delegatedBulkLimit) {
      throw new DelegationRefusedError(
        "too-many",
        `A delegated act may name at most ${settings.delegatedBulkLimit} people. For more than that, ask an administrator.`,
      );
    }
    await delegationFor(
      tx,
      input.actingPersonId,
      input.resourceType,
      input.resourceId,
      "revoke",
      now,
    );

    const grants = await tx.accessGrant.findMany({
      where: {
        subjectPersonId: { in: subjects },
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: { in: [...LIVE_GRANT_STATUSES] },
      },
      select: { id: true },
    });
    return grants.map((g) => g.id);
  });

  for (const grantId of grantIds) {
    await revokeGrant(
      tenantId,
      input.actingUserId,
      grantId,
      "removed by the resource manager",
      options,
    );
  }
  return { revoked: grantIds.length };
}
