import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { createUser } from '../directory/user-service.js';
import type { UpstreamIdpRecord } from './upstream-service.js';

export interface UpstreamProfile {
  /** The upstream `sub` or SAML NameID. The identity, not an attribute. */
  subject: string;
  login: string | null;
  email: string | null;
  displayName: string | null;
  /**
   * Group names the upstream asserted.
   *
   * Carried so the provisioning event can record them, and deliberately not
   * applied to local group membership: a Syntra group is an authorization, and
   * an upstream that can be talked into asserting `Domain Admins` would
   * otherwise grant it. Membership is Directory Sync's or an administrator's,
   * both of which are inside this deployment.
   */
  groups: string[];
}

export type ProvisionRefusal =
  /** No local account, and this upstream is not permitted to create one. */
  | 'no_local_user'
  /** The upstream sent nothing that could serve as a login identifier. */
  | 'incomplete_profile'
  /**
   * The local account this subject would adopt is already bound to a
   * *different* subject of the same upstream. See `linkOrProvision`.
   */
  | 'link_conflict'
  /**
   * A local account carries this login, and this upstream is not permitted to
   * take existing accounts over. The default.
   */
  | 'adoption_not_allowed'
  /**
   * A local account carries this login and holds a password credential or a
   * role assignment. Refused whatever the upstream is permitted to do.
   */
  | 'adoption_refused_privileged';

export type ProvisionResult =
  | { userId: string; created: boolean }
  | { userId: null; reason: ProvisionRefusal };

/**
 * Turns an upstream identity into a local `User`, creating one on first login
 * and refreshing the mapped attributes on later ones.
 *
 * **The subject is the identity; everything else is an attribute.** A
 * returning user is found through `UpstreamLink`, never by matching the email
 * address the upstream sent — an upstream that renames a mailbox would
 * otherwise create a second account on the next login, and an upstream that
 * can be talked into asserting somebody else's email would take over their
 * Syntra account. Matching by login happens exactly once, when a subject is
 * seen for the first time and a local account of that name already exists,
 * which is the migration case a tenant switching to federation needs.
 *
 * **That one-time adoption is fenced.** If the account it would adopt already
 * carries a link to a different subject of the *same* upstream, the adoption
 * is refused rather than performed: the upstream has either recycled a login
 * onto a new person — a leaver's address handed to their replacement is the
 * ordinary way this happens — or has been persuaded to assert one, and either
 * way completing it would hand a second person the first person's Syntra
 * account. Two subjects from *different* upstreams may share a local account;
 * that is a tenant federating to two providers, and it is what `UpstreamLink`
 * being keyed on `(upstreamIdpId, subject)` says.
 *
 * **A refusal is never silent.** Each one returns a reason its caller renders
 * and audits; Directory Sync learned what a dropped record costs when the next
 * run reads its absence as a departure.
 *
 * **It grants nothing.** It returns a user id. Whether that user may have a
 * session is `authorize()`'s decision, made afterwards with
 * `Principal.external`. In particular this function does not reactivate a
 * deactivated account: an offboarded employee whose upstream account still
 * works must not sign themselves back in, and `authorize()` refuses an
 * inactive user in one place for every path.
 *
 * Database only — the token has already been verified by the time this runs,
 * so there is no network work inside the transaction.
 */
