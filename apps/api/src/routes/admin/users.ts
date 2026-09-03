import type { FastifyInstance } from 'fastify';
import { statusPageQuery } from './list-query.js';
import {
  adminFactorParams,
  createUserRequest,
  deactivateUserRequest,
  idParam,
  patchUserDetailsRequest,
  setUserPasswordRequest,
  patchUserRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  clearLockout,
  isLocked,
  lockedWhere,
  createUser,
  deactivateDirectoryUser,
  deleteDirectoryUser,
  reactivateDirectoryUser,
  issuePasswordSetup,
  listUsers,
  localMasterKeyProvider,
  hasPermission,
  linkUserToPerson,
  matchPersonForAccount,
  recordEvent,
  setPasswordAsAdmin,
  removeRecoveryCodes,
  type Scheduler,
  removeTotp,
  revokeOrphanedRecoveryCodes,
  type DeactivateOutcome,
  type IssueSetupOutcome,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface AdminUserRouteOptions {
  /** Unseals a directory source's bind credential for a write-back. */
  masterKey: Buffer;
  /**
   * Composes the setup link, so both password flows land on the one route the
   * reset mail already points at.
   */
  publicUrl: string;
  /**
   * Late-bound on purpose. The scheduler talks to pg-boss and is started
   * after the app is built -- and it is allowed to fail to start without
   * keeping the API down -- so these routes ask for it when they need it
   * rather than being handed one at registration.
   */
  scheduler?: () => Scheduler | null;
}

/**
 * Turns a refusal from the write-back service into the HTTP answer for it.
 *
 * Separate from the routes because deactivate and reactivate refuse for
 * exactly the same reasons, and two copies of this mapping is how one of them
 * ends up answering 500 for a case the other explains.
 */
function raiseIfRefused(outcome: DeactivateOutcome): void {
  if (outcome.ok) return;
  switch (outcome.reason) {
    case 'not_found':
      throw new ProblemError(404, 'not-found', 'User not found');
    case 'writeback_not_enabled':
      // 409, not 403: the caller has the permission, the configuration does
      // not allow the write. Refusing rather than doing it locally is
      // deliberate -- a local-only status change on a directory-managed
      // account is undone by the next sync run, which is a button that
      // appears to work and does not.
      throw new ProblemError(
        409,
        'writeback-not-enabled',
        'Write-back is not enabled for this source',
        `This account is owned by ${outcome.sourceName}, and Syntra is not ` +
          `permitted to change accounts there. Enable write-back on that ` +
          `source, or disable the account in the directory itself.`,
      );
    case 'no_credential':
      throw new ProblemError(
        500,
        'source-credential-missing',
        'The source credential could not be read',
        `The stored bind credential for ${outcome.sourceName} could not be ` +
          `unsealed, so nothing was changed.`,
      );
    case 'directory_failed':
      // 502: an upstream system answered, and said no.
      throw new ProblemError(
        502,
        'directory-write-failed',
        'The directory refused the change',
        `Nothing was changed. The directory reported: ${outcome.message}.`,
      );
  }
}

export async function registerAdminUserRoutes(
  app: FastifyInstance,
  options: AdminUserRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);

  app.get(
    '/users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { q, status, page, pageSize } = statusPageQuery.parse(request.query);
      const { result, locks } = await request.db(async (tx) => {
        const result = await listUsers(tx, { search: q, status, page, pageSize });
        return {
          result,
          // Scoped to the page. This used to read every lockout row for a list
          // that was every user; now both are bounded, and the narrower read is
          // strictly less work than the join it still replaces.
          locks: await tx.loginLockout.findMany({
            where: { userId: { in: result.rows.map((u) => u.id) } },
            select: { userId: true, lockedAt: true, lockedUntil: true },
          }),
        };
      });

      const now = new Date();
      const lockedIds = new Set(
        locks.filter((l) => isLocked(l, now)).map((l) => l.userId),
      );
      return {
        users: result.rows.map((u) => ({ ...u, locked: lockedIds.has(u.id) })),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      };
    },
  );

  /**
   * The numbers the directory screen puts on its stat cards.
   *
   * Server-side because the page used to compute them by filtering the full
   * collections it had fetched, and paging turns that into page-sized numbers
   * that still look like totals -- worse than showing nothing.
   *
   * Both permissions, because the answer spans both halves of the directory.
   * `locked` cannot come from a list filter: it is derived from lockout state
   * rather than a User column, and answering it with a join in the route would
   * put that logic in the wrong layer.
   */
  app.get(
    '/directory/summary',
    {
      preHandler: [
        requirePermission(PERMISSIONS.IDENTITY_READ),
        requirePermission(PERMISSIONS.DIRECTORY_READ),
      ],
    },
    async (request) => {
      const now = new Date();
      return request.db(async (tx) => {
        const [
          people,
          activePeople,
          accounts,
          activeAccounts,
          locks,
          groups,
          groupsFromDirectory,
          inactiveGroups,
          peopleWithoutAccount,
        ] = await Promise.all([
          tx.person.count(),
          tx.person.count({ where: { status: 'active' } }),
          tx.user.count(),
          tx.user.count({ where: { status: 'active' } }),
          // Counted in the database, not read out and filtered here. This
          // was every lockout row in the tenant loaded into the process on
          // every render of the directory screen -- the same client-side
          // counting over a whole collection that this endpoint exists to
          // have stopped.
          tx.loginLockout.count({ where: lockedWhere(now) }),
          tx.group.count(),
          tx.group.count({ where: { sourceId: { not: null } } }),
          tx.group.count({ where: { status: { not: 'active' } } }),
          // An active person with nobody to sign in as. THE number on this
          // screen that needs acting on, and it used to be guessed by
          // subtracting all accounts from active people -- which counts
          // service accounts, leavers' accounts and second accounts against
          // the joiners, so it read zero on any real tenant and invented a
          // backlog on others.
          //
          // Raw because `User.personId` carries no Prisma relation to follow
          // -- it is a bare column, deliberately, since a person routinely has
          // no account -- so there is no `users: { none: {} }` to write. RLS
          // applies here as to any other statement on this connection.
          tx.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) AS count
            FROM "Person" p
            WHERE p.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM "User" u WHERE u."personId" = p.id
              )
          `,
        ]);
        return {
          people: {
            total: people,
            active: activePeople,
            withoutAccount: Number(peopleWithoutAccount[0]?.count ?? 0),
          },
          accounts: {
            total: accounts,
            active: activeAccounts,
            locked: locks,
          },
          // The groups page counts these three the same way the directory page
          // counted its two: over the whole table, because a page-sized number
          // that still looks like a total is worse than no number.
          groups: {
            total: groups,
            fromDirectory: groupsFromDirectory,
            inactive: inactiveGroups,
          },
        };
      });
    },
  );

  /**
   * The same three group numbers, for a caller who may only read the
   * directory.
   *
   * Split out because the combined summary above spans both halves of the
   * directory and so demands both permissions -- which made the groups screen,
   * a screen that needs `directory.read` and nothing else, depend on
   * `identity.read` to render its own stat cards. A group administrator got a
   * 403 there and three zeroes above a table listing thousands of groups.
   *
   * Counted over the whole table, like everything else on a stat card here: a
   * page-sized number that still reads as a total is worse than no number.
   */
  app.get(
    '/groups/summary',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      return request.db(async (tx) => {
        const [total, fromDirectory, inactive] = await Promise.all([
          tx.group.count(),
          tx.group.count({ where: { sourceId: { not: null } } }),
          tx.group.count({ where: { status: { not: 'active' } } }),
        ]);
        return { groups: { total, fromDirectory, inactive } };
      });
    },
  );

  /**
   * Every account with nobody behind it, and who it might be.
   *
   * Declared BEFORE `/users/:id` so a reader meets the static path first.
   * Fastify's radix router prefers a static segment over a parametric one, so
   * the ordering is not load-bearing — but a file that depends on that being
   * remembered is a file that breaks the day somebody reorders it.
   *
   * `identity.read` rather than `directory.read`: the answer is a list of
   * people, and reading people is what that permission is for.
   */
  app.get(
    '/users/unlinked',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      return request.db(async (tx) => {
        const users = await tx.user.findMany({
          where: { personId: null, status: 'active' },
          orderBy: { login: 'asc' },
          select: { id: true, login: true, displayName: true, email: true },
        });

        const accounts = [];
        for (const user of users) {
          // Reads the person table once per account. That is the honest cost
          // of the matcher's shape and is accepted here: this serves one
          // screen, run rarely, over a backlog somebody is actively clearing.
          // If it ever matters the fix is to hoist the person read out of the
          // matcher, not to cache it here.
          const match = await matchPersonForAccount(tx, {
            email: user.email,
            displayName: user.displayName,
          });
          accounts.push({
            ...user,
            topCandidate: match.confident ?? match.candidates[0] ?? null,
          });
        }
        return { accounts };
      });
    },
  );

  /**
   * Who this account might belong to.
   *
   * An account that already has a person answers with an empty list rather
   * than a 409: the caller is a screen deciding whether to render a control,
   * and a refusal it has to catch is a worse contract than nothing to show.
   */
  app.get(
    '/users/:id/person-candidates',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const user = await tx.user.findUnique({ where: { id } });
        if (!user) throw new ProblemError(404, 'not-found', 'User not found');
        if (user.personId) return { candidates: [] };

        const match = await matchPersonForAccount(tx, {
          email: user.email,
          displayName: user.displayName,
        });
        // Flattened. The screen ranks by `rule` and does not need to know one
        // of them was strong enough to have auto-linked, because by definition
        // it did not — either nothing matched confidently, or the confident
        // match already had an account and was demoted.
        return {
          candidates: match.confident
            ? [match.confident, ...match.candidates]
            : match.candidates,
        };
      });
    },
  );

  /**
   * One account, for the screen that is about one account.
   *
   * Every field the account screen needs and cannot derive: the lock, the
   * source that owns it, and the person behind it BY NAME. Reading the whole
   * directory to render one row is what this replaces -- a page whose cost
   * grew with the size of the tenant rather than with what it displayed.
   *
   * `person` is embedded rather than left as `personId` because the screen
   * links back to the person and cannot render a name from an id. It is a
   * three-field projection, not the person record: contracts and access belong
   * to the person's own screen, and duplicating them here would be two places
   * to keep true.
   */
  app.get(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      return request.db(async (tx) => {
        const user = await tx.user.findUnique({ where: { id } });
        // 404 rather than an empty body: an account that was deleted and an
        // account the caller mistyped are the same URL, and both need to read
        // as "no such account" instead of as an account with nothing in it.
        if (!user) throw new ProblemError(404, 'not-found', 'User not found');

        const lock = await tx.loginLockout.findUnique({
          where: { userId: id },
          select: { lockedAt: true, lockedUntil: true },
        });

        const person = user.personId
          ? await tx.person.findUnique({
              where: { id: user.personId },
              select: { id: true, givenName: true, familyName: true },
            })
          : null;

        return { ...user, locked: isLocked(lock, new Date()), person };
      });
    },
  );

  app.post(
    '/users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const body = createUserRequest.parse(request.body);

      // One transaction: if the audit write fails, the user is not created
      // either. A change without its audit entry is worse than no change.
      const user = await request.db(async (tx) => {
        // Linking writes to a Person, which is `identity.write`. A caller who
        // may create accounts but not touch people is refused an explicit
        // person outright, and has the matcher skipped entirely below — an
        // auto-link is still a write to a person, and a convenience feature
        // does not get to step over a permission boundary.
        const mayLink = await hasPermission(
          tx,
          request.session.userId,
          PERMISSIONS.IDENTITY_WRITE,
        );
        if (body.personId && !mayLink) {
          throw new ProblemError(
            403,
            'forbidden',
            'Forbidden',
            'Linking an account to a person requires identity.write.',
          );
        }

        let personId: string | null = body.personId ?? null;

        if (body.personId) {
          const person = await tx.person.findUnique({ where: { id: body.personId } });
          if (!person) throw new ProblemError(404, 'not-found', 'Person not found');

          if (!body.allowSecondAccount) {
            // Active only. Replacing a leaver's account is not a duplicate,
            // and warning about one would be the kind of false alarm that
            // teaches people to click through without reading.
            const existing = await tx.user.findFirst({
              where: { personId: body.personId, status: 'active' },
              select: { id: true, login: true },
            });
            if (existing) {
              throw new ProblemError(
                409,
                'second-account',
                'They already have an account',
                `${person.givenName} ${person.familyName} already signs in as ${existing.login}. A contractor with two contracts legitimately has two accounts, so confirm to create this one as well.`,
                { existingAccount: existing },
              );
            }
          }
        } else if (body.personId === undefined && mayLink) {
          // Omitted, not null. `null` is somebody saying "service account",
          // and matching one would be answering a question they answered.
          const match = await matchPersonForAccount(tx, {
            email: body.email,
            displayName: body.displayName,
          });
          // A confident match who already signs in somewhere is demoted HERE
          // rather than in the matcher: auto-linking would produce the second
          // account the warning above exists for, without the warning. It
          // still surfaces as a suggestion on the account's own screen.
          if (match.confident && !match.confident.hasActiveAccount) {
            personId = match.confident.personId;
          }
        }

        let created;
        try {
          created = await createUser(tx, {
            login: body.login,
            email: body.email,
            displayName: body.displayName,
            ...(body.orgUnitId ? { orgUnitId: body.orgUnitId } : {}),
          });
        } catch (error) {
          // Both pre-checks in `createUser` raise a plain Error so the domain
          // stays free of HTTP, and both are the same answer to the caller:
          // something already here has this, and it is not a request that can
          // be confirmed past.
          if (
            error instanceof Error &&
            /(login already exists|email already in use)/i.test(error.message)
          ) {
            throw new ProblemError(409, 'conflict', 'Conflict', error.message);
          }
          throw error;
        }

        if (personId) {
          await linkUserToPerson(tx, created.id, personId);
          if (!body.personId) {
            // Named, and never silent: an administrator who wonders why an
            // account has a person can read which rule decided it.
            await recordEvent(tx, {
              actorUserId: request.session.userId,
              action: 'user.autolinked',
              targetType: 'User',
              targetId: created.id,
              outcome: 'success',
              sourceIp: request.ip,
              payload: { personId, rule: 'businessEmail' },
            });
          }

          // The unit reaches the PERSON too, but only when theirs is null.
          //
          // `User.orgUnitId` feeds access resolution; `Person.orgUnitId` is
          // what the placement ladder reads, so without this an account
          // created here has a unit for access and still lands in the
          // fallback container on every target. Overwriting a unit the person
          // already has would undo a decision made about the person — and any
          // AccountPlacement protecting a manual move — from a form whose
          // subject is the account.
          if (body.orgUnitId) {
            const person = await tx.person.findUnique({
              where: { id: personId },
              select: { orgUnitId: true },
            });
            if (person && person.orgUnitId === null) {
              await tx.person.update({
                where: { id: personId },
                data: { orgUnitId: body.orgUnitId },
              });
            }
          }
        }

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.create',
          targetType: 'User',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { login: created.login, email: created.email, personId },
        });
        return created;
      });

      return reply.status(201).send(user);
    },
  );

  app.post(
    '/users/:id/deactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = deactivateUserRequest.parse(request.body);

      const outcome = await deactivateDirectoryUser(request.tenantId, provider, {
        userId: id,
        reason,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
        scheduler: options.scheduler?.() ?? null,
      });
      raiseIfRefused(outcome);
      return request.db((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
    },
  );

  app.post(
    '/users/:id/reactivate',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // NO session is restored, and that is not an omission. Deactivation
      // revoked every session and refresh token; reactivation gives back the
      // ability to sign in, not the sessions that were killed.
      const outcome = await reactivateDirectoryUser(request.tenantId, provider, {
        userId: id,
        reason: 'reactivated by an administrator',
        actorUserId: request.session.userId,
        sourceIp: request.ip,
        scheduler: options.scheduler?.() ?? null,
      });
      raiseIfRefused(outcome);
      return request.db((tx) => tx.user.findUniqueOrThrow({ where: { id } }));
    },
  );

  /**
   * Lifts an account lockout by hand.
   *
   * Needed because `lockoutDurationMinutes` of zero is a legitimate setting —
   * a lock that never lifts itself — and because the alternative for the
   * strictest tenants is telling a locked-out user to wait a week.
   *
   * Deliberately idempotent and deliberately silent about whether there was a
   * lock: DIRECTORY_WRITE is already required to reach it, so there is no
   * enumeration concern, and refusing an unlock on an unlocked account is a
   * confusing error for an administrator acting on a support call.
   */
  app.post(
    '/users/:id/unlock',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id } });
        await clearLockout(tx, id);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'auth.lockout_cleared',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { login: user.login },
        });
        return user;
      });
    },
  );

  /**
   * Deletion, where everything else in this directory deactivates.
   *
   * Offered because a directory that can never forget anything becomes its own
   * problem, and gated three ways because it is the one operation here that
   * doing the opposite does not undo: a permission of its own, a per-source
   * flag of its own, and a confirmation in the console that makes the reader
   * type the login.
   *
   * The Person and the audit trail survive it. See `deleteDirectoryUser`.
   */
  app.delete(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_DELETE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const outcome = await deleteDirectoryUser(request.tenantId, provider, {
        userId: id,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      });

      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'not_found':
            throw new ProblemError(404, 'not-found', 'User not found');
          case 'delete_not_enabled':
            // 409, not 403: the caller HAS the permission and the
            // configuration does not allow the write. The detail says why
            // deleting the Syntra row alone would be worse than refusing.
            throw new ProblemError(
              409,
              'delete-not-enabled',
              'This account cannot be deleted',
              `${outcome.sourceName} is not configured to let Syntra delete objects in it, and removing only the Syntra record would leave the next sync run free to create the account again`,
            );
          case 'no_credential':
            throw new ProblemError(
              409,
              'no-credential',
              'This account cannot be deleted',
              `the bind credential for ${outcome.sourceName} could not be unsealed`,
            );
          case 'directory_failed':
            // 502: Syntra worked, the directory refused. Nothing was changed
            // on either side, which the message says so nobody goes looking
            // for a half-finished delete.
            throw new ProblemError(
              502,
              'directory-failed',
              'The directory refused the delete',
              `${outcome.message}; nothing was changed in Syntra either`,
            );
        }
      }

      return reply.status(204).send();
    },
  );

  /**
   * Moves a user's password between Syntra and an upstream identity provider.
   *
   * The flag self-service reset reads: an `upstream` user cannot reset a
   * password Syntra does not hold, and is mailed the name recorded here
   * instead. That mail is the only place the distinction is visible — the HTTP
   * response to a reset request is identical either way, because a different
   * response would announce both that the account exists and that it is
   * federated to anyone who can type a login name.
   */
  app.patch(
    '/users/:id',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchUserRequest.parse(request.body);

      const updated = await request.db(async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) {
          throw new ProblemError(404, 'not-found', 'User not found');
        }

        const user = await tx.user.update({
          where: { id },
          data: {
            ...(body.passwordSource === undefined
              ? {}
              : { passwordSource: body.passwordSource }),
            ...(body.passwordSourceHint === undefined
              ? {}
              : { passwordSourceHint: body.passwordSourceHint }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.update',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { passwordSource: user.passwordSource },
        });
        return user;
      });

      return {
        id: updated.id,
        passwordSource: updated.passwordSource,
        passwordSourceHint: updated.passwordSourceHint,
      };
    },
  );

  /**
   * Mints a password-setup link for a user who has no password.
   *
   * The gap this fills: self-service change needs the password they do not
   * have, and the reset flow needs a mailbox a joiner may not have yet, so
   * before this there was no way to give anybody a first password.
   *
   * The link is returned rather than mailed, because mailing does not serve
   * the case it exists for. It is a bearer credential and is bounded by two
   * things: a 24-hour expiry, and the audit event `issuePasswordSetup` writes
   * naming the administrator who minted it.
   */
  app.post(
    '/users/:id/password-setup',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);

      let issued: IssueSetupOutcome;
      try {
        issued = await request.db((tx) =>
          issuePasswordSetup(tx, {
            userId: id,
            actorUserId: request.session.userId,
            sourceIp: request.ip,
          }),
        );
      } catch (cause) {
        // Two issuances for the same user at once: one wins the partial unique
        // index `password_reset_token_one_live` and the other violates it.
        //
        // The reset path swallows this and sends nothing, because surfacing it
        // there builds an account-existence oracle out of an error page. That
        // argument buys nothing against a caller who already holds
        // `directory.write`, and swallowing it here would answer 200 with a
        // link that was invalidated before it reached the caller. A 409 says
        // "that raced, do it again", which is true and actionable.
        if ((cause as { code?: string }).code === 'P2002') {
          throw new ProblemError(
            409,
            'conflict',
            'Setup link already being created',
            'Another setup link was being created for this user at the same time. Try again.',
          );
        }
        throw cause;
      }

      if (!issued.ok) {
        if (issued.reason === 'unknown_user') {
          throw new ProblemError(404, 'not-found', 'User not found');
        }
        const user = await request.db((tx) =>
          tx.user.findUnique({ where: { id }, select: { passwordSourceHint: true } }),
        );
        throw new ProblemError(
          409,
          'password-source-not-local',
          'Password not held here',
          `This user's password is held by ${user?.passwordSourceHint ?? 'an external identity provider'}, so Syntra cannot set it.`,
        );
      }

      return {
        url: `${options.publicUrl.replace(/\/$/, '')}/reset-password?token=${issued.token}`,
        expiresAt: issued.expiresAt.toISOString(),
      };
    },
  );

  /**
   * Takes a factor off a user.
   *
   * The way back in for someone who lost their phone, and the way an
   * administrator revokes a factor an attacker enrolled. It writes its own
   * audit event in the same transaction as the removal, naming the
   * administrator: a factor that disappears with nothing to show who removed
   * it is indistinguishable from one the attacker removed.
   */
  app.delete(
    '/users/:id/factors/:type',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const { id, type } = adminFactorParams.parse(request.params);

      const orphanedCodes = await request.db(async (tx) => {
        if (type === 'totp') await removeTotp(tx, id);
        else if (type === 'recovery_code') await removeRecoveryCodes(tx, id);
        else await tx.webAuthnCredential.deleteMany({ where: { userId: id } });

        // Recovery codes are a way back in when a real factor is lost, not a
        // factor of their own — which is why issuing them requires holding
        // one. Taking the last real factor away and leaving the codes reaches
        // the state that gate exists to prevent, by another door: a
        // `require_mfa` rule stays satisfied by a printed page forever, and
        // the forced-enrolment path is never reached.
        const revoked = await revokeOrphanedRecoveryCodes(tx, id);

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.removed',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            factor: type,
            by: 'administrator',
            // Named, so a user who finds their codes stopped working can be
            // told why by someone reading the log.
            recoveryCodesRevoked: revoked,
          },
        });
        return revoked;
      });

      return reply.status(200).send({ recoveryCodesRevoked: orphanedCodes });
    },
  );

  /**
   * The user's own details: what they are called, where mail reaches them, and
   * where they sit in the organization.
   *
   * Separate from `PATCH /users/:id`, which is about where the PASSWORD lives
   * and nothing else. Folding the two together would put a field that changes
   * how authentication works in the same request as a display-name fix, and
   * the audit rows would stop distinguishing them.
   *
   * `login` is not editable here. It is what somebody types to sign in and what
   * the audit trail is read by; changing it is an account migration, not an
   * edit.
   *
   * A source-owned account is refused: the next sync run reads these fields
   * from the directory and would overwrite the change.
   */
  app.patch(
    '/users/:id/details',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = patchUserDetailsRequest.parse(request.body);

      return request.db(async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } });
        if (!existing) throw new ProblemError(404, 'not-found', 'User not found');
        if (existing.sourceId) {
          throw new ProblemError(
            409,
            'source-owned',
            'Managed by a directory source',
            'This account is read from a directory source, and the next sync run would overwrite the change. Edit it where it comes from.',
          );
        }

        if (body.email !== undefined) {
          // Same rule as the create path and the partial index behind it:
          // active, locally managed accounts only, case-insensitively.
          // Excluding this account is what lets a rename leave the address
          // alone without colliding with itself.
          const sharing = await tx.user.findFirst({
            where: {
              email: { equals: body.email, mode: 'insensitive' },
              sourceId: null,
              status: 'active',
              id: { not: id },
            },
          });
          if (sharing) {
            throw new ProblemError(
              409,
              'conflict',
              'Conflict',
              `email already in use: ${body.email}`,
            );
          }
        }

        if (body.orgUnitId !== undefined && body.orgUnitId !== null) {
          const unit = await tx.orgUnit.findUnique({ where: { id: body.orgUnitId } });
          if (!unit) throw new ProblemError(404, 'not-found', 'Org unit not found');
        }

        const updated = await tx.user.update({
          where: { id },
          data: {
            ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.orgUnitId === undefined ? {} : { orgUnitId: body.orgUnitId }),
          },
        });
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.updateDetails',
          targetType: 'User',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            from: {
              displayName: existing.displayName,
              email: existing.email,
              orgUnitId: existing.orgUnitId,
            },
            to: {
              displayName: updated.displayName,
              email: updated.email,
              orgUnitId: updated.orgUnitId,
            },
          },
        });
        return {
          id: updated.id,
          login: updated.login,
          displayName: updated.displayName,
          email: updated.email,
          orgUnitId: updated.orgUnitId,
        };
      });
    },
  );

  /**
   * Setting a password on somebody's behalf.
   *
   * Guarded by `directory.write` and NO step-up, matching `password-setup`
   * above. The two are the same authority over the same account — one hands
   * over a credential directly, the other hands over a link that mints one —
   * and they must not disagree about what it takes to exercise it. If step-up
   * is wanted it belongs on both, as one change to how credential operations
   * are guarded, rather than as an inconsistency introduced here.
   */
  app.post(
    '/users/:id/password',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { password } = setUserPasswordRequest.parse(request.body);

      const outcome = await setPasswordAsAdmin(request.tenantId, {
        userId: id,
        actorUserId: request.session.userId,
        newPassword: password,
        sourceIp: request.ip,
      });

      if (outcome.ok) {
        return { sessionsRevoked: outcome.sessionsRevoked, mustChange: true };
      }

      switch (outcome.reason) {
        case 'not_found':
          throw new ProblemError(404, 'not-found', 'User not found');
        case 'upstream':
          throw new ProblemError(
            409,
            'upstream-password',
            'Password not held here',
            `This account signs in through ${
              outcome.hint ?? 'an upstream identity provider'
            }, which holds the password. Change it there.`,
          );
        case 'directory_owned':
          throw new ProblemError(
            409,
            'directory-owned-password',
            'Password not held here',
            'This account’s password lives in the directory that syncs it, and Syntra can only change a directory password when the current one is supplied. Change it in the directory, or send a password link instead.',
          );
        case 'weak_password':
          // 422 rather than 400: the body parsed, and the value was understood
          // and refused. A 400 reads as a malformed request and sends somebody
          // looking at their JSON.
          throw new ProblemError(
            422,
            'weak-password',
            'That password was refused',
            outcome.detail,
          );
        case 'reused':
          throw new ProblemError(
            422,
            'reused-password',
            'That password was refused',
            `It is one of this account’s last ${outcome.depth} passwords.`,
          );
      }
    },
  );
}
