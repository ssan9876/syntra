import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { targetContainers } from './placement-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

export type DnRefusal = {
  ok: false;
  reason: 'malformed' | 'outside_base';
  message: string;
};

/**
 * Validates a container DN against the target's base, once, on write.
 *
 * Steps 3 and 4 of the placement ladder go through `renderContainer`, which
 * escapes every substituted value against RFC 4514 (Ruling P22). The org-unit
 * rung does not, and must not: the DN is a stored literal an operator chose,
 * and there is nothing in it to interpolate — escaping it would turn
 * `OU=Sales,OU=Users,DC=acme,DC=test` into one literal RDN value naming
 * nothing.
 *
 * So the obligation moves HERE. Validated once when the row is written rather
 * than re-checked on every run, because the value is operator-supplied once
 * and read thousands of times, and a check on the read path is one a future
 * caller can route around.
 *
 * The base comparison is on RDN BOUNDARIES, not on string suffix.
 * `OU=Evil,OU=XUsers,OU=Syntra,DC=…` ends with a string containing the base's
 * tail while sitting nowhere below it, and `endsWith` accepts exactly that —
 * which would let a materialisation write into a subtree the target
 * configuration never named.
 */
export function validateContainerDn(
  dn: string,
  baseDn: string,
): { ok: true; dn: string } | DnRefusal {
  const trimmed = dn.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'malformed', message: 'a container DN is required' };
  }

  const rdns = splitRdns(trimmed);
  if (rdns === null) {
    return {
      ok: false,
      reason: 'malformed',
      message: `${trimmed} is not a distinguished name`,
    };
  }

  // A target whose connector has no `baseDn` — anything that is not Active
  // Directory — renders it as an empty string. Refusing is the only safe
  // answer: with no base to be below, every DN in the world validates.
  const baseRdns = splitRdns(baseDn.trim());
  if (baseRdns === null || baseDn.trim() === '') {
    return {
      ok: false,
      reason: 'malformed',
      message: 'this target has no base DN to validate a container against',
    };
  }

  if (rdns.length < baseRdns.length) {
    return {
      ok: false,
      reason: 'outside_base',
      message: `${trimmed} is not below the target's base ${baseDn.trim()}`,
    };
  }

  const tail = rdns.slice(rdns.length - baseRdns.length);
  const below = tail.every(
    (rdn, index) => rdn.toLowerCase() === baseRdns[index]!.toLowerCase(),
  );
  if (!below) {
    return {
      ok: false,
      reason: 'outside_base',
      message: `${trimmed} is not below the target's base ${baseDn.trim()}`,
    };
  }

  return { ok: true, dn: trimmed };
}

/**
 * Splits a DN into RDNs on UNESCAPED commas.
 *
 * `OU=Sales\,West,DC=acme` is two RDNs, not three: the first names a unit
 * whose name contains a comma. Splitting naively compares the wrong number of
 * components against the base and refuses a legitimate DN.
 *
 * `null` for anything that is not a sequence of `attr=value` pairs, including
 * a string ending in a dangling escape.
 */
function splitRdns(dn: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of dn) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (character === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  // A trailing backslash escapes nothing. It is a truncated value, and a DN
  // parser that ignores it silently drops a character.
  if (escaped) return null;
  parts.push(current.trim());

  if (parts.some((part) => !/^[A-Za-z][\w-]*=.+$/.test(part))) return null;
  return parts;
}

export interface MaterialiseInput {
  orgUnitId: string;
  targetSystemId: string;
  dn: string;
  actorUserId: string | null;
  sourceIp: string | null;
}

export type MaterialiseOutcome =
  | { ok: true; state: 'desired' | 'adopted'; dn: string }
  | {
      ok: false;
      reason: 'malformed' | 'outside_base' | 'no_such_unit' | 'no_such_target' | 'dn_taken';
      message: string;
    };

/**
 * Binds one org unit to one container on one target.
 *
 * Reads the target's live inventory first and ADOPTS rather than intends when
 * the container is already there. Adoption is not an optimisation: two
 * administrators materialising the same unit, and a re-materialise after
 * somebody made the OU by hand, both arrive here, and both should heal rather
 * than propose a create that comes back `conflict` on the next run.
 *
 * Writes the row and nothing else. The directory write, where one is needed,
 * happens inside a provisioning run under the guard — which is the whole
 * reason creation lives in Provision rather than on the source-writeback path
 * beside `deleteDirectoryOrgUnit`.
 */
