import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrationState, prisma, withTenant } from '@syntra/db';
import { getSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

/**
 * Whether this process can do its job — as distinct from whether it is running.
 *
 * `/health` answers the second question and answers it with a constant. That
 * is correct for what it is (a liveness probe for the tunnel and for
 * `deploy.sh`) and useless as the gate on anything consequential: it returns
 * 200 with the database unreachable, the migration half-applied, the vault
 * key wrong and the web bundle missing.
 *
 * This exists because the updater needs a question that CAN be answered "no".
 * An automatic rollback hung on a check that cannot fail would report every
 * broken update as a success, roll back nothing, and leave an operator
 * looking at a green tick on a dead system.
 *
 * Every probe here is chosen against the same test: **would a bad update pass
 * it?** Anything a broken release would sail through is not a gate, it is
 * decoration.
 */

export type ProbeStatus = 'pass' | 'fail' | 'skip';

export interface Probe {
  name: string;
  status: ProbeStatus;
  /** One sentence, safe to show unauthenticated. Never a stack trace. */
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  version: string;
  probes: Probe[];
}

export interface ReadinessDeps {
  provider: MasterKeyProvider;
  /** Where the built console is served from, when one is configured. */
  webRoot?: string | undefined;
  version: string;
  /** Overridden by the tests only; nothing in the application passes it. */
  probeTimeoutMs?: number | undefined;
}

const pass = (name: string, detail: string): Probe => ({ name, status: 'pass', detail });
const fail = (name: string, detail: string): Probe => ({ name, status: 'fail', detail });
const skip = (name: string, detail: string): Probe => ({ name, status: 'skip', detail });

/**
 * The reason a probe failed, reduced to one line and stripped of anything that
 * would leak. These answers are unauthenticated: they may say *that* the
 * database is unreachable, never the connection string it tried.
 */
function reason(cause: unknown): string {
  if (!(cause instanceof Error)) return 'unknown error';
  return cause.message.split('\n')[0]!.slice(0, 200);
}

/**
 * How long any one probe may take before it is a failure.
 *
 * `/health/ready` is what the updater's automatic rollback decision waits on,
 * and none of these probes had a deadline. A database that accepts TCP and
 * then stops answering -- a failed-over primary, a saturated pool, a paused
 * container -- leaves the query pending for ever: the gate never resolves, the
 * rollback that was waiting on it never happens, and an operator watching a
 * broken update sees a request that simply hangs.
 *
 * Five seconds because every probe here is one indexed round trip and an AES
 * unseal. Anything slower than that is already an answer.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Runs a probe with a deadline, and turns overrunning it into a `fail`.
 *
 * A failure rather than a `skip`, deliberately. "I could not find out" and
 * "there is nothing to check" are different answers, and only the first should
 * roll an update back.
 */
async function withTimeout(
  name: string,
  ms: number,
  work: () => Promise<Probe>,
): Promise<Probe> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Probe>((resolve) => {
    timer = setTimeout(
      () => resolve(fail(name, `did not answer within ${ms} ms`)),
      ms,
    );
    // Never keeps the process alive on its own. A readiness check must not be
    // the reason a shutdown waits.
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The database is reachable BY THIS PROCESS, with its own pool and its own
 * credentials — which is a different claim from "postgres is running", and the
 * one that matters after an update changed the environment.
 */
async function probeDatabase(): Promise<Probe> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return pass('database', 'reachable');
  } catch (cause) {
    return fail('database', `not reachable: ${reason(cause)}`);
  }
}

/**
 * The schema matches the code. The characteristic bad update is a migration
 * that half-applied: the API starts happily against it, and the first request
 * touching the missing column fails an hour later on one route.
 */
async function probeMigrations(): Promise<Probe> {
  try {
    const state = await migrationState();
    if (state.failed.length > 0) {
      return fail(
        'migrations',
        `${state.failed.length} migration(s) started and did not finish: ${state.failed.join(', ')}`,
      );
    }
    if (state.pending.length > 0) {
      return fail(
        'migrations',
        `${state.pending.length} migration(s) not applied: ${state.pending.join(', ')}`,
      );
    }
    // Applied-but-not-on-disk is the ordinary state right after a rollback to
    // an older release. Reported, never failed: a rollback whose own readiness
    // check refused would roll itself back again, forever.
    const note = state.unknown.length > 0 ? ` (${state.unknown.length} newer than this build)` : '';
    return pass('migrations', `${state.applied} applied${note}`);
  } catch (cause) {
    return fail('migrations', `could not be read: ${reason(cause)}`);
  }
}

/**
 * `MASTER_KEY` still unseals the vault.
 *
 * The failure this catches is specific and nasty: a wrong or missing master
 * key leaves everything looking perfect until somebody tries to sign in
 * through SAML or OIDC, because the signing key is sealed and cannot be
 * decrypted. Ordinary password sign-in keeps working, so nothing complains
 * until the applications do.
 *
 * A deployment with no secrets at all is a fresh install, not a broken one,
 * and skips rather than fails.
 */
async function probeVault(provider: MasterKeyProvider): Promise<Probe> {
  try {
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) return skip('vault', 'no tenants yet');

    const secretName = await withTenant(tenant.id, async (tx) => {
      const key = await tx.signingKey.findFirst({
        where: { status: 'active' },
        select: { secretName: true },
      });
      return key?.secretName ?? null;
    });
    if (secretName === null) return skip('vault', 'no signing key issued yet');

    const unsealed = await withTenant(tenant.id, (tx) =>
      getSecret(tx, provider, secretName),
    );
    // The VALUE is never returned or logged -- only whether it came back.
    if (unsealed === null) {
      return fail('vault', 'a signing key names a secret the vault does not hold');
    }
    return pass('vault', 'the master key unseals stored secrets');
  } catch (cause) {
    return fail('vault', `secrets could not be unsealed: ${reason(cause)}`);
  }
}