export async function linkOrProvision(
  tenantId: string,
  upstream: UpstreamIdpRecord,
  profile: UpstreamProfile,
): Promise<ProvisionResult> {
  return withTenant(tenantId, async (tx): Promise<ProvisionResult> => {
    const link = await tx.upstreamLink.findFirst({
      where: { upstreamIdpId: upstream.id, subject: profile.subject },
    });

    if (link) {
      if (upstream.refreshOnLogin) {
        // The login is deliberately not refreshed. It is the account's name
        // here, unique within the tenant, and rewriting it from an upstream
        // attribute either collides with somebody else's account or silently
        // renames the one an administrator is looking at. A changed upstream
        // login is an attribute change, and the link is what carries identity.
        await tx.user.update({
          where: { id: link.userId },
          data: {
            ...(profile.email ? { email: profile.email } : {}),
            ...(profile.displayName ? { displayName: profile.displayName } : {}),
          },
        });
      }
      await tx.upstreamLink.update({
        where: { id: link.id },
        data: { lastLoginAt: new Date() },
      });
      return { userId: link.userId, created: false };
    }

    const login = profile.login ?? profile.email;
    if (!login) return { userId: null, reason: 'incomplete_profile' };

    // First time this subject has been seen. An account already carrying the
    // login is adopted — the migration case — and otherwise one is created if
    // the tenant permits it.
    const existing = await tx.user.findFirst({ where: { login } });

    let userId: string;
    let created = false;

    if (existing) {
      const bound = await tx.upstreamLink.findFirst({
        where: { upstreamIdpId: upstream.id, userId: existing.id },
      });
      if (bound) return { userId: null, reason: 'link_conflict' };

      // ADOPTION IS A TAKEOVER, and it is off unless somebody turned it on.
      //
      // The upstream chooses what it asserts. An identity provider naming
      // `admin` — configured to, or compromised into it — was handed the
      // Syntra account called `admin`, roles and password intact, with an
      // `UpstreamLink` now attached so every later login walks straight in.
      // Directory Sync refuses precisely this and calls it a conflict rather
      // than an adoption; §10 of its design says why in one line, and the
      // reason does not change because the claim arrived over SAML.
      if (!upstream.allowLoginAdoption) {
        return { userId: null, reason: 'adoption_not_allowed' };
      }

      // AND EVEN THEN, not these two.
      //
      // An administrator turning the flag on is consenting to a migration —
      // accounts that exist because people were pre-created, holding nothing
      // yet. They are not consenting to hand over an account that already has
      // a password somebody signs in with, or authority somebody granted it.
      // Those are the two accounts worth stealing, so the flag does not reach
      // them and no setting exists that does.
      const [password, role] = await Promise.all([
        tx.passwordCredential.findFirst({
          where: { userId: existing.id },
          select: { userId: true },
        }),
        tx.roleAssignment.findFirst({
          where: { userId: existing.id },
          select: { id: true },
        }),
      ]);
      if (password || role) {
        return { userId: null, reason: 'adoption_refused_privileged' };
      }

      userId = existing.id;
    } else {
      if (!upstream.createUsers) return { userId: null, reason: 'no_local_user' };
      const user = await createUser(tx, {
        login,
        email: profile.email ?? login,
        displayName: profile.displayName ?? login,
        ...(upstream.defaultOrgUnitId ? { orgUnitId: upstream.defaultOrgUnitId } : {}),
      });
      userId = user.id;
      created = true;
    }

    // The password lives upstream, so self-service reset must send them there
    // rather than mailing a token for a credential Syntra does not hold.
    await tx.user.update({
      where: { id: userId },
      data: { passwordSource: 'upstream', passwordSourceHint: upstream.name },
    });

    await tx.upstreamLink.create({
      data: {
        tenantId,
        upstreamIdpId: upstream.id,
        userId,
        subject: profile.subject,
        lastLoginAt: new Date(),
      },
    });

    // In the same transaction as the write it describes. A local account that
    // appeared because a third party asserted a claim is exactly the kind of
    // write an administrator has to be able to find afterwards, and the
    // asserted groups are recorded here because nothing else in Syntra acts
    // on them.
    await recordEvent(tx, {
      actorUserId: userId,
      action: created ? 'federation.user_provisioned' : 'federation.user_linked',
      targetType: 'User',
      targetId: userId,
      outcome: 'success',
      sourceIp: null,
      payload: {
        upstreamIdpId: upstream.id,
        upstream: upstream.name,
        subject: profile.subject,
        assertedGroups: profile.groups,
      },
    });

    return { userId, created };
  });
}

/**
 * Reads the mapped claims off a verified token payload.
 *
 * Separate from `linkOrProvision` because the mapping is the part that differs
 * between OIDC and SAML while the provisioning decision is the part that must
 * not. A claim that is present but not a non-empty string is treated as
 * absent: an upstream that sends `email: null`, `email: 42` or `email: []`
 * has not sent an email address, and coercing one would put `[object Object]`
 * into a directory.
 */
export function mapClaims(
  upstream: Pick<
    UpstreamIdpRecord,
    'loginAttribute' | 'emailAttribute' | 'displayNameAttribute' | 'groupsAttribute'
  >,
  claims: Record<string, unknown>,
): UpstreamProfile {
  return {
    subject: typeof claims.sub === 'string' ? claims.sub : '',
    login: text(claims[upstream.loginAttribute]),
    email: text(claims[upstream.emailAttribute]),
    displayName: text(claims[upstream.displayNameAttribute]),
    groups: upstream.groupsAttribute ? list(claims[upstream.groupsAttribute]) : [],
  };
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A single group name is not a type error; an object among them is dropped. */
function list(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}