export async function materialiseOrgUnit(
  tenantId: string,
  provider: MasterKeyProvider,
  input: MaterialiseInput,
): Promise<MaterialiseOutcome> {
  const context = await withTenant(tenantId, async (tx) => {
    const unit = await tx.orgUnit.findUnique({
      where: { id: input.orgUnitId },
      select: { id: true, name: true },
    });
    const target = await tx.targetSystem.findUnique({
      where: { id: input.targetSystemId },
      select: { id: true, config: true },
    });
    return { unit, target };
  });

  if (context.unit === null) {
    return { ok: false, reason: 'no_such_unit', message: 'no such org unit' };
  }
  if (context.target === null) {
    return { ok: false, reason: 'no_such_target', message: 'no such target' };
  }

  const config = context.target.config as Record<string, unknown>;
  const baseDn = typeof config.baseDn === 'string' ? config.baseDn : '';
  const validated = validateContainerDn(input.dn, baseDn);
  if (!validated.ok) return validated;

  // Network I/O, so no transaction is held across it.
  const present = new Set(
    (await targetContainers(tenantId, provider, input.targetSystemId)).map((dn) =>
      dn.trim().toLowerCase(),
    ),
  );
  const state = present.has(validated.dn.toLowerCase()) ? 'adopted' : 'desired';

  try {
    await withTenant(tenantId, async (tx) => {
      await tx.orgUnitContainer.upsert({
        where: {
          tenantId_orgUnitId_targetSystemId: {
            tenantId,
            orgUnitId: input.orgUnitId,
            targetSystemId: input.targetSystemId,
          },
        },
        create: {
          tenantId,
          orgUnitId: input.orgUnitId,
          targetSystemId: input.targetSystemId,
          dn: validated.dn,
          state,
        },
        // A re-materialise re-reads the target, which is also how a row whose
        // container was made by hand in the meantime heals from 'desired' to
        // 'adopted' without anybody deleting anything.
        update: { dn: validated.dn, state },
      });
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'orgUnit.materialise',
        targetType: 'OrgUnit',
        targetId: input.orgUnitId,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: { dn: validated.dn, state, targetSystemId: input.targetSystemId },
      });
    });
  } catch (cause) {
    // The [tenantId, targetSystemId, dn] unique index. Two units claiming one
    // DN would converge two departments' accounts into a single container
    // with no error raised anywhere, so the database refuses it and this
    // reports the refusal rather than a 500.
    if (isUniqueViolation(cause)) {
      return {
        ok: false,
        reason: 'dn_taken',
        message: `${validated.dn} is already materialised by another org unit on this target`,
      };
    }
    throw cause;
  }

  return { ok: true, state, dn: validated.dn };
}

/**
 * Unbinds a unit from a target.
 *
 * Deletes the ROW and never the container. A container Syntra created and an
 * operator no longer wants tracked is still a container full of accounts;
 * removing it is `deleteDirectoryOrgUnit`'s job, and only once it is empty.
 */
export async function unmaterialiseOrgUnit(
  tenantId: string,
  input: { orgUnitId: string; targetSystemId: string; actorUserId: string | null },
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const { count } = await tx.orgUnitContainer.deleteMany({
      where: { orgUnitId: input.orgUnitId, targetSystemId: input.targetSystemId },
    });
    if (count > 0) {
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'orgUnit.unmaterialise',
        targetType: 'OrgUnit',
        targetId: input.orgUnitId,
        outcome: 'success',
        sourceIp: null,
        payload: { targetSystemId: input.targetSystemId },
      });
    }
    return count > 0;
  });
}

export interface MaterialisedContainer {
  id: string;
  dn: string;
  state: string;
}

/** Every materialisation on one target, keyed by `orgUnitId`. */
export async function containersForTarget(
  tx: TenantClient,
  targetSystemId: string,
): Promise<Map<string, MaterialisedContainer>> {
  const rows = await tx.orgUnitContainer.findMany({
    where: { targetSystemId },
    select: { id: true, orgUnitId: true, dn: true, state: true },
  });
  return new Map(rows.map((r) => [r.orgUnitId, { id: r.id, dn: r.dn, state: r.state }]));
}

/** Every materialisation of one unit, across targets, for the console. */
export async function containersForOrgUnit(
  tx: TenantClient,
  orgUnitId: string,
): Promise<{ targetSystemId: string; targetName: string; dn: string; state: string }[]> {
  const rows = await tx.orgUnitContainer.findMany({
    where: { orgUnitId },
    select: {
      targetSystemId: true,
      dn: true,
      state: true,
      targetSystem: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    targetSystemId: r.targetSystemId,
    targetName: r.targetSystem.name,
    dn: r.dn,
    state: r.state,
  }));
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === 'P2002'
  );
}
