import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma, withTenant, type TenantClient } from '@syntra/db';
import { hashBreakGlassCredential } from '@syntra/core';

/**
 * ONE OF EVERYTHING, IN ONE TENANT.
 *
 * The tenant-isolation probe (`tenant-isolation.test.ts`) needs a real row of
 * every kind of tenant object in a SECOND tenant, so that a route called with
 * that row's id is being asked about something that exists. A random UUID
 * proves nothing: RLS or no RLS, a lookup for an id nobody holds finds
 * nothing. The only question worth asking is "does tenant A's admin reach
 * tenant B's user", and that needs tenant B to have a user.
 *
 * It needs the same world in tenant A too, for the MIXED probes: A's own
 * group with B's user in the member slot, A's own role with B's user in the
 * assignment body. That is the shape of the cross-tenant defect row-level
 * security does NOT stop on its own -- PostgreSQL checks a foreign key without
 * applying RLS to the referenced table, so an insert of A's membership row
 * pointing at B's user passes both the policy (the new row is A's) and the
 * constraint (the user exists), unless the code looked the user up first.
 *
 * Rows are written directly, not through the services, deliberately: a
 * service that validates its input would refuse half of these shapes, and the
 * probe is about what the ROUTES do with a foreign id, not about whether the
 * services could have created it. Every name carries `tag`, which is what the
 * probe searches response bodies for: a B name appearing in an A response is
 * a leak whatever field it arrived in.
 *
 * Adding a kind here is half the job. The other half is `PARAM_KINDS` in
 * `probe.ts`, which says which route parameters mean this kind.
 */
export const KINDS = [
  'orgUnit',
  'user',
  'group',
  'person',
  'role',
  'session',
  'token',
  'webauthnCredential',
  'source',
  'syncRun',
  'syncChange',
  'personSource',
  'personImportRun',
  'personImportChange',
  'personSourceLink',
  'identityReferenceValue',
  'duplicateReview',
  'policyRule',
  'application',
  'appAssignment',
  'claim',
  'claimSet',
  'target',
  'provisionRun',
  'drift',
  'businessRule',
  'receipt',
  'lifecycleOperation',
  'legalHold',
  'lifecycleSimulation',
  'auditView',
  'export',
  'deletionRequest',
  'webhook',
  'webhookDelivery',
  'snapshot',
  'evidencePack',
  'finding',
  'remediation',
  'orphan',
  'campaign',
  'campaignItem',
  'revocationBatch',
  'revocationDispatch',
  'businessFunction',
  'otherBusinessFunction',
  'sodViolation',
  'sodException',
  'task',
  'workflow',
  'product',
  'accessRequest',
  'sweep',
  'approvalDelegation',
  'grant',
  'privilegedChange',
  'breakGlassUser',
  'breakGlassActivation',
  'credentialRotation',
  'privacyCase',
  'supportBundle',
  'dsarBundle',
] as const;

export type Kind = (typeof KINDS)[number];

export interface World {
  tenantId: string;
  /** Lower-case, unique to the tenant, and inside every name the tenant owns. */
  tag: string;
  ids: Record<Kind, string>;
  /**
   * The emergency credential of `breakGlassUser`, whose login is
   * `<tag>-breakglass`. Held so the probe can present one tenant's valid
   * credential at the other tenant's host.
   */
  breakGlassCredential: string;
}

/** The break-glass credential seeded for a tenant: deterministic, never real. */
export const breakGlassCredentialFor = (tag: string) => `syntra_bg_${tag}-probe-credential-0000000000000000`;

const DAY = 86_400_000;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** A tenant row, beside the one `buildTestApp` made, reachable at `<slug>.syntra.test`. */
export async function createTenant(name: string, slug: string): Promise<string> {
  const tenant = await prisma.tenant.create({ data: { name, slug } });
  return tenant.id;
}

export async function seedWorld(tenantId: string, tag: string): Promise<World> {
  const ids = await withTenant(tenantId, (tx) => seed(tx, tenantId, tag), { timeoutMs: 60_000 });
  return { tenantId, tag, ids, breakGlassCredential: breakGlassCredentialFor(tag) };
}

