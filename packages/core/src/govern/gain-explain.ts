import { SYNTRA_SYSTEM_ID } from './types.js';

/**
 * Which audit event explains a gain: access that appeared between two
 * snapshots because Syntra made it. PURE; `buildSnapshot` loads the events and
 * the lookups and writes the result.
 *
 * A gain nothing here matches stays `explained = false`, and that is the row
 * `unexplained_gain` exists for. So every key is built from what the event
 * itself records, never from what the holding looks like.
 */

/**
 * The actions read. The first seven carry `personId` (or `subjectPersonId`)
 * and `resourceId` (or `entitlementId`) in the payload and are matched on
 * those alone. The rest are matched on the holding's exact key.
 */
export const GAIN_EXPLAINING_ACTIONS = [
  'provision.apply.grant_entitlement',
  'automate.grant.fulfilled',
  'access.assignment.create',
  'directory.group.add_member',
  'rbac.role.assign',
  'automate.grant.create',
  'automate.delegated.grant',
  'user.create',
  'scim.user_created',
  'federation.user_provisioned',
  'group.addMember',
  'rbac.role_assigned',
  'application.assign',
  'provision.action.result',
] as const;

export interface GainAuditEvent {
  sequence: number;
  action: string;
  targetId: string | null;
  payload: unknown;
}

export interface GainLookups {
  users: ReadonlyMap<string, { personId: string | null; login: string }>;
  /** groupId -> the holding's systemId: the group's source, else Syntra. */
  groupSystemIds: ReadonlyMap<string, string>;
  /** ProvisionAction id -> the action, for `provision.action.result`. */
  provisionActions: ReadonlyMap<
    string,
    { actionType: string; personId: string | null; accountId: string | null; entitlementId: string | null }
  >;
  /** TargetAccount id -> where it lives and the holding's resourceId (anchor, else correlation key). */
  accounts: ReadonlyMap<string, { personId: string; targetSystemId: string; resourceId: string }>;
}

export interface GainRow {
  subjectKey: string;
  personId: string | null;
  systemId: string;
  resourceKind: string;
  resourceId: string;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Logins are unique case-insensitively; NFKD as `foldIdentifier` does. */
const fold = (login: string): string => login.normalize('NFKD').toLowerCase();

function loginIndex(lookups: GainLookups): Map<string, string> {
  return new Map([...lookups.users].map(([id, user]) => [fold(user.login), id]));
}

function userSubjectKey(userId: string, personId: string | null): string {
  return personId === null ? `account:${SYNTRA_SYSTEM_ID}:${userId}` : `person:${personId}`;
}

/** The keys one event explains: exact holding keys, or `legacy|person|resource`. */
export function gainKeysFor(
  event: GainAuditEvent,
  lookups: GainLookups,
  userIdByLogin: ReadonlyMap<string, string> = loginIndex(lookups),
): string[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const target = event.targetId;

  switch (event.action) {
    case 'user.create':
    case 'scim.user_created':
    case 'federation.user_provisioned': {
      // Only a login with a person is a `syntraUser` holding.
      const user = target === null ? undefined : lookups.users.get(target);
      if (target === null || user === undefined || user.personId === null) return [];
      return [`person:${user.personId}|${SYNTRA_SYSTEM_ID}|syntraUser|${target}`];
    }
    case 'group.addMember': {
      if (target === null) return [];
      // Older events name the member by login only.
      const login = str(payload['login']);
      const userId =
        str(payload['userId']) ?? (login === null ? null : (userIdByLogin.get(fold(login)) ?? null));
      const user = userId === null ? undefined : lookups.users.get(userId);
      if (userId === null || user === undefined) return [];
      const systemId = lookups.groupSystemIds.get(target) ?? SYNTRA_SYSTEM_ID;
      return [`${userSubjectKey(userId, user.personId)}|${systemId}|syntraGroup|${target}`];
    }
    case 'rbac.role_assigned': {
      const roleId = str(payload['roleId']);
      const user = target === null ? undefined : lookups.users.get(target);
      if (target === null || roleId === null || user === undefined) return [];
      return [`${userSubjectKey(target, user.personId)}|${SYNTRA_SYSTEM_ID}|syntraRole|${roleId}`];
    }
    case 'application.assign': {
      // Only a direct assignment to a user names whose access it is.
      const userId = str(payload['subjectId']);
      const user = userId === null ? undefined : lookups.users.get(userId);
      if (target === null || payload['subjectType'] !== 'user' || userId === null || user === undefined) return [];
      return [`${userSubjectKey(userId, user.personId)}|${SYNTRA_SYSTEM_ID}|application|${target}`];
    }
    case 'provision.action.result': {
      if (payload['status'] !== 'applied' || target === null) return [];
      const action = lookups.provisionActions.get(target);
      if (action === undefined || action.accountId === null) return [];
      const account = lookups.accounts.get(action.accountId);
      if (account === undefined) return [];
      const personId = action.personId ?? account.personId;
      if (action.actionType === 'create_account') {
        return [`person:${personId}|${account.targetSystemId}|targetAccount|${account.resourceId}`];
      }
      if (action.actionType === 'grant_entitlement' && action.entitlementId !== null) {
        return [`person:${personId}|${account.targetSystemId}|targetEntitlement|${action.entitlementId}`];
      }
      return [];
    }
    default: {
      const person = str(payload['personId']) ?? str(payload['subjectPersonId']);
      const resource = str(payload['resourceId']) ?? str(payload['entitlementId']);
      return person === null || resource === null ? [] : [`legacy|${person}|${resource}`];
    }
  }
}

/** Every key to the sequence of the latest event that explains it. */
export function gainExplanations(
  events: readonly GainAuditEvent[],
  lookups: GainLookups,
): Map<string, number> {
  const map = new Map<string, number>();
  const byLogin = loginIndex(lookups);
  for (const event of events) {
    for (const key of gainKeysFor(event, lookups, byLogin)) {
      const existing = map.get(key);
      if (existing === undefined || event.sequence > existing) map.set(key, event.sequence);
    }
  }
  return map;
}

/** The sequence that explains this gain, if any: the exact key first. */
export function explainingSequence(explanations: ReadonlyMap<string, number>, gain: GainRow): number | undefined {
  const exact = explanations.get(`${gain.subjectKey}|${gain.systemId}|${gain.resourceKind}|${gain.resourceId}`);
  if (exact !== undefined) return exact;
  return gain.personId === null ? undefined : explanations.get(`legacy|${gain.personId}|${gain.resourceId}`);
}