/**
 * The console was actually built.
 *
 * A release that shipped without `apps/web/dist`, or an update whose bundle
 * step failed, leaves an API answering every route perfectly and a browser
 * getting nothing. `/health` is 200 throughout. This is the probe that catches
 * the update nobody notices until they open the page.
 */
function probeWeb(webRoot: string | undefined): Probe {
  if (!webRoot) return skip('web', 'no console is configured for this process');
  if (!existsSync(join(webRoot, 'index.html'))) {
    return fail('web', 'the console bundle is missing from the configured web root');
  }
  return pass('web', 'the console bundle is present');
}

/**
 * Every probe runs even when an earlier one has already failed. Short-circuiting
 * would report one cause at a time, and an operator restoring a broken update
 * at three in the morning should learn everything that is wrong in one look
 * rather than one restart at a time.
 */
export async function readiness(deps: ReadinessDeps): Promise<ReadinessReport> {
  const ms = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probes = [
    await withTimeout('database', ms, probeDatabase),
    await withTimeout('migrations', ms, probeMigrations),
    await withTimeout('vault', ms, () => probeVault(deps.provider)),
    probeWeb(deps.webRoot),
  ];

  return {
    ready: probes.every((probe) => probe.status !== 'fail'),
    version: deps.version,
    probes,
  };
}

/**
 * The same verdict, with the causes removed.
 *
 * `/health/ready` is unauthenticated on purpose: the updater holds no session
 * and cannot obtain one while the thing it is checking is broken, and the
 * automatic rollback hangs on the status code. The comment on that route used
 * to say it "discloses nothing a caller could not learn by trying to sign in".
 * That was true of the status code and false of the body -- with Postgres
 * down, `reason()` put Prisma's own message on the wire, which names the host
 * and port it could not reach.
 *
 * So: the status code and the failing probe's NAME go out, because §6 wants
 * the failing probe named and "the database" is not a disclosure. The cause
 * goes to the journal, where the operator restoring a broken update at three
 * in the morning is already looking.
 */
export function redactReport(report: ReadinessReport): ReadinessReport {
  return {
    ...report,
    probes: report.probes.map((probe) =>
      probe.status === 'fail' ? { ...probe, detail: 'this check did not pass' } : probe,
    ),
  };
}
