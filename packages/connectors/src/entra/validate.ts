/**
 * The disposable-tenant validation runner for the native Entra ID connector.
 *
 *   pnpm entra:validate            # read-only: token, users (paged), groups,
 *                                  # search, read-back of the first user
 *   pnpm entra:validate --write    # also: create a test user, update a
 *                                  # managed field, grant and revoke the test
 *                                  # groups, disable the user (NEVER delete),
 *                                  # reading back after every step
 *
 * Environment:
 *   ENTRA_TENANT_ID          the directory id or a verified domain
 *   ENTRA_CLIENT_ID          the app registration's application id
 *   ENTRA_CLIENT_SECRET      its client secret
 *   ENTRA_TEST_GROUP_IDS     comma-separated group object ids (--write)
 *   ENTRA_TEST_USER_PREFIX   default 'syntra-validate-'
 *   ENTRA_TEST_DOMAIN        the UPN domain for the test user; defaults to
 *                            ENTRA_TENANT_ID when that is a domain
 *   ENTRA_DISPOSABLE_TENANT  must be 'yes' for --write to run at all
 *
 * Evidence lands in test-results/entra-evidence-<iso>.json as rows of
 * { capability, operationId, anchor, expected, observed, timestamp, pass },
 * which is the shape the roadmap's test table asks for. This is what turns a
 * matrix entry marked `automated+tenant-evidence-required` into a proven
 * one; the fake-Graph tests cannot, because they prove protocol handling and
 * not Graph.
 *
 * The test user is created with the prefix and disabled at the end. It is
 * never deleted, by this runner or by the connector: clean-up is a decision a
 * person makes in the tenant, having decided to.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { entraTargetConnector } from './connector.js';
import { forgetEntraTokens } from './graph.js';
import type { TargetReadBack } from '../types.js';

interface Evidence {
  capability: string;
  operationId: string;
  anchor: string | null;
  expected: string;
  observed: string;
  timestamp: string;
  pass: boolean;
}

const evidence: Evidence[] = [];

function record(row: Omit<Evidence, 'timestamp'>): void {
  evidence.push({ ...row, timestamp: new Date().toISOString() });
  const mark = row.pass ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${row.capability.padEnd(20)} ${row.operationId.padEnd(38)} ${row.observed}`);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function describeReadBack(back: TargetReadBack): string {
  if (back.account === null) return 'account not observed';
  return `enabled=${back.enabled === null ? 'unknown' : back.enabled} groups=[${back.entitlementIds.join(',')}] complete=${back.complete}`;
}

async function main(): Promise<number> {
  const write = process.argv.includes('--write');
  const tenantId = env('ENTRA_TENANT_ID');
  const clientId = env('ENTRA_CLIENT_ID');
  const clientSecret = env('ENTRA_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) {
    console.error('ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET are required');
    return 2;
  }
  if (write && env('ENTRA_DISPOSABLE_TENANT') !== 'yes') {
    console.error(
      '--write creates and changes objects in the tenant and is refused unless ENTRA_DISPOSABLE_TENANT=yes',
    );
    return 2;
  }
  const prefix = env('ENTRA_TEST_USER_PREFIX') ?? 'syntra-validate-';
  const domain = env('ENTRA_TEST_DOMAIN') ?? (tenantId.includes('.') ? tenantId : undefined);
  const groupIds = (env('ENTRA_TEST_GROUP_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const config = { tenantId, clientId, bindPassword: clientSecret };
  const runId = randomUUID();
  console.log(`entra:validate ${write ? '(write)' : '(read-only)'} run ${runId}`);

  // ---- OAuth ----------------------------------------------------------------
  forgetEntraTokens();
  const test = await entraTargetConnector.test(config);
  record({
    capability: 'oauth',
    operationId: runId,
    anchor: null,
    expected: 'token issued and Graph reachable',
    observed: test.message,
    pass: test.ok,
  });
  if (!test.ok) return finish();

  // ---- Read (paged) ---------------------------------------------------------
  const anchors = new Set<string>();
  let duplicates = 0;
  let total = 0;
  let readFailures = 0;
  let firstAnchor: string | null = null;
  try {
    for await (const user of entraTargetConnector.read(config)) {
      total += 1;
      if (anchors.has(user.anchor)) duplicates += 1;
      anchors.add(user.anchor);
      if (user.readFailure !== undefined) readFailures += 1;
      firstAnchor ??= user.anchor;
    }
    record({
      capability: 'readAccounts',
      operationId: runId,
      anchor: null,
      expected: 'every page read, no duplicate anchors',
      observed: `${total} users, ${duplicates} duplicates, ${readFailures} with readFailure`,
      pass: duplicates === 0,
    });
  } catch (cause) {
    record({ capability: 'readAccounts', operationId: runId, anchor: null, expected: 'every page read', observed: String(cause), pass: false });
  }

  // ---- Groups ---------------------------------------------------------------
  try {
    let groups = 0;
    let dynamic = 0;
    for await (const group of entraTargetConnector.listEntitlements(config)) {
      groups += 1;
      if (group.membershipKind === 'dynamic') dynamic += 1;
    }
    record({
      capability: 'listEntitlements',
      operationId: runId,
      anchor: null,
      expected: 'security groups listed, dynamic ones marked unmanageable',
      observed: `${groups} groups, ${dynamic} dynamic`,
      pass: true,
    });
  } catch (cause) {
    record({ capability: 'listEntitlements', operationId: runId, anchor: null, expected: 'groups listed', observed: String(cause), pass: false });
  }

  try {
    const found = await entraTargetConnector.searchEntitlements(config, { query: 'a', top: 5 });
    record({
      capability: 'searchEntitlements',
      operationId: runId,
      anchor: null,
      expected: 'server-side search answers',
      observed: `${found.length} results`,
      pass: true,
    });
  } catch (cause) {
    record({ capability: 'searchEntitlements', operationId: runId, anchor: null, expected: 'search answers', observed: String(cause), pass: false });
  }

  // ---- Read-back of the first user -----------------------------------------
  if (firstAnchor !== null) {
    try {
      const back = await entraTargetConnector.readBack(config, firstAnchor);
      record({
        capability: 'readBack',
        operationId: runId,
        anchor: firstAnchor,
        expected: 'account observed with enabled state and memberships',
        observed: describeReadBack(back),
        pass: back.account !== null && back.complete,
      });
    } catch (cause) {
      record({ capability: 'readBack', operationId: runId, anchor: firstAnchor, expected: 'account observed', observed: String(cause), pass: false });
    }
  }

  if (!write) return finish();

  // ---- Write phase ----------------------------------------------------------
  if (!domain) {
    console.error('ENTRA_TEST_DOMAIN is required for --write when ENTRA_TENANT_ID is a directory id');
    return finish(2);
  }
  const local = `${prefix}${runId.slice(0, 8)}`;
  const upn = `${local}@${domain}`;
  const createId = `validate-create-${runId}`;
  const password = `V!${randomUUID()}aA1`;

  const create = () =>
    entraTargetConnector.write(config, {
      op: 'create_account',
      actionId: createId,
      correlationKey: upn,
      attributes: { displayName: [`Syntra Validate ${runId.slice(0, 8)}`], department: ['Validation'] },
      enabled: true,
      initialPassword: password,
    });
  const first = await create();
  record({
    capability: 'createAccount',
    operationId: createId,
    anchor: first.anchor ?? null,
    expected: 'one account created with the correlation marker',
    observed: first.message,
    pass: first.ok && first.anchor !== undefined,
  });
  if (!first.ok || first.anchor === undefined) return finish();
  const anchor = first.anchor;

  const second = await create();
  record({
    capability: 'createAccount (retry)',
    operationId: createId,
    anchor: second.anchor ?? null,
    expected: `same anchor ${anchor}, no second object`,
    observed: `${second.message} anchor=${second.anchor ?? 'none'}`,
    pass: second.ok && second.anchor === anchor,
  });

  const settle = async (what: string, check: (back: TargetReadBack) => boolean): Promise<TargetReadBack> => {
    // Graph is eventually consistent. Read back up to five times, a few
    // seconds apart, and report the last observation either way -- never
    // an observation that was assumed.
    let back = await entraTargetConnector.readBack(config, anchor);
    for (let attempt = 0; attempt < 5 && !(back.complete && check(back)); attempt += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      back = await entraTargetConnector.readBack(config, anchor);
    }
    record({
      capability: 'readBack',
      operationId: `${what}-${runId}`,
      anchor,
      expected: what,
      observed: describeReadBack(back),
      pass: back.complete && check(back),
    });
    return back;
  };
  await settle('created account observed', (b) => b.account !== null && b.enabled === true);

  const updateId = `validate-update-${runId}`;
  const updated = await entraTargetConnector.write(config, {
    op: 'update_account',
    actionId: updateId,
    anchor,
    attributes: { department: ['Validated'] },
  });
  record({ capability: 'updateAccount', operationId: updateId, anchor, expected: 'department changed, nothing else', observed: updated.message, pass: updated.ok });
  await settle('department = Validated', (b) => b.account?.attributes.department?.[0] === 'Validated');

  for (const groupId of groupIds) {
    const grantId = `validate-grant-${groupId}-${runId}`;
    const granted = await entraTargetConnector.write(config, { op: 'grant_entitlement', actionId: grantId, anchor, entitlementId: groupId });
    record({ capability: 'grantEntitlement', operationId: grantId, anchor, expected: `member of ${groupId}`, observed: granted.message, pass: granted.ok });
    await settle(`membership of ${groupId} observed`, (b) => b.entitlementIds.includes(groupId));

    const revokeId = `validate-revoke-${groupId}-${runId}`;
    const revoked = await entraTargetConnector.write(config, { op: 'revoke_entitlement', actionId: revokeId, anchor, entitlementId: groupId });
    record({ capability: 'revokeEntitlement', operationId: revokeId, anchor, expected: `not a member of ${groupId}`, observed: revoked.message, pass: revoked.ok });
    await settle(`membership of ${groupId} absent`, (b) => !b.entitlementIds.includes(groupId));
  }
  if (groupIds.length === 0) {
    console.log('no ENTRA_TEST_GROUP_IDS: grant and revoke not exercised');
  }

  const disableId = `validate-disable-${runId}`;
  const disabled = await entraTargetConnector.write(config, { op: 'disable_account', actionId: disableId, anchor, reason: 'validation run' });
  record({ capability: 'disableAccount', operationId: disableId, anchor, expected: 'account present and disabled', observed: disabled.message, pass: disabled.ok });
  await settle('account present and disabled', (b) => b.account !== null && b.enabled === false);

  console.log(`test user ${upn} (${anchor}) was left DISABLED and not deleted; remove it in the tenant when done`);
  return finish();
}

function finish(code?: number): number {
  mkdirSync('test-results', { recursive: true });
  const file = `test-results/entra-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  const failed = evidence.filter((e) => !e.pass).length;
  console.log(`\n${evidence.length} rows, ${failed} failed -> ${file}`);
  return code ?? (failed === 0 ? 0 : 1);
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    console.error(cause);
    process.exit(1);
  },
);