async function seed(tx: TenantClient, tenantId: string, tag: string): Promise<Record<Kind, string>> {
  const now = new Date();
  const later = new Date(now.getTime() + 30 * DAY);
  const token = () => randomBytes(24).toString('hex');

  // ---- directory ------------------------------------------------------------
  const orgUnit = await tx.orgUnit.create({ data: { tenantId, name: `${tag} unit` } });
  const person = await tx.person.create({
    data: { tenantId, givenName: `${tag}given`, familyName: `${tag}family`, orgUnitId: orgUnit.id },
  });
  const otherPerson = await tx.person.create({
    data: { tenantId, givenName: `${tag}delegate`, familyName: `${tag}family` },
  });
  await tx.contract.create({ data: { tenantId, personId: person.id, startDate: now } });
  const user = await tx.user.create({
    data: {
      tenantId,
      login: `${tag}-user`,
      email: `${tag}-user@${tag}.test`,
      displayName: `${tag} user`,
      orgUnitId: orgUnit.id,
      personId: person.id,
    },
  });
  const group = await tx.group.create({ data: { tenantId, name: `${tag} group` } });
  await tx.groupMembership.create({ data: { tenantId, groupId: group.id, userId: user.id } });
  const role = await tx.role.create({ data: { tenantId, name: `${tag} role` } });
  await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: user.id } });
  const session = await tx.session.create({
    data: { tenantId, userId: user.id, tokenHash: token(), scope: 'portal', absoluteExpiresAt: later },
  });
  const apiToken = await tx.apiToken.create({
    data: { tenantId, userId: user.id, name: `${tag} token`, tokenHash: token() },
  });
  const credential = await tx.webAuthnCredential.create({
    data: {
      tenantId,
      userId: user.id,
      credentialId: `${tag}-credential`,
      publicKey: Buffer.from(tag),
      rpId: `${tag}.syntra.test`,
      label: `${tag} key`,
    },
  });

  // ---- directory sync and HR import -------------------------------------------
  const source = await tx.directorySource.create({
    data: { tenantId, name: `${tag} directory`, config: {}, secretName: `${tag}-source-secret` },
  });
  const syncRun = await tx.syncRun.create({ data: { tenantId, sourceId: source.id } });
  const syncChange = await tx.syncChange.create({
    data: { tenantId, runId: syncRun.id, changeType: 'create', targetType: 'user' },
  });
  const personSource = await tx.personSource.create({
    data: {
      tenantId,
      name: `${tag} hr`,
      type: 'csv',
      config: {},
      secretName: `${tag}-hr-secret`,
      feedMode: 'snapshot',
    },
  });
  const importRun = await tx.personImportRun.create({ data: { tenantId, sourceId: personSource.id } });
  const importChange = await tx.personImportChange.create({
    data: { tenantId, runId: importRun.id, changeType: 'create_person', recordType: 'person' },
  });
  const sourceLink = await tx.personSourceLink.create({
    data: { tenantId, sourceId: personSource.id, personId: person.id, externalId: `${tag}-ext` },
  });
  const referenceValue = await tx.identityReferenceValue.create({
    data: { tenantId, kind: 'department', value: `${tag} dept`, normalizedValue: `${tag} dept` },
  });
  const duplicateReview = await tx.personDuplicateReview.create({
    data: {
      tenantId,
      runId: importRun.id,
      changeId: importChange.id,
      candidatePersonId: person.id,
      matchedValue: `${tag}-match`,
      restoreStatus: 'none',
    },
  });

  // ---- access -------------------------------------------------------------------
  const policy = await tx.authPolicy.create({ data: { tenantId } });
  const policyRule = await tx.authPolicyRule.create({
    data: { tenantId, policyId: policy.id, position: 0, name: `${tag} rule`, outcome: 'allow' },
  });
  const application = await tx.application.create({
    data: { tenantId, name: `${tag} app`, slug: `${tag}-app` },
  });
  const appAssignment = await tx.appAssignment.create({
    data: { tenantId, applicationId: application.id, subjectType: 'user', userId: user.id },
  });
  const claim = await tx.claimMapping.create({
    data: {
      tenantId,
      applicationId: application.id,
      protocol: 'oidc',
      claimName: `${tag}_claim`,
      sourceKind: 'attribute',
    },
  });
  const claimSet = await tx.claimMappingSet.create({
    data: { tenantId, name: `${tag} claims`, protocol: 'oidc' },
  });

  // ---- provision ------------------------------------------------------------------
  const target = await tx.targetSystem.create({
    data: {
      tenantId,
      name: `${tag} directory target`,
      config: { url: `ldaps://${tag}.example.test`, tlsMode: 'ldaps' },
      secretName: `${tag}-target-secret`,
    },
  });
  const provisionRun = await tx.provisionRun.create({ data: { tenantId, targetSystemId: target.id } });
  const drift = await tx.driftFinding.create({
    data: {
      tenantId,
      targetSystemId: target.id,
      kind: 'unexpected_account',
      detail: { name: `${tag} drift` },
      fingerprint: `${tag}-drift`,
    },
  });
  const businessRule = await tx.businessRule.create({
    data: { tenantId, targetSystemId: target.id, name: `${tag} business rule`, condition: {} },
  });
  const receipt = await tx.personProvisionReceipt.create({
    data: {
      tenantId,
      personId: person.id,
      targetSystemId: target.id,
      requestKey: randomUUID(),
      targetName: `${tag} directory target`,
    },
  });
  await tx.targetAccount.create({
    data: { tenantId, targetSystemId: target.id, personId: person.id, correlationKey: `${tag}-account` },
  });

  // ---- lifecycle -------------------------------------------------------------------
  const operation = await tx.lifecycleOperation.create({
    data: {
      tenantId,
      kind: 'onboard',
      idempotencyKey: `${tag}-operation`,
      inputFingerprint: `${tag}-fingerprint`,
      personId: person.id,
    },
  });
  const legalHold = await tx.lifecycleLegalHold.create({
    data: {
      tenantId,
      subjectType: 'person',
      subjectId: person.id,
      reference: `${tag}-hold`,
      reason: `${tag} litigation`,
    },
  });
  const simulation = await tx.lifecycleSimulation.create({
    data: { tenantId, kind: 'onboard', scope: 'person', result: { name: `${tag} simulation` } },
  });

  // ---- tenant administration ---------------------------------------------------------
  const auditView = await tx.auditSavedView.create({
    data: { tenantId, userId: user.id, name: `${tag} view`, filters: {} },
  });
  const dataExport = await tx.dataExport.create({
    data: {
      tenantId,
      kind: 'audit_log',
      params: {},
      format: 'jsonl',
      requestedByUserId: user.id,
      ttlHours: 24,
    },
  });
  const deletionRequest = await tx.tenantDeletionRequest.create({
    data: {
      tenantId,
      assessmentDigest: digest(`${tag}-assessment`),
      assessmentAuditEventId: randomUUID(),
      exportDigest: digest(`${tag}-export`),
      exportAuditEventId: randomUUID(),
      dataRevision: digest(`${tag}-revision`),
      requestedByUserId: user.id,
      approvalExpiresAt: later,
    },
  });
  // Disabled, and its delivery not due for a month: the webhook job is probed
  // below with A's context, and it must not dial `example.test` to prove it.
  const webhook = await tx.webhookEndpoint.create({
    data: { tenantId, name: `${tag} hook`, url: `https://${tag}.example.test/hook`, enabled: false },
  });
  const webhookDelivery = await tx.webhookDelivery.create({
    data: {
      tenantId,
      endpointId: webhook.id,
      event: 'approvals',
      payload: { name: `${tag} delivery` },
      nextAttemptAt: later,
      attempts: 3,
      lastError: `${tag} refused`,
    },
  });

  // ---- govern --------------------------------------------------------------------------
  const snapshot = await tx.accessSnapshot.create({
    data: { tenantId, kind: 'manual', asOf: now, status: 'complete' },
  });
  // A snapshot with no recorded source is refused as unreadable, and every
  // Govern report would then answer tenant A's own reads with that refusal
  // instead of with A's data.
  await tx.snapshotSource.create({
    data: {
      tenantId,
      snapshotId: snapshot.id,
      sourceKind: 'targetSystem',
      sourceId: target.id,
      sourceName: `${tag} directory target`,
      completeness: 'complete',
      staleness: 'fresh',
      freshnessSlaHours: 24,
      lastSuccessfulReadAt: now,
    },
  });
  const evidencePack = await tx.evidencePack.create({
    data: {
      tenantId,
      kind: 'campaign',
      chainHeadSequence: 0,
      chainHeadHash: `${tag}-head`,
      chainVerificationResult: 'ok',
      chainFromSequence: 0,
      chainToSequence: 0,
      digest: `${tag}-digest`,
      byteLength: 0,
    },
  });
  const finding = await tx.governFinding.create({
    data: {
      tenantId,
      kind: 'orphan_account',
      severity: 'high',
      subjectRefType: 'person',
      subjectRefId: person.id,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  const remediation = await tx.remediationItem.create({
    data: {
      tenantId,
      kind: 'undecided_item',
      ownerPersonId: person.id,
      dueAt: later,
      description: `${tag} remediation`,
      deepLink: `/admin/${tag}`,
    },
  });
  const orphan = await tx.accountAttribution.create({
    data: {
      tenantId,
      systemId: target.id,
      accountRef: `${tag}-orphan`,
      proposedPersonId: person.id,
      method: 'email',
      confidence: 0.5,
    },
  });
  const campaign = await tx.campaign.create({
    data: {
      tenantId,
      name: `${tag} campaign`,
      scope: {},
      snapshotId: snapshot.id,
      reviewerSelector: 'manager',
      fallbackSelector: 'campaign_owner',
      ownerPersonId: person.id,
      opensAt: now,
      dueAt: later,
      originalDueAt: later,
      status: 'open',
    },
  });
  const campaignItem = await tx.campaignItem.create({
    data: {
      tenantId,
      campaignId: campaign.id,
      holdingSnapshotId: snapshot.id,
      subjectKey: `person:${person.id}`,
      personId: person.id,
      systemId: target.id,
      resourceKind: 'targetEntitlement',
      resourceId: `${tag}-entitlement`,
      resourceName: `${tag} entitlement`,
      observedAt: now,
      coverageStatus: 'complete',
      status: 'pending',
    },
  });
  await tx.campaignItemReviewer.create({
    data: { tenantId, itemId: campaignItem.id, personId: person.id, via: 'selector', assignedAt: now },
  });
  const batch = await tx.revocationBatch.create({
    data: { tenantId, campaignId: campaign.id, status: 'previewed' },
  });
  const dispatch = await tx.revocationDispatch.create({
    data: {
      tenantId,
      batchId: batch.id,
      itemId: campaignItem.id,
      holdingDescriptor: {},
      route: 'provision',
      status: 'proposed',
      sequence: 1,
    },
  });
  const functionA = await tx.businessFunction.create({
    data: { tenantId, name: `${tag} pay`, ownerPersonId: person.id },
  });
  const functionB = await tx.businessFunction.create({
    data: { tenantId, name: `${tag} approve`, ownerPersonId: person.id },
  });
  const sodRule = await tx.sodRule.create({
    data: {
      tenantId,
      name: `${tag} sod`,
      functionAId: functionA.id,
      functionBId: functionB.id,
      severity: 'high',
      rationale: `${tag} rationale`,
    },
  });
  const violation = await tx.sodViolation.create({
    data: {
      tenantId,
      ruleId: sodRule.id,
      personId: person.id,
      holdingsA: [],
      holdingsB: [],
      severity: 'high',
      firstSeenAt: now,
      lastSeenAt: now,
      lastSnapshotId: snapshot.id,
    },
  });
  const exception = await tx.sodException.create({
    data: {
      tenantId,
      ruleId: sodRule.id,
      personId: person.id,
      violationId: violation.id,
      justification: `${tag} justification`,
      compensatingControl: `${tag} control`,
      startsAt: now,
      endsAt: later,
    },
  });

  // ---- automate ------------------------------------------------------------------------
  const task = await tx.delegatedTask.create({
    data: { tenantId, name: `${tag} task`, actionKey: 'unlock_account' },
  });
  const workflow = await tx.approvalWorkflow.create({ data: { tenantId, name: `${tag} workflow` } });
  const product = await tx.product.create({
    data: {
      tenantId,
      name: `${tag} product`,
      slug: `${tag}-product`,
      kind: 'localGroup',
      workflowId: workflow.id,
    },
  });
  const accessRequest = await tx.accessRequest.create({
    data: { tenantId, subjectPersonId: person.id, requestedByUserId: user.id },
  });
  const sweep = await tx.expirySweep.create({ data: { tenantId } });
  const approvalDelegation = await tx.approvalDelegation.create({
    data: {
      tenantId,
      delegatorPersonId: person.id,
      delegatePersonId: otherPerson.id,
      startsAt: now,
      endsAt: later,
    },
  });
  const grant = await tx.accessGrant.create({
    data: {
      tenantId,
      subjectPersonId: person.id,
      resourceType: 'group',
      resourceId: group.id,
      startsAt: now,
      status: 'active',
    },
  });

  // ---- privileged access, credentials, privacy -----------------------------------
  const privilegedChange = await tx.privilegedChangeRequest.create({
    data: {
      tenantId,
      changeClass: 'webhook_endpoint',
      operation: 'webhook.update',
      targetType: 'WebhookEndpoint',
      targetId: webhook.id,
      summary: `${tag} held change`,
      proposed: { name: `${tag} proposed` },
      baseRevision: digest(`${tag}-revision-change`),
      reason: `${tag} needs this changed`,
      requestedByUserId: user.id,
      expiresAt: later,
    },
  });
  // An emergency account needs a designator who is not itself.
  const designator = await tx.user.create({
    data: { tenantId, login: `${tag}-designator`, email: `${tag}-designator@${tag}.test`, displayName: `${tag} designator` },
  });
  const breakGlassUser = await tx.user.create({
    data: { tenantId, login: `${tag}-breakglass`, email: `${tag}-breakglass@${tag}.test`, displayName: `${tag} emergency` },
  });
  await tx.breakGlassAccount.create({
    data: {
      tenantId,
      userId: breakGlassUser.id,
      credentialHash: hashBreakGlassCredential(breakGlassCredentialFor(tag)),
      designatedByUserId: designator.id,
    },
  });
  const activation = await tx.breakGlassActivation.create({
    data: {
      tenantId,
      userId: breakGlassUser.id,
      reason: `${tag} the directory is down and nobody can sign in`,
      durationMinutes: 60,
      activatesAt: later,
    },
  });
  await tx.credentialRecord.create({
    data: { tenantId, credentialKey: `target_secret.${target.id}`, kind: 'target_secret', note: `${tag} credential note` },
  });
  const rotation = await tx.credentialRotation.create({
    data: {
      tenantId,
      systemKind: 'target',
      systemId: target.id,
      credentialKey: `target_secret.${target.id}`,
      reason: `${tag} rotation`,
    },
  });
  const privacyCase = await tx.privacyCase.create({
    data: {
      tenantId,
      personId: person.id,
      reference: `${tag}-dsar`,
      requestTypes: ['access'],
      reason: `${tag} asked for their data`,
      receivedAt: now,
      dueAt: later,
      verificationMethod: 'document',
      verificationAttestation: `${tag} passport checked`,
      verifiedByUserId: user.id,
      openedByUserId: user.id,
    },
  });
  const supportBundle = await tx.dataExport.create({
    data: { tenantId, kind: 'support_bundle', params: {}, format: 'json', requestedByUserId: user.id, ttlHours: 24 },
  });
  const dsarBundle = await tx.dataExport.create({
    data: {
      tenantId,
      kind: 'dsar_bundle',
      params: { caseId: privacyCase.id, personId: person.id },
      format: 'json',
      requestedByUserId: user.id,
      ttlHours: 24,
    },
  });

  return {
    privilegedChange: privilegedChange.id,
    breakGlassUser: breakGlassUser.id,
    breakGlassActivation: activation.id,
    credentialRotation: rotation.id,
    privacyCase: privacyCase.id,
    supportBundle: supportBundle.id,
    dsarBundle: dsarBundle.id,
    orgUnit: orgUnit.id,
    user: user.id,
    group: group.id,
    person: person.id,
    role: role.id,
    session: session.id,
    token: apiToken.id,
    webauthnCredential: credential.id,
    source: source.id,
    syncRun: syncRun.id,
    syncChange: syncChange.id,
    personSource: personSource.id,
    personImportRun: importRun.id,
    personImportChange: importChange.id,
    personSourceLink: sourceLink.id,
    identityReferenceValue: referenceValue.id,
    duplicateReview: duplicateReview.id,
    policyRule: policyRule.id,
    application: application.id,
    appAssignment: appAssignment.id,
    claim: claim.id,
    claimSet: claimSet.id,
    target: target.id,
    provisionRun: provisionRun.id,
    drift: drift.id,
    businessRule: businessRule.id,
    receipt: receipt.id,
    lifecycleOperation: operation.id,
    legalHold: legalHold.id,
    lifecycleSimulation: simulation.id,
    auditView: auditView.id,
    export: dataExport.id,
    deletionRequest: deletionRequest.id,
    webhook: webhook.id,
    webhookDelivery: webhookDelivery.id,
    snapshot: snapshot.id,
    evidencePack: evidencePack.id,
    finding: finding.id,
    remediation: remediation.id,
    orphan: orphan.id,
    campaign: campaign.id,
    campaignItem: campaignItem.id,
    revocationBatch: batch.id,
    revocationDispatch: dispatch.id,
    businessFunction: functionA.id,
    otherBusinessFunction: functionB.id,
    sodViolation: violation.id,
    sodException: exception.id,
    task: task.id,
    workflow: workflow.id,
    product: product.id,
    accessRequest: accessRequest.id,
    sweep: sweep.id,
    approvalDelegation: approvalDelegation.id,
    grant: grant.id,
  };
}
